import { useEffect, useState } from "react";
import { predictMatchup } from "../services/predictionEngine.js";
import { getFullGamePrediction } from "../services/gamePredictionService.js";
import { findOddsForGame, getNflOdds } from "../services/oddsApi.js";
import { getStandings, getQbRosterHealth, getKickerStats, getTeamForm, getOpponentNetwork, getPlayByPlayMetrics } from "../services/nflApi.js";
import {
  savePredictionSnapshot,
  refreshPredictionLedger,
  findPredictionSnapshot,
  isCurrentCompletePrediction,
  getPredictionPayload,
  CURRENT_MODEL_KEY,
  CURRENT_MODEL_VERSION,
} from "../services/predictionLedger.js";
import { getPlayerRating, getTeamPlayerRatings } from "../services/playerRatings.js";
import { getTeamQbr } from "../services/teamRatings.js";
import { classifyDataHealth, normaliseLayers, saveDataHealthSnapshot } from "../services/dataHealth.js";

async function readRosterResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Roster request failed (${response.status})`);
  }
  return body;
}

function buildPlayerMatchupLayer(awayRoster, homeRoster) {
  const awayUnits = buildUnits(awayRoster);
  const homeUnits = buildUnits(homeRoster);

  const awayPassingEdge =
    awayUnits.passingOffense - homeUnits.passDefense;
  const homePassingEdge =
    homeUnits.passingOffense - awayUnits.passDefense;
  const awayRushingEdge =
    awayUnits.rushingOffense - homeUnits.runDefense;
  const homeRushingEdge =
    homeUnits.rushingOffense - awayUnits.runDefense;

  const rawAwayPoints = clampLocal(
    awayPassingEdge * 0.045 + awayRushingEdge * 0.03,
    -3,
    3
  );
  const rawHomePoints = clampLocal(
    homePassingEdge * 0.045 + homeRushingEdge * 0.03,
    -3,
    3
  );
  const centredEdge = clampLocal((rawHomePoints - rawAwayPoints) / 2, -1.25, 1.25);
  const awayPoints = -centredEdge;
  const homePoints = centredEdge;

  const coverage = Math.min(awayUnits.coverage, homeUnits.coverage);
  if (coverage < 0.5) return undefined;

  return {
    active: Math.abs(centredEdge) >= 0.01,
    available: true,
    rosters: { away: awayRoster, home: homeRoster },
    awayPoints,
    homePoints,
    confidence: coverage,
    awayPassingMultiplier: clampLocal(1 + awayPassingEdge * 0.004, 0.88, 1.12),
    homePassingMultiplier: clampLocal(1 + homePassingEdge * 0.004, 0.88, 1.12),
    awayRushingMultiplier: clampLocal(1 + awayRushingEdge * 0.004, 0.88, 1.12),
    homeRushingMultiplier: clampLocal(1 + homeRushingEdge * 0.004, 0.88, 1.12),
    awayFieldGoalOpportunityMultiplier: clampLocal(1 - Math.max(0, awayPassingEdge + awayRushingEdge) * 0.002, 0.9, 1.08),
    homeFieldGoalOpportunityMultiplier: clampLocal(1 - Math.max(0, homePassingEdge + homeRushingEdge) * 0.002, 0.9, 1.08),
    reasons: [
      `Player-rating units matched at ${Math.round(coverage * 100)}% confidence`,
    ],
    units: { away: awayUnits, home: homeUnits },
  };
}

function currentQbPerformanceWeight(week) {
  const value = Number(week) || 1;
  if (value <= 1) return 0.15;
  if (value === 2) return 0.25;
  if (value <= 4) return 0.4;
  if (value <= 6) return 0.55;
  return 0.7;
}

function buildUnifiedQbAdjustment(roster, teamCode, personnelQb, week = 1) {
  const qbr = getTeamQbr(teamCode);
  const rosterPlayers = Object.values(roster?.groups || {}).flat();
  const activeQbs = rosterPlayers
    .filter((player) => String(player.position || "").toUpperCase() === "QB" && player.active !== false)
    .map((player) => ({ player, rating: getPlayerRating(player, teamCode)?.overall ?? null }))
    .filter((entry) => Number.isFinite(Number(entry.rating)))
    .sort((a, b) =>
      ((a.player.depthChartOrder ?? 99) - (b.player.depthChartOrder ?? 99)) ||
      (Number(b.rating) - Number(a.rating))
    );

  const current = activeQbs[0] || null;
  const baseline = getTeamPlayerRatings(teamCode)
    .filter((player) => String(player.position || "").toUpperCase() === "QB")
    .sort((a, b) => Number(b.overall) - Number(a.overall))[0] || null;

  if (!current || !baseline) {
    return {
      active: Boolean(personnelQb?.points),
      points: Number(personnelQb?.points) || 0,
      confidence: Number(personnelQb?.confidence) || 0,
      reasons: personnelQb?.reasons || [],
      source: "personnel-fallback",
    };
  }

  const currentRating = Number(current.rating);
  const baselineRating = Number(baseline.overall);
  const gap = Math.max(0, baselineRating - currentRating);
  let externalPenalty = 0;

  if (gap > 3) {
    const base = baselineRating >= 90 ? 3.25 : baselineRating >= 84 ? 2.25 : baselineRating >= 78 ? 1.25 : 0.6;
    externalPenalty = clampLocal(base + Math.max(0, gap - 8) * 0.16, 0, 6.5);
  }

  const liveWeight = currentQbPerformanceWeight(week);
  const livePoints = Number(personnelQb?.points) || 0;
  const seasonQbr = Number(qbr?.seasonQbr);
  const weeklyQbr = Number(qbr?.weeklyQbr);
  const plays = Number(qbr?.plays) || 0;
  const qbrReliability = clampLocal(plays / 120, 0.35, 1);
  const qbrPoints = qbr
    ? clampLocal(
        (((Number.isFinite(seasonQbr) ? seasonQbr : 50) - 50) / 18 * 0.7 +
          ((Number.isFinite(weeklyQbr) ? weeklyQbr : 50) - 50) / 28 * 0.3) * qbrReliability,
        -2.5,
        2.5
      )
    : 0;
  const points = clampLocal(
    -externalPenalty * (1 - liveWeight) + livePoints * liveWeight * 0.6 + qbrPoints * 0.4,
    -3.5,
    2.5
  );
  const currentName = current.player.fullName || current.player.full_name || current.player.name;
  const reasons = Math.abs(points) >= 0.05
    ? [
        `QB adjustment: ${baseline.name} ${baselineRating} OVR to ${currentName} ${currentRating} OVR, blended ${Math.round(liveWeight * 100)}% with current-season evidence; ${points.toFixed(2)} model points`,
        ...(qbr ? [`ESPN QBR: ${qbr.playerName} season ${Number.isFinite(seasonQbr) ? seasonQbr.toFixed(1) : "N/A"}, Week ${qbr.week} ${Number.isFinite(weeklyQbr) ? weeklyQbr.toFixed(1) : "N/A"}`] : []),
      ]
    : [];

  return {
    active: Math.abs(points) >= 0.05,
    points,
    confidence: clampLocal(0.9 - liveWeight * 0.15, 0.7, 0.9),
    reasons,
    source: "blended-qb-quality",
    baseline: { name: baseline.name, rating: baselineRating },
    current: { name: currentName, rating: currentRating },
    gap,
    liveWeight,
    qbr,
    qbrPoints,
  };
}

function buildUnits(roster) {
  const teamCode = roster?.team || roster?.teamCode || roster?.abbreviation;
  const players = Object.values(roster?.groups || {}).flat().map((player) => {
    const supplied = Number(player.playerRating);
    const madden = getPlayerRating(player, teamCode);
    return {
      ...player,
      playerRating: Number.isFinite(supplied) ? supplied : madden?.overall ?? null,
    };
  });
  const rated = players.filter(
    (player) => player.active !== false && Number.isFinite(Number(player.playerRating))
  );
  const starters = rated.filter((player) => player.depthChartOrder === 1);
  const pool = starters.length >= 12 ? starters : rated;

  const unit = (positions, limit, fallback = 72) => {
    const matches = pool
      .filter((player) => positions.includes(String(player.position || "").toUpperCase()))
      .sort((a, b) => (a.depthChartOrder ?? 99) - (b.depthChartOrder ?? 99))
      .slice(0, limit);
    if (!matches.length) return fallback;
    return matches.reduce((sum, player) => sum + Number(player.playerRating), 0) / matches.length;
  };

  const qb = unit(["QB"], 1);
  const rb = unit(["RB", "HB", "FB"], 2);
  const receivers = unit(["WR"], 3);
  const tightEnds = unit(["TE"], 2);
  const offensiveLine = unit(["LT", "LG", "C", "RG", "RT", "G", "OG", "T", "OT", "OL"], 5);
  const defensiveFront = unit(["DE", "DT", "DL", "NT", "EDGE", "LEDG", "REDG", "OLB"], 5);
  const linebackers = unit(["LB", "ILB", "MLB", "OLB"], 3);
  const secondary = unit(["CB", "DB", "S", "FS", "SS"], 5);

  return {
    passingOffense: qb * 0.35 + receivers * 0.25 + tightEnds * 0.1 + offensiveLine * 0.3,
    rushingOffense: rb * 0.35 + offensiveLine * 0.65,
    passDefense: defensiveFront * 0.4 + linebackers * 0.15 + secondary * 0.45,
    runDefense: defensiveFront * 0.6 + linebackers * 0.4,
    coverage: players.length ? rated.length / players.length : 0,
  };
}

function clampLocal(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}

export default function MatchupPrediction({ awayCode, homeCode, kickoff, weather, oddsEvent, week, scheduleContext, actualAwayScore = null, actualHomeScore = null }) {
  const [officialSnapshot, setOfficialSnapshot] = useState(null);
  const marketSnapshotKey = buildMarketSnapshotKey(awayCode, homeCode, kickoff);
  const [savedOddsEvent, setSavedOddsEvent] = useState(() => readMarketSnapshot(marketSnapshotKey));
  const [loadedOddsEvent, setLoadedOddsEvent] = useState(null);
  const marketEvent = oddsEvent || loadedOddsEvent || savedOddsEvent;
  const [standingsByCode, setStandingsByCode] = useState({});
  const [personnel, setPersonnel] = useState(null);
  const [kickerData, setKickerData] = useState(null);
  const [teamForm, setTeamForm] = useState(null);
  const [opponentNetwork, setOpponentNetwork] = useState(null);
  const [playByPlayData, setPlayByPlayData] = useState(null);
  const [playerMatchup, setPlayerMatchup] = useState(null);

  useEffect(() => {
    const stored = readMarketSnapshot(marketSnapshotKey);
    setSavedOddsEvent(stored);
  }, [marketSnapshotKey]);

  useEffect(() => {
    if (oddsEvent) {
      setLoadedOddsEvent(null);
      return;
    }

    const controller = new AbortController();
    getNflOdds(controller.signal)
      .then((events) => {
        const matched = findOddsForGame(events, {
          away: normalizeCode(awayCode),
          home: normalizeCode(homeCode),
          sourceDate: kickoff,
          kickoff,
        });
        setLoadedOddsEvent(matched || null);
        if (matched && marketSnapshotKey) writeMarketSnapshot(marketSnapshotKey, matched);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") console.warn("Matchup odds loading failed", error);
      });

    return () => controller.abort();
  }, [oddsEvent, awayCode, homeCode, kickoff, marketSnapshotKey]);

  useEffect(() => {
    if (!oddsEvent || !marketSnapshotKey) return;
    writeMarketSnapshot(marketSnapshotKey, oddsEvent);
    setSavedOddsEvent(oddsEvent);
  }, [marketSnapshotKey, oddsEvent]);

  useEffect(() => {
    if (!awayCode || !homeCode) return;
    const controller = new AbortController();
    const season = kickoff ? new Date(kickoff).getUTCFullYear() : new Date().getUTCFullYear();
    getQbRosterHealth(normalizeCode(awayCode), normalizeCode(homeCode), season, controller.signal)
      .then(setPersonnel)
      .catch(() => setPersonnel(null));
    return () => controller.abort();
  }, [awayCode, homeCode, kickoff]);

  useEffect(() => {
    if (!awayCode || !homeCode) return;
    const controller = new AbortController();
    const currentSeason = kickoff ? new Date(kickoff).getUTCFullYear() : new Date().getUTCFullYear();
    getKickerStats(normalizeCode(awayCode), normalizeCode(homeCode), currentSeason - 1, controller.signal)
      .then(setKickerData)
      .catch(() => setKickerData(null));
    return () => controller.abort();
  }, [awayCode, homeCode, kickoff]);

  useEffect(() => {
    if (!awayCode || !homeCode || !week) return;
    const controller = new AbortController();
    const season = kickoff ? new Date(kickoff).getUTCFullYear() : new Date().getUTCFullYear();
    getTeamForm(
      normalizeCode(awayCode),
      normalizeCode(homeCode),
      season,
      Number(week),
      controller.signal
    )
      .then(setTeamForm)
      .catch(() => setTeamForm(null));
    return () => controller.abort();
  }, [awayCode, homeCode, kickoff, week]);

  useEffect(() => {
    if (!awayCode || !homeCode || Number(week) <= 1) {
      setOpponentNetwork(null);
      return undefined;
    }

    const controller = new AbortController();
    const season = kickoff
      ? new Date(kickoff).getUTCFullYear()
      : new Date().getUTCFullYear();

    getOpponentNetwork(
      normalizeCode(awayCode),
      normalizeCode(homeCode),
      season,
      Number(week),
      controller.signal
    )
      .then(setOpponentNetwork)
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("Opponent network failed", error);
          setOpponentNetwork(null);
        }
      });

    return () => controller.abort();
  }, [awayCode, homeCode, kickoff, week]);

  useEffect(() => {
    if (!awayCode || !homeCode || Number(week) <= 1) {
      setPlayByPlayData(null);
      return undefined;
    }
    const controller = new AbortController();
    const season = kickoff ? new Date(kickoff).getUTCFullYear() : new Date().getUTCFullYear();
    getPlayByPlayMetrics(normalizeCode(awayCode), normalizeCode(homeCode), season, Number(week), controller.signal)
      .then(setPlayByPlayData)
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("Play-by-play analytics failed", error);
          setPlayByPlayData(null);
        }
      });
    return () => controller.abort();
  }, [awayCode, homeCode, kickoff, week]);

  useEffect(() => {
    if (!awayCode || !homeCode) return undefined;
    const controller = new AbortController();
    let active = true;
    async function loadOfficialPrediction() {
      try {
        const sharedRows = await refreshPredictionLedger({ signal: controller.signal });
        const saved = findPredictionSnapshot(sharedRows, Number(week) || 0, awayCode, homeCode);
        const kickoffTime = new Date(kickoff || 0).getTime();
        const started = Number.isFinite(kickoffTime) && kickoffTime > 0 && Date.now() >= kickoffTime;
        if (saved && (started || isCurrentCompletePrediction(saved))) {
          if (active) setOfficialSnapshot(saved);
          return;
        }
        if (started) {
          if (active && saved) setOfficialSnapshot(saved);
          return;
        }
        const full = await getFullGamePrediction(
          { away: normalizeCode(awayCode), home: normalizeCode(homeCode), week: Number(week) || 1, sourceDate: kickoff, weather, scheduleContext },
          marketEvent,
          { season: kickoff ? new Date(kickoff).getUTCFullYear() : 2026, week: Number(week) || 1, signal: controller.signal }
        );
        const generated = createOfficialSnapshot(full, { awayCode: normalizeCode(awayCode), homeCode: normalizeCode(homeCode), week: Number(week) || 1, kickoff });
        savePredictionSnapshot(generated);
        if (active) setOfficialSnapshot(generated);
      } catch (error) {
        if (error?.name !== "AbortError") console.error("Official prediction loading failed", error);
      }
    }
    loadOfficialPrediction();
    return () => { active = false; controller.abort(); };
  }, [awayCode, homeCode, kickoff, week, marketEvent, weather, scheduleContext]);

  useEffect(() => {
    if (!awayCode || !homeCode) {
      setPlayerMatchup(null);
      return undefined;
    }

    const controller = new AbortController();

    Promise.all([
      fetch(`/api/nfl/sleeper-players?team=${encodeURIComponent(normalizeCode(awayCode))}`, {
        signal: controller.signal,
      }).then(readRosterResponse),
      fetch(`/api/nfl/sleeper-players?team=${encodeURIComponent(normalizeCode(homeCode))}`, {
        signal: controller.signal,
      }).then(readRosterResponse),
    ])
      .then(([awayRoster, homeRoster]) => {
        setPlayerMatchup(buildPlayerMatchupLayer(awayRoster, homeRoster));
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("Player ratings matchup failed", error);
          setPlayerMatchup(null);
        }
      });

    return () => controller.abort();
  }, [awayCode, homeCode]);

  useEffect(() => {
    const controller = new AbortController();
    getStandings(controller.signal)
      .then((rows) => {
        const map = {};
        for (const row of rows) {
          const code = normalizeCode(row?.abbreviation);
          if (code) map[code] = row;
        }
        setStandingsByCode(map);
      })
      .catch(() => setStandingsByCode({}));
    return () => controller.abort();
  }, []);

  if (!awayCode || !homeCode) {
    return <div className="team-statistics-empty matchup-split-panel">Projection will appear once both teams are set.</div>;
  }

  const homeStanding = standingsByCode[normalizeCode(homeCode)];
  const awayStanding = standingsByCode[normalizeCode(awayCode)];
  const kickerImpact = calculateKickerImpact(kickerData, weather);
  const awayQbAdjustment = buildUnifiedQbAdjustment(
    playerMatchup?.rosters?.away,
    awayCode,
    personnel?.away?.quarterback,
    week
  );
  const homeQbAdjustment = buildUnifiedQbAdjustment(
    playerMatchup?.rosters?.home,
    homeCode,
    personnel?.home?.quarterback,
    week
  );
  const localPrediction = predictMatchup(awayCode, homeCode, {
    kickoff,
    weather,
    market: marketEvent,
    week,
    homeSplit: homeStanding ? { home: homeStanding.home, road: homeStanding.road } : undefined,
    awaySplit: awayStanding ? { home: awayStanding.home, road: awayStanding.road } : undefined,
    scheduleContext,
    modelLayers: {
      ...(teamForm?.modelLayers || {}),
      ...(playByPlayData?.modelLayers || {}),
      playerRatings: playerMatchup || undefined,
      opponentNetwork: opponentNetwork?.modelLayer || undefined,
      quarterback: {
        active: awayQbAdjustment.active || homeQbAdjustment.active,
        awayPoints: awayQbAdjustment.points,
        homePoints: homeQbAdjustment.points,
        confidence: Math.min(
          awayQbAdjustment.confidence || 0,
          homeQbAdjustment.confidence || 0
        ),
        reasons: [
          ...awayQbAdjustment.reasons,
          ...homeQbAdjustment.reasons,
        ],
      },
      rosterHealth: {
        active: Boolean(
          personnel?.away?.rosterHealth?.points ||
          personnel?.home?.rosterHealth?.points
        ),
        awayPoints: personnel?.away?.rosterHealth?.points || 0,
        homePoints: personnel?.home?.rosterHealth?.points || 0,
        confidence: Math.max(
          Math.min(
            personnel?.away?.rosterHealth?.confidence || 0,
            personnel?.home?.rosterHealth?.confidence || 0
          )
        ),
        reasons: [
          ...(personnel?.away?.rosterHealth?.reasons || []),
          ...(personnel?.home?.rosterHealth?.reasons || []),
        ],
      },
      specialTeams: {
        active: Boolean(kickerImpact.awayPoints || kickerImpact.homePoints),
        awayPoints: kickerImpact.awayPoints,
        homePoints: kickerImpact.homePoints,
        confidence: kickerData ? 0.7 : 0,
        reasons: kickerData ? ["Kicker accuracy, range and weather-adjusted field-goal opportunity"] : [],
      },
    },
    rivalry: scheduleContext
      ? {
          meetingNumber: scheduleContext.meetingNumber,
          previousMargin: scheduleContext.previousMeetingMargin,
        }
      : undefined,
  });

  const officialPayload = getPredictionPayload(officialSnapshot);
  const prediction = officialPayload
    ? applyOfficialSnapshot(officialPayload, officialSnapshot)
    : localPrediction;
  const { away, home, winner, margin, confidence, total } = prediction;
  const rows = [
    ["Passing TDs", away.passingTD, home.passingTD],
    ["Rushing TDs", away.rushingTD, home.rushingTD],
    ["Defensive TDs (Pick 6)", away.defensiveTD, home.defensiveTD],
    ["Field goals", away.fieldGoals, home.fieldGoals],
    ["Extra points", away.extraPoints, home.extraPoints],
    ["2-pt conversions", away.twoPoint, home.twoPoint],
  ];
  const winnerLabel = winner === null ? "Projected tie" : `${winner} by ${margin}`;
  const impact = prediction.weather;
  const scheduleImpact = prediction.schedule;
  const rivalryImpact = prediction.rivalry;
  const explanation = buildPredictionExplanation(prediction, week, playByPlayData);
  const comparison = buildOddsComparison(prediction);
  const hasActual =
    actualAwayScore !== null && actualAwayScore !== undefined && actualAwayScore !== "" &&
    actualHomeScore !== null && actualHomeScore !== undefined && actualHomeScore !== "" &&
    Number.isFinite(Number(actualAwayScore)) && Number.isFinite(Number(actualHomeScore));
  const actualTotal = hasActual ? Number(actualAwayScore) + Number(actualHomeScore) : null;

  useEffect(() => {
    if (!away?.code || !home?.code) return;

    const kickoffDate = kickoff ? new Date(kickoff) : null;
    const validKickoff = kickoffDate && !Number.isNaN(kickoffDate.getTime());
    const beforeKickoff = validKickoff && Date.now() < kickoffDate.getTime();
    const id = `${Number(week) || 0}:${away.code}:${home.code}:${validKickoff ? kickoffDate.toISOString() : "unknown"}`;
    const fourthDownPick = winner || null;
    const oddsPick = comparison.available
      ? comparison.marketAway > comparison.marketHome
        ? away.code
        : comparison.marketHome > comparison.marketAway
          ? home.code
          : null
      : null;
    const actualWinner = hasActual
      ? Number(actualAwayScore) > Number(actualHomeScore)
        ? away.code
        : Number(actualHomeScore) > Number(actualAwayScore)
          ? home.code
          : "TIE"
      : null;

    savePredictionSnapshot({
      id,
      source: "matchup-full-model",
      modelVersion: CURRENT_MODEL_VERSION,
      modelKey: CURRENT_MODEL_KEY,
      predictionPayload: prediction,
      dataQuality: officialSnapshot?.dataQuality || { source: "matchup-shared-model" },
      week: Number(week) || 0,
      kickoff: validKickoff ? kickoffDate.toISOString() : null,
      awayCode: away.code,
      homeCode: home.code,
      fourthDownPick,
      fourthDownAwayScore: away.score,
      fourthDownHomeScore: home.score,
      oddsPick,
      marketAwayScore: comparison.available ? comparison.marketAway : null,
      marketHomeScore: comparison.available ? comparison.marketHome : null,
      fourthDownAwayWinProbability: prediction.awayWinProbability,
      fourthDownHomeWinProbability: prediction.homeWinProbability,
      fourthDownWinnerProbability: prediction.winnerWinProbability,
      confidenceScore: prediction.confidenceScore,
      confidenceLabel: prediction.confidence,
      savedBeforeKickoff: beforeKickoff,
      actualAwayScore: hasActual ? Number(actualAwayScore) : null,
      actualHomeScore: hasActual ? Number(actualHomeScore) : null,
      actualWinner,
      fourthDownCorrect: actualWinner && fourthDownPick ? actualWinner === fourthDownPick : null,
      oddsCorrect: actualWinner && oddsPick ? actualWinner === oddsPick : null,
      gradedAt: actualWinner ? new Date().toISOString() : null,
    });
  }, [away.code, home.code, away.score, home.score, winner, week, kickoff, comparison.available, comparison.marketAway, comparison.marketHome, hasActual, actualAwayScore, actualHomeScore, prediction.awayWinProbability, prediction.homeWinProbability, prediction.winnerWinProbability, prediction.confidenceScore, prediction.confidence, playerMatchup, personnel, teamForm, playByPlayData, opponentNetwork]);
  useEffect(() => {
    if (!away?.code || !home?.code || !prediction?.modelLayers) return;

    const layerEntries = normaliseLayers(prediction.modelLayers);

    const sources = {
      teamForm: { available: Boolean(teamForm), label: "Team form", detail: teamForm ? "Loaded" : "Unavailable or neutral" },
      personnel: { available: Boolean(personnel), label: "QB and roster health", detail: personnel ? "Loaded" : "Unavailable" },
      playByPlay: { available: playByPlayData?.dataStatus === "available", label: "nflverse play-by-play", detail: playByPlayData?.dataStatus || "Unavailable" },
      playerRatings: {
        available: Boolean(playerMatchup?.available),
        label: "Player ratings",
        detail: playerMatchup ? "Loaded and centred as a matchup edge" : "Unavailable",
      },
      opponentNetwork: { available: Boolean(opponentNetwork), label: "Opponent network", detail: opponentNetwork ? "Loaded" : "Unavailable" },
      kicker: { available: Boolean(kickerData), label: "Kicker data", detail: kickerData ? "Loaded" : "Unavailable" },
      market: { available: Boolean(marketEvent), label: "Betting market", detail: marketEvent ? "Loaded or cached" : "Unavailable" },
      weather: { available: Boolean(weather), label: "Weather", detail: weather ? "Loaded" : "Unavailable" },
    };

    const classification = classifyDataHealth(prediction.modelLayers, {
      teamForm: Boolean(teamForm),
      personnel: Boolean(personnel),
      playByPlay: playByPlayData?.dataStatus === "available",
      market: Boolean(marketEvent),
    });

    saveDataHealthSnapshot({
      id: `${Number(week) || 0}:${away.code}:${home.code}:${kickoff || "unknown"}`,
      week: Number(week) || 0,
      kickoff,
      awayCode: away.code,
      homeCode: home.code,
      healthStatus: classification.status,
      activeLayerCount: classification.activeCount,
      layers: layerEntries,
      sources,
      warnings: classification.warnings,
      playCount: Math.min(finiteNumber(playByPlayData?.away?.offensivePlays), finiteNumber(playByPlayData?.home?.offensivePlays)),
      gameSample: Math.min(finiteNumber(playByPlayData?.away?.games), finiteNumber(playByPlayData?.home?.games)),
      playByPlayGeneratedAt: playByPlayData?.generatedAt || playByPlayData?.refreshedAt || null,
      auditVersion: 3,
      auditNote: "fourth-down data health snapshot",
    });
  }, [away.code, home.code, week, kickoff, prediction.modelLayers, teamForm, personnel, playByPlayData, playerMatchup, opponentNetwork, kickerData, marketEvent, weather]);

  const comparisonCard = (
    <section className="card prediction-comparison-card">
      <div className="team-statistics-heading">
        <div>
          <span className="eyebrow">MARKET COMPARISON</span>
          <h3>Odds makers vs Fourth Down{hasActual ? " vs Actual" : ""}</h3>
        </div>
      </div>

      {comparison.available ? (
        <>
          <div className="team-statistics-table matchup-stats-table prediction-table">
            <div className="team-statistics-row team-statistics-header">
              <strong>Projection</strong>
              <span>Odds makers</span>
              <strong>Fourth Down</strong>
              {hasActual && <strong>Actual</strong>}
            </div>
            <div className="team-statistics-row matchup-stat-row">
              <strong>{away.code}</strong>
              <span>{formatProjectionNumber(comparison.marketAway)}</span>
              <strong>{away.score}</strong>
              {hasActual && <strong>{actualAwayScore}</strong>}
            </div>
            <div className="team-statistics-row matchup-stat-row">
              <strong>{home.code}</strong>
              <span>{formatProjectionNumber(comparison.marketHome)}</span>
              <strong>{home.score}</strong>
              {hasActual && <strong>{actualHomeScore}</strong>}
            </div>
            <div className="team-statistics-row matchup-stat-row">
              <strong>Total</strong>
              <span>{formatProjectionNumber(comparison.marketTotal)}</span>
              <strong>{total}</strong>
              {hasActual && <strong>{actualTotal}</strong>}
            </div>
          </div>
          <p className="prediction-conditions">
            {hasActual ? buildActualComparisonSummary(comparison, prediction, Number(actualAwayScore), Number(actualHomeScore)) : comparison.summary}
          </p>
        </>
      ) : (
        <p className="prediction-note">
          Odds-maker projection unavailable. Fourth Down&apos;s independent prediction is still shown above.
        </p>
      )}
    </section>
  );

  return (
    <div className="matchup-prediction team-statistics matchup-team-statistics">
      <div className="team-statistics-heading">
        <div><span className="eyebrow">MODEL PROJECTION</span><h3>Predicted result</h3></div>
        <span className="prediction-confidence">{confidence}</span>
      </div>

      <div className="prediction-scoreline">
        <div className="prediction-score prediction-score-away"><small>{away.code}</small><strong>{away.score}</strong></div>
        <div className="prediction-score-divider"><small>PROJECTED</small><span>-</span></div>
        <div className="prediction-score prediction-score-home"><small>{home.code}</small><strong>{home.score}</strong></div>
      </div>

      <div className="prediction-summary">
        <span>{winnerLabel}</span>
        <span>{winner ? `${winner} win probability ${Math.round(prediction.winnerWinProbability * 100)}%` : "Win probability 50% each"}</span>
        <span>Projected total {total}</span>
      </div>

      <div className="team-statistics-table matchup-stats-table prediction-table">
        <div className="team-statistics-row team-statistics-header"><strong>{away.code}</strong><span>Scoring</span><strong>{home.code}</strong></div>
        {rows.map(([label, awayValue, homeValue]) => (
          <div className="team-statistics-row matchup-stat-row" key={label}><strong>{awayValue}</strong><span>{label}</span><strong>{homeValue}</strong></div>
        ))}
      </div>

      <section className="card prediction-explanation-card">
        <span className="eyebrow">WHY THIS PREDICTION?</span>
        <h3>{explanation.heading}</h3>
        <p>{explanation.summary}</p>

        <h4>Biggest factors</h4>
        <ul className="prediction-explanation-list">
          {explanation.keyFactors.map((factor) => (
            <li key={`${factor.code || "matchup"}-${factor.label}`}>
              <strong>{factor.icon} {factor.code ? `${factor.code}: ` : ""}{factor.label}:</strong> {factor.detail}
            </li>
          ))}
        </ul>

        <div
          className="prediction-team-outlooks"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
            marginTop: "20px",
          }}
        >
          {explanation.teamOutlooks.map((outlook) => (
            <div className="card prediction-team-outlook" key={outlook.code} style={{ padding: "18px" }}>
              <h4>{outlook.code}</h4>
              <strong>Positives</strong>
              <ul className="prediction-explanation-list">
                {outlook.positives.map((item) => (
                  <li key={`${outlook.code}-positive-${item}`}>✓ {item}</li>
                ))}
              </ul>
              <strong>Concerns</strong>
              <ul className="prediction-explanation-list prediction-risk-list">
                {outlook.concerns.map((item) => (
                  <li key={`${outlook.code}-concern-${item}`}>⚠ {item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="prediction-confidence-block">
          <div>
            <small>CONFIDENCE</small>
            <strong>{explanation.confidence.label}</strong>
          </div>
          <strong>{explanation.confidence.percent}%</strong>
          <div
            role="progressbar"
            aria-label="Prediction confidence"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={explanation.confidence.percent}
            style={{ height: "8px", borderRadius: "999px", overflow: "hidden", background: "rgba(148, 163, 184, 0.22)" }}
          >
            <span style={{ display: "block", width: `${explanation.confidence.percent}%`, height: "100%", background: "var(--accent, #22c55e)" }} />
          </div>
        </div>

        <h4>What could prove Fourth Down wrong?</h4>
        <ul className="prediction-explanation-list prediction-risk-list">
          {explanation.riskFactors.map((factor) => (
            <li key={factor}>⚠ {factor}</li>
          ))}
        </ul>

        <details className="prediction-model-details">
          <summary>Model details</summary>
          <ul className="prediction-explanation-list">
            {explanation.modelDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          <p className="prediction-note">{explanation.dataNote}</p>
        </details>
      </section>

      <AdvancedAnalyticsCard
        data={playByPlayData}
        awayCode={away.code}
        homeCode={home.code}
        modelLayers={prediction.modelLayers}
      />

      {!hasActual && comparisonCard}

      {impact?.active && (
        <p className="prediction-conditions">
          Weather impact: {impact.severity} · coefficient {impact.coefficient.toFixed(3)}
          {impact.conditions.length ? ` · ${impact.conditions.join(" + ")}` : ""}
        </p>
      )}
      {scheduleImpact?.active && (
        <p className="prediction-conditions">
          Schedule impact: {scheduleImpact.summary}
        </p>
      )}
      {rivalryImpact?.active && (
        <p className="prediction-conditions">
          Rivalry impact: {rivalryImpact.description} · meeting {rivalryImpact.meetingNumber}
          {` · margin compressed ${rivalryImpact.marginCompressionPoints.toFixed(1)} points`}
        </p>
      )}

      <p className="prediction-note">
        Projection uses team ratings, venue-specific home-field advantage, in-season home/road form, divisional familiarity, rest differential, schedule fatigue and component-level game-window weather effects. QB performance and roster availability use live advanced passing and Sleeper depth-chart data. Turnover regression, efficiency and scheme layers remain neutral until their live data is connected.
      </p>

      {hasActual && comparisonCard}
    </div>
  );
}

function createOfficialSnapshot(full, context) {
  const p = full.prediction;
  const marketAway = finiteOrNull(p.market?.awayExpected);
  const marketHome = finiteOrNull(p.market?.homeExpected);
  const kickoffTime = new Date(context.kickoff || 0).getTime();
  return {
    id: `${context.week}:${context.awayCode}:${context.homeCode}:${context.kickoff || "unknown"}`,
    source: "shared-full-model",
    modelVersion: CURRENT_MODEL_VERSION,
    modelKey: CURRENT_MODEL_KEY,
    week: context.week,
    kickoff: context.kickoff,
    awayCode: context.awayCode,
    homeCode: context.homeCode,
    fourthDownPick: p.winner,
    fourthDownAwayScore: p.away.score,
    fourthDownHomeScore: p.home.score,
    fourthDownAwayWinProbability: p.awayWinProbability,
    fourthDownHomeWinProbability: p.homeWinProbability,
    fourthDownWinnerProbability: p.winnerWinProbability,
    oddsPick: marketAway === null || marketHome === null ? null : marketAway > marketHome ? context.awayCode : marketHome > marketAway ? context.homeCode : null,
    marketAwayScore: marketAway,
    marketHomeScore: marketHome,
    marketGameTotal: finiteOrNull(p.market?.total),
    marketSpread: finiteOrNull(p.market?.homeSpread),
    predictionPayload: p,
    playerProjections: full.playerProjections || null,
    dataQuality: {
      ...full.dataQuality,
      modelVersion: CURRENT_MODEL_VERSION,
      modelKey: CURRENT_MODEL_KEY,
      predictionPayload: p,
    },
    generatedAt: full.generatedAt || new Date().toISOString(),
    snapshotAt: new Date().toISOString(),
    savedBeforeKickoff: Number.isFinite(kickoffTime) && Date.now() < kickoffTime,
  };
}

function applyOfficialSnapshot(payload, snapshot) {
  const awayScore = Number(snapshot.fourthDownAwayScore);
  const homeScore = Number(snapshot.fourthDownHomeScore);
  return {
    ...payload,
    away: { ...payload.away, score: awayScore },
    home: { ...payload.home, score: homeScore },
    winner: snapshot.fourthDownPick,
    margin: Math.abs(awayScore - homeScore),
    total: awayScore + homeScore,
    awayWinProbability: Number(snapshot.fourthDownAwayWinProbability),
    homeWinProbability: Number(snapshot.fourthDownHomeWinProbability),
    winnerWinProbability: Number(snapshot.fourthDownWinnerProbability),
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function AdvancedAnalyticsCard({ data, awayCode, homeCode, modelLayers }) {
  if (!data) {
    return (
      <section className="card prediction-comparison-card">
        <span className="eyebrow">ADVANCED ANALYTICS</span>
        <h3>nflverse play-by-play</h3>
        <p className="prediction-note">Advanced analytics are loading or unavailable.</p>
      </section>
    );
  }

  if (data.dataStatus !== "available") {
    return (
      <section className="card prediction-comparison-card">
        <span className="eyebrow">ADVANCED ANALYTICS</span>
        <h3>nflverse play-by-play</h3>
        <p className="prediction-note">{data.reason || "No current-season play-by-play metrics are available."}</p>
      </section>
    );
  }

  const away = data.away || {};
  const home = data.home || {};
  const rows = [
    ["EPA / play", formatMetric(away.epaPerPlay, 3), formatMetric(home.epaPerPlay, 3)],
    ["Defensive EPA allowed", formatMetric(away.defensiveEpaPerPlay, 3), formatMetric(home.defensiveEpaPerPlay, 3)],
    ["Success rate", formatPercent(away.successRate), formatPercent(home.successRate)],
    ["Passing EPA / play", formatMetric(away.passingEpaPerPlay, 3), formatMetric(home.passingEpaPerPlay, 3)],
    ["Rushing EPA / play", formatMetric(away.rushingEpaPerPlay, 3), formatMetric(home.rushingEpaPerPlay, 3)],
    ["Early-down EPA", formatMetric(away.earlyDownEpaPerPlay, 3), formatMetric(home.earlyDownEpaPerPlay, 3)],
    ["Explosive play rate", formatPercent(away.explosivePlayRate), formatPercent(home.explosivePlayRate)],
    ["Pressure allowed", formatPercent(away.pressureAllowedRate), formatPercent(home.pressureAllowedRate)],
    ["Third-down rate", formatPercent(away.thirdDownRate), formatPercent(home.thirdDownRate)],
    ["Red-zone TD rate", formatPercent(away.redZoneTouchdownRate), formatPercent(home.redZoneTouchdownRate)],
    ["Scoring drive rate", formatPercent(away.scoringDriveRate), formatPercent(home.scoringDriveRate)],
    ["Three-and-out rate", formatPercent(away.threeAndOutRate), formatPercent(home.threeAndOutRate)],
  ];
  const layerNames=["playByPlayEfficiency","successRate","earlyDownEpa","explosivePlays","driveEfficiency","situationalEfficiency","passProtection"];
  const awayAdjustment=layerNames.reduce((sum,name)=>sum+finiteNumber(modelLayers?.[name]?.awayPoints),0);
  const homeAdjustment=layerNames.reduce((sum,name)=>sum+finiteNumber(modelLayers?.[name]?.homePoints),0);

  return (
    <section className="card prediction-comparison-card advanced-analytics-card">
      <div className="team-statistics-heading advanced-analytics-heading">
        <div><span className="eyebrow">ADVANCED ANALYTICS</span><h3>nflverse play-by-play</h3></div>
        <span className="count-pill">{away.games || 0} game sample</span>
      </div>
      <div className="advanced-analytics-table-scroll">
        <div className="team-statistics-table matchup-stats-table advanced-analytics-table">
          <div className="team-statistics-row team-statistics-header"><strong>{awayCode}</strong><span>Metric</span><strong>{homeCode}</strong></div>
          {rows.map(([label,awayValue,homeValue])=>(
            <div className="team-statistics-row matchup-stat-row" key={label}><strong>{awayValue}</strong><span>{label}</span><strong>{homeValue}</strong></div>
          ))}
          <div className="team-statistics-row matchup-stat-row"><strong>{formatSignedLocal(awayAdjustment)}</strong><span>Score adjustment</span><strong>{formatSignedLocal(homeAdjustment)}</strong></div>
        </div>
      </div>
      <p className="prediction-note">Week {data.week} confidence: {Math.round(finiteNumber(modelLayers?.playByPlayEfficiency?.confidence) * 100)}%. Garbage-time filter: {data.garbageTimeFilter}.</p>
    </section>
  );
}

function formatPercent(value) { return `${(finiteNumber(value) * 100).toFixed(1)}%`; }
function formatMetric(value, digits = 2) { return finiteNumber(value).toFixed(digits); }

function buildPredictionExplanation(prediction, week, playByPlayData) {
  const { away, home, winner, margin, homeField, market, rivalry, schedule, weather, modelLayers, formBlend } = prediction;
  const winnerCode = winner || null;
  const loserCode = winnerCode === away.code ? home.code : away.code;
  const edges = [];
  const modelDetails = [];

  const addEdge = (label, detail, awayPoints, homePoints, icon = "✓") => {
    const difference = finiteNumber(homePoints) - finiteNumber(awayPoints);
    if (Math.abs(difference) < 0.05) return;
    edges.push({ label, detail, code: difference > 0 ? home.code : away.code, strength: Math.abs(difference), icon });
  };

  addEdge("Quarterback situation", "The active quarterback and availability data create an advantage in this matchup.", modelLayers?.quarterback?.awayPoints, modelLayers?.quarterback?.homePoints);
  addEdge("Player matchups", "The availability-adjusted player ratings produce the stronger overall unit matchup.", modelLayers?.playerRatings?.awayPoints, modelLayers?.playerRatings?.homePoints);
  addEdge("Roster health", "The expected active lineup is healthier at the positions that matter most.", modelLayers?.rosterHealth?.awayPoints, modelLayers?.rosterHealth?.homePoints);
  addEdge("Recent efficiency", "EPA, success rate and early-down performance point to the more efficient team.",
    finiteNumber(modelLayers?.playByPlayEfficiency?.awayPoints) + finiteNumber(modelLayers?.successRate?.awayPoints) + finiteNumber(modelLayers?.earlyDownEpa?.awayPoints),
    finiteNumber(modelLayers?.playByPlayEfficiency?.homePoints) + finiteNumber(modelLayers?.successRate?.homePoints) + finiteNumber(modelLayers?.earlyDownEpa?.homePoints));
  addEdge("Pass protection", "The pressure and sack matchup provides a clearer path to keeping the offence on schedule.", modelLayers?.passProtection?.awayPoints, modelLayers?.passProtection?.homePoints);
  addEdge("Finishing drives", "Recent drive, third-down and red-zone results provide the stronger scoring outlook.",
    finiteNumber(modelLayers?.driveEfficiency?.awayPoints) + finiteNumber(modelLayers?.situationalEfficiency?.awayPoints) + finiteNumber(modelLayers?.redZone?.awayPoints),
    finiteNumber(modelLayers?.driveEfficiency?.homePoints) + finiteNumber(modelLayers?.situationalEfficiency?.homePoints) + finiteNumber(modelLayers?.redZone?.homePoints));
  addEdge("Explosive plays", "The recent play-by-play profile shows a better chance of creating chunk gains.", modelLayers?.explosivePlays?.awayPoints, modelLayers?.explosivePlays?.homePoints);
  addEdge("Opponent comparison", "Results against shared and connected opponents favour this side.", modelLayers?.opponentNetwork?.awayPoints, modelLayers?.opponentNetwork?.homePoints);
  addEdge("Special teams", "Kicker range, accuracy and conditions create a small advantage.", modelLayers?.specialTeams?.awayPoints, modelLayers?.specialTeams?.homePoints);

  if (homeField && Math.abs(finiteNumber(homeField.total)) >= 0.1) {
    edges.push({ label: "Home-field advantage", detail: "Playing at home provides a meaningful edge in this matchup.", code: home.code, strength: Math.abs(finiteNumber(homeField.total)), icon: "✓" });
    modelDetails.push(`${home.code} receives ${formatSignedLocal(homeField.total)} points from home field.`);
  }
  if (formBlend?.active) modelDetails.push(`Current-season performance carries ${Math.round(finiteNumber(formBlend.weight) * 100)}% of the team-form blend.`);
  if (market?.active) modelDetails.push(`The betting market carries ${Math.round(finiteNumber(market.effectiveWeight) * 100)}% of the calibrated scoring expectation.`);
  if (schedule?.active) modelDetails.push(`Schedule context: ${schedule.summary}.`);
  if (rivalry?.active) modelDetails.push(`${rivalry.description} reduces the projected margin by ${finiteNumber(rivalry.marginCompressionPoints).toFixed(1)} points.`);
  if (weather?.active) modelDetails.push(`Weather is rated ${String(weather.severity || "active").toLowerCase()} and affects passing, rushing and kicking.`);

  const sortedEdges = edges.sort((first, second) => second.strength - first.strength);
  const winnerEdges = winnerCode ? sortedEdges.filter((edge) => edge.code === winnerCode) : sortedEdges;
  const opponentEdges = winnerCode ? sortedEdges.filter((edge) => edge.code === loserCode) : [];
  const keyFactors = winnerEdges.slice(0, 4);

  if (!keyFactors.length) {
    keyFactors.push({ label: "Balanced matchup", detail: "The active inputs are closely matched, so the projected edge is small.", icon: "✓" });
  }

  const riskFactors = opponentEdges.slice(0, 3).map((edge) => `${edge.code} could swing the game through ${edge.label.toLowerCase()}.`);
  if (market?.active && winnerCode && market.marketWinner && market.marketWinner !== winnerCode) riskFactors.push(`The betting market is leaning toward ${market.marketWinner}.`);
  if (weather?.active) riskFactors.push("Conditions could make the game more volatile than the baseline projection.");
  if (finiteNumber(margin) <= 3) riskFactors.push("The projected margin is small enough for one turnover or special-teams play to decide the game.");
  if (!riskFactors.length) riskFactors.push(`${loserCode || "The opponent"} can still win by creating turnovers and finishing more drives.`);

  const confidencePercent = calculateHumanConfidence(prediction, winnerEdges, opponentEdges);
  const confidenceLabel = confidencePercent >= 72 ? "High" : confidencePercent >= 58 ? "Medium" : "Low";
  const leadReasons = keyFactors.slice(0, 3).map((factor) => factor.label.toLowerCase());
  const reasonsText = joinHumanList(leadReasons);
  const heading = winnerCode ? `Why Fourth Down is picking ${winnerCode}` : `Why Fourth Down sees this as a toss-up`;
  const summary = winnerCode
    ? `${winnerCode} has the edge because of ${reasonsText || "a small collection of matchup advantages"}. ${finiteNumber(margin) <= 3 ? `Fourth Down expects a close game, with ${winnerCode} only narrowly ahead.` : `Those advantages are enough for Fourth Down to project ${winnerCode} by ${margin}.`} ${opponentEdges.length ? `${loserCode} still has a realistic path if its strongest matchup advantages translate on game day.` : `${loserCode} will likely need to win the turnover battle or outperform its recent efficiency.`}`
    : `${away.code} and ${home.code} are separated by very little across the active inputs. Fourth Down does not see a strong enough advantage to call either side clearly superior.`;

  const teamOutlooks = [
    buildStatBasedTeamOutlook(away.code, playByPlayData?.away),
    buildStatBasedTeamOutlook(home.code, playByPlayData?.home),
  ];

  const dataNote = Number(week) <= 1
    ? "No current-season sample is available yet, so the projection leans more heavily on team ratings, player availability, venue, weather and the market."
    : "Current-season results are blended conservatively with the preseason baseline so one unusual game cannot dominate the prediction.";

  return {
    heading,
    summary,
    keyFactors,
    teamOutlooks,
    riskFactors: [...new Set(riskFactors)].slice(0, 4),
    confidence: { label: confidenceLabel, percent: confidencePercent },
    modelDetails: modelDetails.length ? modelDetails : ["No major technical adjustment is dominating this matchup."],
    dataNote,
  };
}

function buildStatBasedTeamOutlook(code, metrics) {
  if (!metrics || !Number(metrics.games)) {
    return {
      code,
      positives: ["No completed-game sample is available yet."],
      concerns: ["There is not enough current-season data to identify a reliable concern."],
    };
  }

  const positives = [];
  const concerns = [];
  const pct = (value) => `${(finiteNumber(value) * 100).toFixed(1)}%`;
  const signed = (value) => `${finiteNumber(value) >= 0 ? "+" : ""}${finiteNumber(value).toFixed(3)}`;

  if (finiteNumber(metrics.epaPerPlay) >= 0.08) {
    positives.push(`The offence has produced ${signed(metrics.epaPerPlay)} EPA per play.`);
  } else if (finiteNumber(metrics.epaPerPlay) <= -0.08) {
    concerns.push(`The offence has produced ${signed(metrics.epaPerPlay)} EPA per play.`);
  }

  if (finiteNumber(metrics.passingEpaPerPlay) >= 0.1) {
    positives.push(`The passing game is generating ${signed(metrics.passingEpaPerPlay)} EPA per dropback.`);
  } else if (finiteNumber(metrics.passingEpaPerPlay) <= -0.1) {
    concerns.push(`The passing game is at ${signed(metrics.passingEpaPerPlay)} EPA per dropback.`);
  }

  if (finiteNumber(metrics.rushingEpaPerPlay) >= 0.03) {
    positives.push(`The rushing attack is producing ${signed(metrics.rushingEpaPerPlay)} EPA per carry.`);
  } else if (finiteNumber(metrics.rushingEpaPerPlay) <= -0.08) {
    concerns.push(`The rushing attack is producing ${signed(metrics.rushingEpaPerPlay)} EPA per carry.`);
  }

  if (finiteNumber(metrics.successRate) >= 0.46) {
    positives.push(`The offence is staying on schedule with a ${pct(metrics.successRate)} success rate.`);
  } else if (finiteNumber(metrics.successRate) > 0 && finiteNumber(metrics.successRate) <= 0.39) {
    concerns.push(`The offence has managed only a ${pct(metrics.successRate)} success rate.`);
  }

  if (finiteNumber(metrics.sacksGenerated) >= 4 || finiteNumber(metrics.sackRateGenerated) >= 0.08) {
    positives.push(`The defence has major sack potential after recording ${Math.round(finiteNumber(metrics.sacksGenerated))} sack${Number(metrics.sacksGenerated) === 1 ? "" : "s"}, a ${pct(metrics.sackRateGenerated)} sack rate.`);
  }

  if (finiteNumber(metrics.pressureGeneratedRate) >= 0.18) {
    positives.push(`The defence generated pressure on ${pct(metrics.pressureGeneratedRate)} of opponent dropbacks.`);
  }

  if (finiteNumber(metrics.sacksAllowed) >= 4 || finiteNumber(metrics.sackRateAllowed) >= 0.09) {
    concerns.push(`Pass protection allowed ${Math.round(finiteNumber(metrics.sacksAllowed))} sack${Number(metrics.sacksAllowed) === 1 ? "" : "s"}, a ${pct(metrics.sackRateAllowed)} sack rate.`);
  }

  if (finiteNumber(metrics.explosivePlayRate) >= 0.1) {
    positives.push(`The offence created explosive gains on ${pct(metrics.explosivePlayRate)} of plays.`);
  }

  if (metrics.longestReception?.player && finiteNumber(metrics.longestReception?.yards) > 0) {
    positives.push(`${metrics.longestReception.player} is a downfield threat, with a longest completed catch of ${Math.round(metrics.longestReception.yards)} yards.`);
  }

  if (metrics.leadingReceiver?.player && finiteNumber(metrics.leadingReceiver?.yards) > 0) {
    positives.push(`${metrics.leadingReceiver.player} leads the passing game with ${Math.round(metrics.leadingReceiver.yards)} receiving yards in the available sample.`);
  }

  if (metrics.longestRush?.player && finiteNumber(metrics.longestRush?.yards) >= 10) {
    positives.push(`${metrics.longestRush.player} produced the team's longest run at ${Math.round(metrics.longestRush.yards)} yards.`);
  }

  if (finiteNumber(metrics.thirdDownRate) >= 0.45) {
    positives.push(`The offence converted ${pct(metrics.thirdDownRate)} of third downs.`);
  } else if (finiteNumber(metrics.thirdDownRate) > 0 && finiteNumber(metrics.thirdDownRate) <= 0.32) {
    concerns.push(`Third-down conversion is only ${pct(metrics.thirdDownRate)}.`);
  }

  if (finiteNumber(metrics.redZoneTouchdownRate) >= 0.25) {
    positives.push(`The offence scored touchdowns on ${pct(metrics.redZoneTouchdownRate)} of the recorded red-zone plays.`);
  }

  if (finiteNumber(metrics.scoringDriveRate) >= 0.4) {
    positives.push(`The team scored on ${pct(metrics.scoringDriveRate)} of drives.`);
  } else if (finiteNumber(metrics.scoringDriveRate) > 0 && finiteNumber(metrics.scoringDriveRate) <= 0.25) {
    concerns.push(`Only ${pct(metrics.scoringDriveRate)} of drives ended in points.`);
  }

  if (finiteNumber(metrics.threeAndOutRate) >= 0.3) {
    concerns.push(`${pct(metrics.threeAndOutRate)} of drives ended in a three-and-out.`);
  }

  if (finiteNumber(metrics.defensiveEpaPerPlay) <= -0.05) {
    positives.push(`The defence has held opponents to ${signed(metrics.defensiveEpaPerPlay)} EPA per play.`);
  } else if (finiteNumber(metrics.defensiveEpaPerPlay) >= 0.08) {
    concerns.push(`The defence has allowed ${signed(metrics.defensiveEpaPerPlay)} EPA per play.`);
  }

  return {
    code,
    positives: [...new Set(positives)].slice(0, 5),
    concerns: [...new Set(concerns)].slice(0, 5),
  };
}

function calculateHumanConfidence(prediction, winnerEdges, opponentEdges) {
  const margin = Math.abs(finiteNumber(prediction.margin));
  const supportingStrength = winnerEdges.reduce((total, edge) => total + edge.strength, 0);
  const opposingStrength = opponentEdges.reduce((total, edge) => total + edge.strength, 0);
  const marketSupport = prediction.market?.active ? 3 : 0;
  return Math.round(Math.max(50, Math.min(88, 50 + margin * 3 + supportingStrength * 2 - opposingStrength + marketSupport)));
}

function joinHumanList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function buildMarketSnapshotKey(awayCode, homeCode, kickoff) {
  const away = normalizeCode(awayCode);
  const home = normalizeCode(homeCode);
  const date = kickoff ? String(kickoff).slice(0, 10) : "unknown";
  return away && home ? `fourth-down:market:${date}:${away}:${home}` : null;
}

function readMarketSnapshot(key) {
  if (!key || typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeMarketSnapshot(key, oddsEvent) {
  if (!key || !oddsEvent || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(oddsEvent));
  } catch {
    // The live market still works if browser storage is unavailable.
  }
}

function buildActualComparisonSummary(comparison, prediction, actualAway, actualHome) {
  const actualTotal = actualAway + actualHome;
  const marketScoreError = Math.abs(comparison.marketAway - actualAway) + Math.abs(comparison.marketHome - actualHome);
  const fourthDownScoreError = Math.abs(prediction.away.score - actualAway) + Math.abs(prediction.home.score - actualHome);
  const marketTotalError = Math.abs(comparison.marketTotal - actualTotal);
  const fourthDownTotalError = Math.abs(prediction.total - actualTotal);
  const closer = fourthDownScoreError < marketScoreError
    ? "Fourth Down was closer to the actual team scores."
    : marketScoreError < fourthDownScoreError
      ? "The odds makers were closer to the actual team scores."
      : "Fourth Down and the odds makers were equally close to the actual team scores.";
  return `${closer} Fourth Down missed the actual total by ${fourthDownTotalError.toFixed(1)} points, compared with ${marketTotalError.toFixed(1)} points for the market.`;
}

function buildOddsComparison(prediction) {
  const market = prediction.market;
  if (
    !market?.active ||
    !Number.isFinite(Number(market.awayExpected)) ||
    !Number.isFinite(Number(market.homeExpected)) ||
    !Number.isFinite(Number(market.total))
  ) {
    return { available: false };
  }

  const marketAway = Number(market.awayExpected);
  const marketHome = Number(market.homeExpected);
  const marketTotal = Number(market.total);
  const fourthDownTotal = prediction.total;
  const totalDifference = fourthDownTotal - marketTotal;
  const awayDifference = prediction.away.score - marketAway;
  const homeDifference = prediction.home.score - marketHome;

  const totalDescription = Math.abs(totalDifference) < 0.25
    ? "the same total points as the market"
    : `${Math.abs(totalDifference).toFixed(1)} ${totalDifference > 0 ? "more" : "fewer"} total points than the market`;

  const strongestTeamDifference = Math.abs(awayDifference) >= Math.abs(homeDifference)
    ? { code: prediction.away.code, value: awayDifference }
    : { code: prediction.home.code, value: homeDifference };

  const teamDescription = Math.abs(strongestTeamDifference.value) < 0.25
    ? "The team-level projections are also closely aligned."
    : `The largest team difference is ${strongestTeamDifference.code}, which Fourth Down projects ${Math.abs(strongestTeamDifference.value).toFixed(1)} points ${strongestTeamDifference.value > 0 ? "higher" : "lower"}.`;

  return {
    available: true,
    marketAway,
    marketHome,
    marketTotal,
    summary: `Fourth Down projects ${totalDescription}. ${teamDescription}`,
  };
}

function formatProjectionNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatSignedLocal(value) {
  const number = finiteNumber(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}`;
}

const KICK_DISTANCE_MIX = {
  under30: 0.18,
  from30to39: 0.29,
  from40to49: 0.31,
  from50plus: 0.22,
};

function calculateKickerImpact(data, weather) {
  if (!data?.leaguePriors) return { awayPoints: 0, homePoints: 0 };

  return {
    awayPoints: calculateTeamKickerPoints(data.away, data.leaguePriors, weather),
    homePoints: calculateTeamKickerPoints(data.home, data.leaguePriors, weather),
  };
}

function calculateTeamKickerPoints(kicker, priors, weather) {
  if (!kicker) return 0;

  let kickerExpectedAccuracy = 0;
  let leagueExpectedAccuracy = 0;

  for (const [bucket, share] of Object.entries(KICK_DISTANCE_MIX)) {
    const prior = priors[bucket];
    if (!prior) continue;

    const actual = kicker[bucket] || { made: 0, attempts: 0 };
    const made = finiteNumber(actual.made);
    const attempts = finiteNumber(actual.attempts);
    const leagueAccuracy = finiteNumber(prior.accuracy);
    const priorAttempts = finiteNumber(prior.priorAttempts);
    const regressedAccuracy =
      (made + leagueAccuracy * priorAttempts) /
      Math.max(1, attempts + priorAttempts);

    kickerExpectedAccuracy +=
      share * applyKickingWeather(regressedAccuracy, bucket, weather);
    leagueExpectedAccuracy +=
      share * applyKickingWeather(leagueAccuracy, bucket, weather);
  }

  const pointDifference =
    (kickerExpectedAccuracy - leagueExpectedAccuracy) * 2.1 * 3;

  return roundThree(clamp(pointDifference, -1.25, 1.25));
}

function applyKickingWeather(baseAccuracy, bucket, weather) {
  if (!weather || weather.dome) return baseAccuracy;

  const windKmh = finiteNumber(weather.windSpeed);
  const gustKmh = Math.max(windKmh, finiteNumber(weather.windGust));
  const rainMm = Math.max(0, finiteNumber(weather.rain ?? weather.precipitation));
  const snowCm = Math.max(0, finiteNumber(weather.snowfall));
  const distanceExposure = {
    under30: 0.15,
    from30to39: 0.4,
    from40to49: 0.72,
    from50plus: 1,
  }[bucket] ?? 0.5;

  const windLoad = clamp((windKmh - 16) / 32, 0, 1);
  const gustLoad = clamp((gustKmh - 28) / 35, 0, 1);
  const rainLoad = clamp(rainMm / 8, 0, 1);
  const snowLoad = clamp(snowCm / 4, 0, 1);
  const penalty =
    distanceExposure * (0.11 * windLoad + 0.055 * gustLoad) +
    0.025 * rainLoad +
    0.05 * snowLoad +
    distanceExposure *
      (0.035 * windLoad * rainLoad + 0.05 * windLoad * snowLoad);

  return clamp(baseAccuracy * (1 - penalty), 0.05, 0.995);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundThree(value) {
  return Math.round(value * 1000) / 1000;
}

