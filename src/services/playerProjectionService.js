import { validDepthRoster } from "../../api-lib/depthCharts.js";
import { validatePlayerMetrics } from "../../api-lib/playerMetrics.js";
import { buildPersonnelView, canonicalTeam } from "../../api-lib/personnelView.js";

const MIN_ROLE_OPPORTUNITIES = 3;

export function buildPlayerProjections({
  away,
  home,
  prediction,
  playerMetrics,
  personnelViews,
  teamMetrics,
  season,
  week,
  cutoff,
}) {
  const context = { season, week, cutoff };
  const provenanceError = validatePlayerMetrics({ ...playerMetrics, away: null, home: null }, context);
  if (provenanceError || !prediction) {
    return {
      available: false,
      away: null,
      home: null,
      reasons: [provenanceError || "Team prediction unavailable"],
    };
  }

  const reasons = [];
  const result = { available: false, generatedAt: new Date().toISOString(), away: null, home: null, reasons };
  for (const [side, teamCode, opponentCode] of [["away", away, home], ["home", home, away]]) {
    const metrics = playerMetrics[side];
    const lineup = teamMetrics?.[side]?.expectedLineup;
    const invalid = validatePlayerMetrics({ ...playerMetrics, [side === "away" ? "home" : "away"]: null }, context);
    if (invalid || !metrics || metrics.team !== teamCode ||
        !validDepthRoster(lineup, week, season) || lineup.cutoff !== cutoff) {
      reasons.push(`${teamCode}: ${invalid || "Verified weekly player roles unavailable"}`);
      continue;
    }
    const personnelView = personnelViews?.[side] ||
      buildPersonnelView({ team: teamCode, lineup, cutoff, season, week });
    if (canonicalTeam(personnelView?.team || teamCode) !== canonicalTeam(teamCode)) {
      reasons.push(`${teamCode}: personnel view belongs to a different team`);
      continue;
    }
    result[side] = projectTeam({ teamCode, opponentCode, side, prediction, metrics, teamMetrics, lineup, personnelView });
    reasons.push(...result[side].reasons.map((reason) => `${teamCode}: ${reason}`));
  }
  result.available = [result.away, result.home].some((team) => team?.players.length > 0);
  return result;
}

function projectTeam({ teamCode, opponentCode, side, prediction, metrics, teamMetrics, lineup, personnelView }) {
  const teamProjection = prediction?.[side] || {};
  const opponentSide = side === "away" ? "home" : "away";
  const opponentProjection = prediction?.[opponentSide] || {};
  const reasons = [];
  if (![teamProjection.expectedPossessions, teamProjection.score, teamProjection.passingTD,
    teamProjection.rushingTD, opponentProjection.score].every(finite)) {
    return { team: teamCode, opponent: opponentCode, players: [], reasons: ["Required team opportunity inputs unavailable"] };
  }
  const roles = new Map();
  const conflicting = new Set();
  for (const role of personnelView?.players || []) {
    if (canonicalTeam(role.team) !== canonicalTeam(teamCode) ||
        !role.canonicalId || !role.group || !Number.isInteger(role.rank) || role.rank < 1 ||
        typeof role.projectedAvailable !== "boolean" || typeof role.statusKnown !== "boolean" ||
        !role.eligibleBeforeCutoff || role.identityConflict || role.sourceConflict) continue;
    if (roles.has(role.canonicalId)) conflicting.add(role.canonicalId);
    roles.set(role.canonicalId, role);
  }
  const starter = personnelView?.quarterback?.player;
  const starterId = personnelView?.quarterback?.resolved ? starter?.canonicalId || null : null;
  const players = Object.values(metrics?.players || {}).filter((player) => {
    const role = roles.get(player.gsisId);
    return role && !conflicting.has(player.gsisId) && role.projectedAvailable &&
      canonicalTeam(player.team) === teamCode &&
      ["QB", "RB", "WR", "TE"].includes(role.group) &&
      (role.group !== "QB" || player.gsisId === starterId);
  }).map((player) => ({
    ...player,
    position: roles.get(player.gsisId).group,
    personnel: {
      status: roles.get(player.gsisId).status,
      statusKnown: roles.get(player.gsisId).statusKnown,
      eligible: roles.get(player.gsisId).propEligible,
      reason: roles.get(player.gsisId).exclusionReason,
      replacementFor: roles.get(player.gsisId).replacementFor,
      confidence: roles.get(player.gsisId).confidence,
    },
    opportunityFactor: roles.get(player.gsisId).opportunityFactor,
  }));
  const excludedPlayers = Object.keys(metrics.players || {}).length - players.length;
  if (excludedPlayers) reasons.push(`${excludedPlayers} historical players excluded without a supported current role/availability`);
  const quarterback = players.find((player) => player.gsisId === starterId && passingProfile(player)) || null;
  if (!quarterback) reasons.push("No verified starting QB with an eligible passing profile; named passing projection omitted");
  if (players.some((player) => !roles.get(player.gsisId).statusKnown)) {
    reasons.push("Depth source does not establish player health; availability remains unknown");
  }
  const totals = metrics?.teamTotals || {};
  const games = Math.max(1, Number(metrics?.games || totals?.games) || 1);

  const expectedPossessions = clamp(
    number(teamProjection.expectedPossessions, 10.8),
    7,
    16
  );
  const mix = teamProjection.expectedPlayMix;
  const expectedPlays = mix?.available ? mix.expectedPlays : clamp(expectedPossessions * 6.05, 48, 82);
  const historicalPassRate = rate(
    number(totals.passAttempts) + number(totals.sacksAllowed),
    number(totals.passAttempts) + number(totals.sacksAllowed) + number(totals.rushingAttempts),
    0.58
  );
  const scoreEdge = number(teamProjection.score) - number(opponentProjection.score);
  const scriptShift = clamp(-scoreEdge * 0.0025, -0.045, 0.045);
  const passRate = mix?.available ? mix.passRate : clamp(historicalPassRate + scriptShift, 0.42, 0.72);
  const expectedDropbacks = expectedPlays * passRate;
  const historicalSackRate = rate(
    quarterback ? quarterback.passing.sacksTaken : number(totals.sacksAllowed),
    quarterback ? quarterback.passing.attempts + quarterback.passing.sacksTaken :
      number(totals.passAttempts) + number(totals.sacksAllowed),
    0.065
  );
  const opponentPressure = getOpponentMetric(
    teamMetrics,
    opponentCode,
    "pressureGeneratedRate",
    historicalSackRate
  );
  const sackRate = clamp(historicalSackRate * 0.65 + opponentPressure * 0.35, 0.025, 0.14);
  const passAttempts = Math.max(1, expectedDropbacks * (1 - sackRate));
  const rushAttempts = Math.max(1, expectedPlays - expectedDropbacks);

  // Aggregate team context can support receivers without inventing a named QB.
  const passingSample = quarterback?.passing || {
    attempts: totals.passAttempts, completions: totals.completions, yards: totals.passingYards,
  };
  const hasPassingSample = positive(passingSample.attempts) &&
    nonnegative(passingSample.completions) && finite(passingSample.yards);
  const historicalYpa = hasPassingSample
    ? clamp(passingSample.yards / passingSample.attempts, 4.5, 10) : null;
  const opponentPassAllowed = getOpponentMetric(
    teamMetrics,
    opponentCode,
    "passingEpaAllowedPerPlay",
    0
  );
  const passMatchupMultiplier = clamp(1 + opponentPassAllowed * 0.16, 0.85, 1.18);
  const passingYards = hasPassingSample ? passAttempts * historicalYpa * passMatchupMultiplier : null;
  const completionRate = hasPassingSample
    ? clamp(passingSample.completions / passingSample.attempts, 0.48, 0.78) : null;

  const receivingPlayers = players.filter(
    (player) => hasPassingSample && receivingProfile(player)
  );
  const rushingPlayers = players.filter(
    (player) => rushingProfile(player)
  );
  if (players.some((player) => (player.receiving?.targets >= MIN_ROLE_OPPORTUNITIES && !receivingProfile(player)) ||
      (player.rushing?.attempts >= MIN_ROLE_OPPORTUNITIES && !rushingProfile(player)))) {
    reasons.push("Unsupported individual statistical inputs excluded from opportunity allocation");
  }

  const passingTouchdowns = Math.max(0, number(teamProjection.passingTD));
  const rushingTouchdowns = Math.max(0, number(teamProjection.rushingTD));

  const receiverRows = allocateReceivers({
    receivingPlayers,
    passAttempts,
    passingYards,
    passingTouchdowns,
    totals,
    games,
  });

  const rusherRows = allocateRushers({
    rushingPlayers,
    rushAttempts,
    rushingTouchdowns,
    totals,
    teamMetrics,
    opponentCode,
    games,
  });

  capRoundedOpportunities(receiverRows, "targets", passAttempts);
  capRoundedOpportunities(rusherRows, "rushingAttempts", rushAttempts);
  const combined = mergeCombined(receiverRows, rusherRows);
  const playerIndex = new Map(players.map((player) => [player.playerId, player]));

  const projectedPlayers = [...combined.values()]
    .map((projection) => {
      const source = playerIndex.get(projection.playerId) || {};
      const expectedTouchdowns =
        number(projection.receivingTouchdowns) +
        number(projection.rushingTouchdowns) +
        (source.playerId === quarterback?.playerId ? number(projection.quarterbackRushingTouchdowns) : 0);
      const roleConfidence = effectiveRoleConfidence(source, Math.min(games, source.games));

      return {
        ...projection,
        team: teamCode,
        personnelId: source.gsisId,
        personnel: source.personnel,
        playerNameKey: normalizePlayerName(projection.playerName),
        anytimeTouchdownProbability: round4(1 - Math.exp(-expectedTouchdowns)),
        roleConfidence,
        dataQuality: round4(clamp((Math.min(games, 4) / 4) * 0.55 + roleConfidence * 0.45, 0.25, 0.95)),
      };
    })
    .filter((player) => player.roleConfidence >= 0.35)
    .sort((a, b) => number(b.opportunities) - number(a.opportunities));

  if (quarterback) {
    const qbProjection = {
      playerId: quarterback.playerId,
      team: teamCode,
      personnelId: quarterback.gsisId,
      personnel: quarterback.personnel,
      playerName: quarterback.playerName,
      playerNameKey: normalizePlayerName(quarterback.playerName),
      team: teamCode,
      position: "QB",
      passingAttempts: round1(passAttempts),
      completions: round1(passAttempts * completionRate),
      passingYards: round1(passingYards),
      passingTouchdowns: round2(passingTouchdowns),
      rushingAttempts: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingAttempts")),
      rushingYards: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingYards")),
      rushingTouchdowns: round2(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingTouchdowns")),
      receptions: 0,
      receivingYards: 0,
      receivingTouchdowns: 0,
      rushingReceivingYards: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingYards")),
      opportunities: round1(passAttempts + findProjectedValue(projectedPlayers, quarterback.playerId, "rushingAttempts")),
      roleConfidence: effectiveRoleConfidence(quarterback, Math.min(games, quarterback.games)),
      profile: {
        playerId: quarterback.playerId, games: quarterback.games, weeks: quarterback.weeks,
        passing: numericProfile(quarterback.passing), rushing: numericProfile(quarterback.rushing),
      },
    };
    qbProjection.anytimeTouchdownProbability = round4(
      1 - Math.exp(-number(qbProjection.rushingTouchdowns))
    );
    qbProjection.dataQuality = round4(
      clamp((Math.min(games, 4) / 4) * 0.55 + qbProjection.roleConfidence * 0.45, 0.25, 0.95)
    );
    const existingIndex = projectedPlayers.findIndex((player) => player.playerId === quarterback.playerId);
    if (existingIndex >= 0) projectedPlayers[existingIndex] = { ...projectedPlayers[existingIndex], ...qbProjection };
    else projectedPlayers.unshift(qbProjection);
  }

  const projectedTargets = projectedPlayers.reduce((sum, player) => sum + number(player.targets), 0);
  const projectedCarries = projectedPlayers.reduce((sum, player) => sum + number(player.rushingAttempts), 0);
  return {
    team: teamCode,
    opponent: opponentCode,
    gamesUsed: number(metrics?.games || totals?.games),
    expectedPlays: round1(expectedPlays),
    expectedPossessions: round2(expectedPossessions),
    passRate: round4(passRate),
    passAttempts: round1(passAttempts),
    rushAttempts: round1(rushAttempts),
    unallocatedTargets: round1(Math.max(0, passAttempts - projectedTargets)),
    unallocatedCarries: round1(Math.max(0, rushAttempts - projectedCarries)),
    ...(hasPassingSample ? { passingYards: round1(passingYards) } : {}),
    startingQuarterback: quarterback?.playerId || null,
    availabilityKnown: players.every((player) => roles.get(player.gsisId).statusKnown),
    reasons,
    players: projectedPlayers,
  };
}

function allocateReceivers({ receivingPlayers, passAttempts, passingYards, passingTouchdowns, totals, games }) {
  if (!receivingPlayers.length) return [];
  const weightedShares = receivingPlayers.map((player) => {
    const seasonShare = number(player?.receiving?.targetShare);
    const recentTargets = player?.recent?.targetsPerGame;
    const recentShare = finite(recentTargets)
      ? recentTargets / Math.max(1, number(totals.targets) / games)
      : seasonShare;
    return clamp(seasonShare * 0.7 + recentShare * 0.3, 0.01, 0.6);
  });
  const shares = allocateLimitedShares(weightedShares, 0.6);
  const rawYards = receivingPlayers.map((player, index) => {
    const targetShare = shares[index];
    const targets = passAttempts * targetShare * clamp(number(player.opportunityFactor, 1), 0, 1);
    const catchRate = clamp(number(player?.receiving?.catchRate, 0.65), 0.35, 0.9);
    const yardsPerTarget = clamp(number(player?.receiving?.yardsPerTarget, 7), 3.5, 14);
    return { player, targetShare, targets, receptions: targets * catchRate, yards: targets * yardsPerTarget };
  });
  const rawTotal = rawYards.reduce((sum, row) => sum + row.yards, 0) || 1;
  const redZoneWeights = receivingPlayers.map((player, index) => {
    const rz = number(player?.receiving?.redZoneTargetShare);
    const ez = number(player?.receiving?.endZoneTargetShare);
    return Math.max(0.01, (rz * 0.65 + ez * 0.35 + weightedShares[index] * 0.25) *
      clamp(number(player.opportunityFactor, 1), 0, 1));
  });
  const tdWeightTotal = redZoneWeights.reduce((sum, value) => sum + value, 0) || 1;

  return rawYards.map((row, index) => ({
    playerId: row.player.playerId,
    playerName: row.player.playerName,
    team: row.player.team,
    position: row.player.position,
    targets: round1(row.targets),
    receptions: round1(row.receptions),
    receivingYards: round1(row.yards * (passingYards / rawTotal)),
    receivingTouchdowns: round3(passingTouchdowns * redZoneWeights[index] / tdWeightTotal),
    opportunities: round1(row.targets),
  }));
}

function allocateRushers({ rushingPlayers, rushAttempts, rushingTouchdowns, totals, teamMetrics, opponentCode, games }) {
  if (!rushingPlayers.length) return [];
  const shares = rushingPlayers.map((player) => {
    const seasonShare = number(player?.rushing?.carryShare);
    const recentAttempts = player?.recent?.rushingAttemptsPerGame;
    const recentShare = finite(recentAttempts)
      ? recentAttempts / Math.max(1, number(totals.rushingAttempts) / games)
      : seasonShare;
    return clamp(seasonShare * 0.7 + recentShare * 0.3, 0.01, 0.8);
  });
  const allocatedShares = allocateLimitedShares(shares, 0.8);
  const opponentRushAllowed = getOpponentMetric(teamMetrics, opponentCode, "rushingEpaAllowedPerPlay", 0);
  const matchupMultiplier = clamp(1 + opponentRushAllowed * 0.18, 0.83, 1.2);
  const goalLineWeights = rushingPlayers.map((player, index) =>
    Math.max(
      0.01,
      number(player?.rushing?.goalLineCarryShare) * 0.65 +
      number(player?.rushing?.redZoneCarryShare) * 0.25 +
      shares[index] * 0.1
    ) * clamp(number(player.opportunityFactor, 1), 0, 1)
  );
  const tdWeightTotal = goalLineWeights.reduce((sum, value) => sum + value, 0) || 1;

  return rushingPlayers.map((player, index) => {
    const share = allocatedShares[index] * clamp(number(player.opportunityFactor, 1), 0, 1);
    const attempts = rushAttempts * share;
    const ypc = clamp(number(player?.rushing?.yardsPerCarry, 4.1), 2.4, 7.5);
    return {
      playerId: player.playerId,
      playerName: player.playerName,
      team: player.team,
      position: player.position,
      rushingAttempts: round1(attempts),
      rushingYards: round1(attempts * ypc * matchupMultiplier),
      rushingTouchdowns: round3(rushingTouchdowns * goalLineWeights[index] / tdWeightTotal),
      opportunities: round1(attempts),
    };
  });
}

function allocateLimitedShares(weights, cap) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return weights.map(() => 0);
  const shares = weights.map((weight) => weight / total);
  let remaining = 1;
  let eligible = shares.map((_, index) => index);
  while (eligible.length) {
    const eligibleTotal = eligible.reduce((sum, index) => sum + shares[index], 0);
    const capped = eligible.filter((index) => shares[index] / eligibleTotal * remaining > cap);
    if (!capped.length) {
      for (const index of eligible) shares[index] = shares[index] / eligibleTotal * remaining;
      break;
    }
    for (const index of capped) {
      shares[index] = cap;
      remaining -= cap;
    }
    eligible = eligible.filter((index) => !capped.includes(index));
    if (remaining <= 0) break;
  }
  return shares;
}

function capRoundedOpportunities(rows, field, volume) {
  const budget = Math.floor((volume + 1e-9) * 10) / 10;
  const allocated = rows.reduce((sum, row) => sum + number(row[field]), 0);
  let excess = Math.round((allocated - budget) * 10) / 10;
  for (let index = rows.length - 1; index >= 0 && excess > 0; index -= 1) {
    const previous = number(rows[index][field]);
    const reduction = Math.min(previous, excess);
    rows[index][field] = round1(previous - reduction);
    const ratio = previous > 0 ? rows[index][field] / previous : 0;
    if (field === "targets") {
      rows[index].receptions = round1(number(rows[index].receptions) * ratio);
      rows[index].receivingYards = round1(number(rows[index].receivingYards) * ratio);
    } else {
      rows[index].rushingYards = round1(number(rows[index].rushingYards) * ratio);
    }
    rows[index].opportunities = rows[index][field];
    excess = Math.round((excess - reduction) * 10) / 10;
  }
}

function mergeCombined(receivers, rushers) {
  const map = new Map();
  for (const row of [...receivers, ...rushers]) {
    const existing = map.get(row.playerId) || {
      playerId: row.playerId,
      playerName: row.playerName,
      team: row.team,
      position: row.position,
      targets: 0,
      receptions: 0,
      receivingYards: 0,
      receivingTouchdowns: 0,
      rushingAttempts: 0,
      rushingYards: 0,
      rushingTouchdowns: 0,
      opportunities: 0,
    };
    map.set(row.playerId, {
      ...existing,
      ...row,
      targets: number(existing.targets) + number(row.targets),
      receptions: number(existing.receptions) + number(row.receptions),
      receivingYards: number(existing.receivingYards) + number(row.receivingYards),
      receivingTouchdowns: number(existing.receivingTouchdowns) + number(row.receivingTouchdowns),
      rushingAttempts: number(existing.rushingAttempts) + number(row.rushingAttempts),
      rushingYards: number(existing.rushingYards) + number(row.rushingYards),
      rushingTouchdowns: number(existing.rushingTouchdowns) + number(row.rushingTouchdowns),
      rushingReceivingYards: round1(
        number(existing.receivingYards) + number(row.receivingYards) +
        number(existing.rushingYards) + number(row.rushingYards)
      ),
      opportunities: number(existing.opportunities) + number(row.opportunities),
    });
  }
  return map;
}

function calculateRoleConfidence(player, games) {
  const opportunityShare = Math.max(
    number(player?.combined?.opportunityShare),
    number(player?.rushing?.carryShare),
    number(player?.receiving?.targetShare)
  );
  const volumeConfidence = clamp(opportunityShare / 0.35, 0, 1);
  const sampleConfidence = clamp(games / 4, 0.35, 1);
  return round4(volumeConfidence * 0.7 + sampleConfidence * 0.3);
}

function effectiveRoleConfidence(player, games) {
  return round4(calculateRoleConfidence(player, games) *
    clamp(number(player?.opportunityFactor, 1), 0, 1));
}

function getOpponentMetric(teamMetrics, opponentCode, field, fallback) {
  const direct = [teamMetrics?.away, teamMetrics?.home]
    .find((entry) => String(entry?.team || "").toUpperCase() === String(opponentCode || "").toUpperCase());
  const payload = teamMetrics?.raw || teamMetrics;
  const teams = payload?.teams || payload?.metrics || payload?.data?.teams || {};
  const value = direct?.[field] ?? teams?.[opponentCode]?.[field];
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const positive = (value) => finite(value) && value > 0;
const numericProfile = (profile) => Object.fromEntries(Object.entries(profile || {}).filter(([, value]) => finite(value)));
function passingProfile(player) {
  return positive(player.passing?.attempts) && finite(player.passing?.yards) &&
    nonnegative(player.passing?.completions) && nonnegative(player.passing?.sacksTaken);
}
function receivingProfile(player) {
  const profile = player.receiving;
  return profile?.targets >= MIN_ROLE_OPPORTUNITIES &&
    ["targets", "catchRate", "yardsPerTarget", "targetShare", "redZoneTargetShare", "endZoneTargetShare"]
      .every((key) => nonnegative(profile[key]));
}
function rushingProfile(player) {
  const profile = player.rushing;
  return profile?.attempts >= MIN_ROLE_OPPORTUNITIES &&
    ["attempts", "carryShare", "redZoneCarryShare", "goalLineCarryShare"].every((key) => nonnegative(profile[key])) &&
    finite(profile.yardsPerCarry);
}

function findProjectedValue(players, playerId, field) {
  const row = players.find((player) => player.playerId === playerId);
  return number(row?.[field]);
}

function normalizePlayerName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function rate(numerator, denominator, fallback = 0) {
  return denominator ? numerator / denominator : fallback;
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round1(value) {
  return Math.round(number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function round3(value) {
  return Math.round(number(value) * 1000) / 1000;
}

function round4(value) {
  return Math.round(number(value) * 10000) / 10000;
}
