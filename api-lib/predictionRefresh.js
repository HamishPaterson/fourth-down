import process from "node:process";
import { fetchSchedule } from "../scripts/balldontlie-schedule.mjs";
import { createSnapshotClient } from "./oddsSnapshots.js";
import { secureBearerMatches, getLockCycle } from "./weeklyMulti.js";
import { buildWeeklyLockPlan, saveWeeklyLockPlan } from "./weeklyLockAudit.js";
import { lockPredictionRejections } from "./weeklyLockProvenance.js";
import { createServerPredictionGenerator, readPredictionOdds, saveAuthoritativePrediction } from "./serverPredictions.js";
import { databaseToSnapshot } from "../api/nfl/game-stats.js";
import { getCurrentWeekWindow } from "../api/nfl/odds.js";
import { loadWeeklyOpponentNetwork, validateWeeklyOpponentNetwork, NFL_TEAMS } from "../api/nfl/opponent-network.js";
import { completePrediction } from "./predictionEligibility.js";
import { predictionFeatureStatus, PREDICTION_FEATURE_VERSION } from "../src/services/predictionFeatures.js";
import { playerTeam } from "./playerMetrics.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";

const finiteTree = (value) => typeof value === "number" ? Number.isFinite(value)
  : !value || typeof value !== "object" || Object.values(value).every(finiteTree);
const identity = (game) => `${game.away}:${game.home}`;

export function predictionRefreshContext(sourceGames, now) {
  const season = dataset.season;
  const { week } = getCurrentWeekWindow(now.getTime());
  const selected = new Map(), teams = new Set(), scheduleIds = new Map();
  for (const game of sourceGames) {
    const type = String(game.season_type || game.game_type || "").toUpperCase();
    if (Number(game.season) !== season || Number(game.week) !== week ||
        [true, 1, "true", "1"].includes(game.postseason) ||
        (type && !["REG", "REGULAR", "REGULAR SEASON", "2"].includes(type))) continue;
    const away = playerTeam(game.visitor_team?.abbreviation), home = playerTeam(game.home_team?.abbreviation);
    if (!NFL_TEAMS.includes(away) || !NFL_TEAMS.includes(home) || away === home || !Number.isFinite(Date.parse(game.date))) {
      throw new Error("Invalid prediction refresh schedule game");
    }
    const id = String(game.id ?? "");
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error("Missing or malformed canonical schedule ID");
    }
    const entry = { id, season, week, away, home, sourceDate: game.date,
      venue: game.venue, scheduleContext: game.scheduleContext };
    const sameId = sourceGames.filter((source) => String(source.id) === id);
    if (sameId.some((source) => Number(source.season) !== season || Number(source.week) !== week ||
        playerTeam(source.visitor_team?.abbreviation) !== away ||
        playerTeam(source.home_team?.abbreviation) !== home ||
        Date.parse(source.date) !== Date.parse(entry.sourceDate))) {
      throw new Error("Conflicting canonical schedule ID provenance");
    }
    if (scheduleIds.has(id) && scheduleIds.get(id) !== identity(entry)) {
      throw new Error("Canonical schedule ID assigned to multiple matchups");
    }
    scheduleIds.set(id, identity(entry));
    const key = identity(entry), existing = selected.get(key);
    if (existing) {
      if (existing.id !== id || Date.parse(existing.sourceDate) !== Date.parse(entry.sourceDate)) throw new Error("Conflicting prediction schedule duplicate");
      continue;
    }
    if (teams.has(away) || teams.has(home)) throw new Error("Team scheduled more than once in prediction week");
    teams.add(away); teams.add(home); selected.set(key, entry);
  }
  const games = [...selected.values()].sort((a, b) => Date.parse(a.sourceDate) - Date.parse(b.sourceDate) || identity(a).localeCompare(identity(b)));
  if (!games.length) throw new Error("Current-week prediction schedule unavailable");
  const cutoff = games[0].sourceDate;
  if (Date.parse(cutoff) <= now.getTime()) throw new Error("Prediction refresh prohibited after the weekly first kickoff");
  const metrics = dataset.metricsByWeek?.[week];
  if (!metrics || games.some((g) => [g.away, g.home].some((code) =>
    Date.parse(metrics[code]?.situational?.cutoff) !== Date.parse(cutoff)))) {
    throw new Error("Schedule first kickoff differs from current situational artifact cutoff");
  }
  return { season, week, cutoff, games };
}

export function validatePredictionRefreshBatch(snapshots, context, now) {
  if (snapshots.length !== context.games.length) throw new Error("Incomplete prediction refresh batch");
  for (let index = 0; index < snapshots.length; index++) {
    const s = snapshots[index], g = context.games[index];
    const p = s?.predictionPayload;
    if (!completePrediction(s) || !predictionFeatureStatus(s).complete || !finiteTree(s) ||
        ![s.fourthDownAwayScore, s.fourthDownHomeScore, p?.continuousMargin,
          s.fourthDownAwayWinProbability, s.fourthDownHomeWinProbability].every(Number.isFinite) ||
        s.fourthDownAwayScore < 0 || s.fourthDownHomeScore < 0 ||
        s.fourthDownAwayWinProbability < 0 || s.fourthDownAwayWinProbability > 1 ||
        s.fourthDownHomeWinProbability < 0 || s.fourthDownHomeWinProbability > 1 ||
        s.season !== context.season || s.week !== context.week || s.awayCode !== g.away || s.homeCode !== g.home ||
        Date.parse(s.kickoff) !== Date.parse(g.sourceDate) || Date.parse(s.kickoff) <= now.getTime() ||
        !Number.isFinite(Date.parse(s.generatedAt)) || Date.parse(s.generatedAt) > now.getTime() + 60000 ||
        p.away?.score !== s.fourthDownAwayScore || p.home?.score !== s.fourthDownHomeScore ||
        p.total !== p.away.score + p.home.score ||
        p.awayWinProbability !== s.fourthDownAwayWinProbability ||
        p.homeWinProbability !== s.fourthDownHomeWinProbability ||
        Math.abs(p.awayWinProbability + p.homeWinProbability - 1) > .0011 ||
        !Array.isArray(s.playerProjections?.away?.players) || !s.playerProjections.away.players.length ||
        !Array.isArray(s.playerProjections?.home?.players) || !s.playerProjections.home.players.length) {
      throw new Error(`Incomplete or inconsistent current-feature prediction: ${g.away} at ${g.home}`);
    }
  }
}

export function createPredictionRefreshHandler(overrides = {}) {
  const getNow = overrides.getNow || (() => new Date());
  const createClient = overrides.createClient || createSnapshotClient;
  const readSchedule = overrides.readSchedule || fetchSchedule;
  const resolveContext = overrides.resolveContext || predictionRefreshContext;
  const readOdds = overrides.readOdds || readPredictionOdds;
  const loadNetwork = overrides.loadNetwork || loadWeeklyOpponentNetwork;
  const createGenerator = overrides.createGenerator || createServerPredictionGenerator;
  const save = overrides.savePrediction || saveAuthoritativePrediction;
  const savePlan = overrides.saveLockPlan || saveWeeklyLockPlan;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
    if (!secureBearerMatches(req.headers?.authorization, process.env.CRON_SECRET)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const now = getNow();
      const dryRun = req.method !== "POST" || req.body?.dryRun !== false;
      const sourceGames = await readSchedule(dataset.season, { deadline: Date.now() + 55000 });
      const context = await resolveContext(sourceGames, now);
      if (context.season === 2026 && context.week === 7) throw new Error("HISTORICAL_WEEK_7_PRESERVED");
      const prepareWeeklyLock = req.body?.prepareWeeklyLock === true;
      const lockContext = { ...context, lockAt: new Date(getLockCycle(new Date(context.cutoff)).lockAt).toISOString() };
      if (prepareWeeklyLock) buildWeeklyLockPlan(lockContext, now);
      const client = createClient();
      const { data: rows, error } = await client.from("prediction_snapshots").select("*")
        .eq("season", context.season).eq("week", context.week);
      if (error) throw new Error("Reading prediction refresh inputs failed");
      const prior = new Map();
      for (const row of rows || []) {
        const s = databaseToSnapshot(row), key = `${s.awayCode}:${s.homeCode}`;
        if (prior.has(key)) throw new Error("Duplicate saved prediction identity");
        prior.set(key, s);
      }
      const odds = await readOdds(client, now, context);
      const network = validateWeeklyOpponentNetwork(await loadNetwork(context.season, context.week, {
        sourceGames, cutoff: context.cutoff, now,
      }), context.season, context.week);
      const generate = createGenerator({ weeklyNetwork: network, sourceGames, weeklyCutoff: context.cutoff });
      const generated = [];
      let reused = 0;
      for (let index = 0; index < context.games.length; index += 3) {
        generated.push(...await Promise.all(context.games.slice(index, index + 3).map(async (game) => {
          const existing = prior.get(identity(game));
          if (existing?.authoritative && completePrediction(existing) && predictionFeatureStatus(existing).complete &&
              Date.parse(existing.kickoff) === Date.parse(game.sourceDate) &&
              (!prepareWeeklyLock || !lockPredictionRejections(existing, lockContext, now).length)) {
            reused++;
            return existing;
          }
          try {
            if (existing?.frozenAt || existing?.actualWinner) throw new Error("Frozen or graded prediction cannot be refreshed");
            const snapshot = await generate(game, odds, now);
            return snapshot;
          } catch (error) {
            throw new Error(`${game.away} at ${game.home}: ${error instanceof Error ? error.message : "Prediction generation failed"}`, { cause: error });
          }
        })));
      }
      validatePredictionRefreshBatch(generated, context, getNow());
      if (!dryRun) {
        for (const snapshot of generated) {
          if (prior.get(`${snapshot.awayCode}:${snapshot.homeCode}`) !== snapshot) {
            await save(client, snapshot, getNow(), { requireLockProvenance: prepareWeeklyLock });
          }
        }
        const { data: stored, error: readError } = await client.from("prediction_snapshots").select("*")
          .eq("season", context.season).eq("week", context.week);
        if (readError) throw new Error("Verifying refreshed predictions failed");
        const byGame = new Map((stored || []).map((row) => {
          const s = databaseToSnapshot(row);
          return [`${s.awayCode}:${s.homeCode}`, s];
        }));
        const saved = context.games.map((game) => byGame.get(identity(game)));
        validatePredictionRefreshBatch(saved, context, getNow());
        if (prepareWeeklyLock) {
          if (saved.some((snapshot) => lockPredictionRejections(snapshot, lockContext, getNow()).length)) {
            throw new Error("AUTHORITATIVE_LOCK_PROVENANCE_REQUIRED");
          }
          await savePlan(client, lockContext, getNow());
        }
      }
      return res.status(200).json({
        status: dryRun ? "dry run" : "refreshed", dryRun, prepareWeeklyLock, season: context.season, week: context.week,
        predictionFeatureVersion: PREDICTION_FEATURE_VERSION, networkComputations: 1,
        generated: generated.length - reused, reused, writes: dryRun ? 0 : generated.length - reused,
        predictions: generated.map((s) => ({
          game: `${s.awayCode} at ${s.homeCode}`, ...predictionFeatureStatus(s),
          playerProjections: s.playerProjections.available,
          score: [s.fourthDownAwayScore, s.fourthDownHomeScore],
          margin: s.predictionPayload.continuousMargin,
          probabilities: [s.fourthDownAwayWinProbability, s.fourthDownHomeWinProbability],
          predictionFeatureVersion: s.predictionFeatureVersion,
          thirdDown: s.predictionPayload.matchupIntelligence.situational.signals.find((v) => v.key === "thirdDown")?.available,
          redZone: s.predictionPayload.matchupIntelligence.situational.signals.find((v) => v.key === "redZone")?.available,
        })),
      });
    } catch (error) {
      console.error("Prediction-only refresh failed:", error instanceof Error ? error.message : "Unknown failure");
      return res.status(502).json({ error: "Prediction-only refresh failed", code: "PREDICTION_REFRESH_FAILED",
        reason: error instanceof Error ? error.message : "Unknown failure" });
    }
  };
}
