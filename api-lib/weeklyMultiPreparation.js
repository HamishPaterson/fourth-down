import {
  createWeeklyMultiClient, createWeeklyMultiLockHandler, resolveLockWeekContext,
  predictionSnapshotsForWeek, secureBearerMatches, buildWeeklyMultiSelection,
} from "./weeklyMulti.js";
import { createServerPredictionGenerator, readPredictionOdds, saveAuthoritativePrediction, refreshSavedBestBets } from "./serverPredictions.js";
import { completePrediction } from "./predictionEligibility.js";
import { FULL_MODEL_VERSION } from "../src/services/gamePredictionService.js";

const finiteTree = (value) => typeof value === "number" ? Number.isFinite(value)
  : !value || typeof value !== "object" || Object.values(value).every(finiteTree);

export function createWeeklyMultiPreparationHandler(overrides = {}) {
  const getNow = overrides.getNow || (() => new Date());
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const resolveContext = overrides.resolveContext || resolveLockWeekContext;
  const readOdds = overrides.readOdds || readPredictionOdds;
  const save = overrides.savePrediction || saveAuthoritativePrediction;
  const report = overrides.report || ((status) => console.info("Weekly Multi pipeline", status));
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
    if (!secureBearerMatches(req.headers?.authorization, process.env.CRON_SECRET)) return res.status(401).json({ error: "Unauthorized" });
    const status = { modelVersion: FULL_MODEL_VERSION, refresh: "not started", persistence: "not started", lock: "not attempted" };
    try {
      const now = getNow();
      const prepareOnly = req.query?.weeklyMultiMode === "prepare";
      const dryRun = ["1", "true"].includes(String(req.query?.dryRun ?? req.query?.dry_run ?? req.body?.dryRun ?? req.body?.dry_run ?? "").toLowerCase());
      // Hobby jobs can run anywhere within their scheduled hour. Do not wait in
      // a serverless process or generate a distant week's data on other days.
      if (now.getUTCDay() !== 4 && !(prepareOnly && now.getUTCDay() === 3)) {
        return res.status(200).json({ ...status, reason: "Outside the weekly preparation day" });
      }
      const context = await resolveContext(now, { allowBeforeLock: prepareOnly });
      if (!context.available) return res.status(200).json({ ...status, reason: context.reason });
      const client = createClient();
      const { data: existing, error } = await client.from("weekly_best_multis")
        .select("id,season,week,lock_at,locked_at,legs,status,partial,model_probability_threshold,generated_late,odds_late,odds_updated_at,odds_refreshed_at,odds_cache_status,reason,reason_counts")
        .eq("season", context.season).eq("week", context.week).maybeSingle();
      if (error) throw new Error(["PGRST204", "42703"].includes(error.code)
        ? "Weekly Multi schema is outdated; apply supabase/weekly_best_multis.sql before finalization"
        : "Reading existing Weekly Multi failed");
      if (existing) return res.status(200).json({ status: "already locked", record: existing });
      if (!prepareOnly && !context.eligible) return res.status(200).json({ ...status, reason: "The 10:00 AEST lock has not arrived" });
      const games = context.games || [];
      if (!games.length) throw new Error("No scheduled games available for prediction refresh");
      if (games.some((game) => new Date(game.date).getTime() <= now.getTime())) {
        return res.status(200).json({ ...status, reason: "Weekly kickoff has passed; prediction refresh and lock are prohibited" });
      }
      status.scheduledGames = games.length;
      status.refresh = "started";
      report({ ...status });
      const odds = await readOdds(client, now, context);
      status.oddsFreshness = odds.cacheStatus;
      const { data: priorRows, error: priorError } = await client.from("prediction_snapshots").select("*")
        .eq("season", context.season).eq("week", context.week);
      if (priorError) throw new Error("Reading prepared predictions failed");
      const prepared = new Map(predictionSnapshotsForWeek(priorRows, context, now)
        .filter((snapshot) => snapshot.authoritative && completePrediction(snapshot))
        .map((snapshot) => [`${snapshot.awayCode}:${snapshot.homeCode}:${Date.parse(snapshot.kickoff)}`, snapshot]));
      const generate = overrides.generatePrediction || createServerPredictionGenerator();
      const generated = [];
      status.generatedPredictions = 0;
      status.reusedPredictions = 0;
      // Bounded concurrency stays inside the Hobby function duration.
      for (let index = 0; index < games.length; index += 3) {
        generated.push(...await Promise.all(games.slice(index, index + 3).map(async (game) => {
          const saved = prepared.get(`${game.visitor_team?.abbreviation}:${game.home_team?.abbreviation}:${Date.parse(game.date)}`);
          if (saved) {
            status.reusedPredictions++;
            return (overrides.refreshBestBets || refreshSavedBestBets)(saved, odds, now);
          }
          const snapshot = await generate({
            season: context.season, week: context.week,
            away: game.visitor_team?.abbreviation, home: game.home_team?.abbreviation,
            sourceDate: game.date, venue: game.venue, scheduleContext: game.scheduleContext,
          }, odds, now);
          status.generatedPredictions++;
          return snapshot;
        })));
      }
      if (generated.some((snapshot, index) => !completePrediction(snapshot) || !finiteTree(snapshot) ||
        snapshot.season !== context.season || snapshot.week !== context.week ||
        snapshot.awayCode !== games[index].visitor_team?.abbreviation ||
        snapshot.homeCode !== games[index].home_team?.abbreviation ||
        !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
        getNow().getTime() - Date.parse(snapshot.generatedAt) < -60000 ||
        getNow().getTime() - Date.parse(snapshot.generatedAt) > 24 * 3600000 ||
        new Date(snapshot.kickoff).getTime() !== new Date(games[index].date).getTime() ||
        new Date(snapshot.kickoff).getTime() <= getNow().getTime())) {
        throw new Error("Incomplete, wrong-week or post-kickoff prediction; no lock attempted");
      }
      status.completePredictions = generated.length;
      if (dryRun) {
        const selection = buildWeeklyMultiSelection(generated, odds, context, getNow());
        return res.status(200).json({
          ...status, refresh: "completed", persistence: "dry run", dryRun: true,
          season: context.season, week: context.week, legCount: selection.legs.length,
          threshold: selection.threshold, complete: selection.complete,
          reason: selection.complete ? null : "Fewer than five eligible legs qualify at the 55% probability floor",
        });
      }
      // Validate the entire batch before the first write. A failed or partial
      // persistence phase never proceeds to locking; retry safely resumes.
      status.persistence = "started";
      for (const snapshot of generated) await save(client, snapshot, getNow());
      const { data: stored, error: readError } = await client.from("prediction_snapshots").select("*")
        .eq("season", context.season).eq("week", context.week);
      if (readError) throw new Error("Verifying shared prediction persistence failed");
      const eligible = predictionSnapshotsForWeek(stored, context, getNow());
      status.eligiblePredictions = eligible.length;
      if (eligible.length !== games.length || eligible.some((snapshot) => !snapshot.authoritative || !completePrediction(snapshot))) {
        throw new Error("Persisted predictions are not all complete, authoritative and eligible; lock aborted");
      }
      status.persistence = "completed";
      status.refresh = "completed";
      report({ ...status });
      if (prepareOnly) return res.status(200).json({ ...status, season: context.season, week: context.week, lockAt: context.lockAt });
      status.lock = "attempted";
      report({ ...status });
      const lock = createWeeklyMultiLockHandler({
        createClient: () => client, getNow,
        resolveContext: async () => context,
        fetchOdds: async (url) => ({ ok: true, json: async () => String(url).includes("props=1")
          ? { cacheStatus: "fresh", events: [] } : odds }),
      });
      return await lock(req, {
        setHeader: (...args) => res.setHeader(...args),
        status(code) { this.code = code; return this; },
        json(body) {
          status.lock = body.record ? "completed" : "not created";
          status.reason = body.reason || body.message || body.error || body.record?.reason || null;
          report({ ...status });
          return res.status(this.code).json({ ...body, pipeline: status });
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Weekly preparation failed";
      report({ ...status, failure: true, reason });
      return res.status(503).json({ ...status, error: "Weekly Multi preparation failed; no lock attempted", reason });
    }
  };
}
