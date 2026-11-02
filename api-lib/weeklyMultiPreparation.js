import { randomUUID } from "node:crypto";
import { createWeeklyMultiClient, getLockCycle, secureBearerMatches, makeWeeklyMultiRecord } from "./weeklyMulti.js";
import { readPredictionOdds } from "./serverPredictions.js";
import { evaluateWeeklyMultiReadiness, savedPredictionRows, validLockPlan } from "./weeklyMultiReadiness.js";
import { buildLockManifest, persistLockManifest, recordLockExecution } from "./weeklyLockAudit.js";
import { PRESERVED_LOCK_THROUGH, snapshotAuthority } from "./weeklyLockProvenance.js";

export function createWeeklyMultiPreparationHandler(overrides = {}) {
  const getNow = overrides.getNow || (() => new Date());
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const readOdds = overrides.readOdds || readPredictionOdds;
  const recordExecution = overrides.recordExecution || recordLockExecution;
  const persistManifest = overrides.persistManifest || persistLockManifest;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
    const now = getNow();
    const lockAt = new Date(getLockCycle(now).targetLockAt).toISOString();
    const operationId = randomUUID();
    const authorized = secureBearerMatches(req.headers?.authorization, process.env.CRON_SECRET);
    const base = {
      operation_id: operationId, season: null, week: null, scheduled_at: lockAt,
      invoked_at: now.toISOString(), authorization_result: authorized ? "AUTHORIZED" : "DENIED",
      handler_reached: true, generated_late: now.getTime() > Date.parse(lockAt) + 15 * 60000,
      readiness_result: "UNKNOWN", preparation_result: "NOT_STARTED",
      lock_result: "NOT_ATTEMPTED", existing_lock_result: false,
    };
    let client, plan, predictions = [], odds, capturedId;
    let stage = "STARTED";
    try {
      client = createClient();
      await recordExecution(client, { ...base, stage, result: authorized ? "HANDLER_REACHED" : "AUTHORIZATION_FAILED" });
      if (!authorized) return res.status(401).json({ error: "Unauthorized", operationId });
      const { data: existing, error: existingError } = await client.from("weekly_best_multis").select("*")
        .eq("lock_at", lockAt).maybeSingle();
      if (existingError) throw new Error("EXISTING_LOCK_READ_FAILED");
      if (existing) {
        base.existing_lock_result = true;
        base.lock_result = "EXISTING";
        await recordExecution(client, { ...base, stage: "FINISHED", result: "LOCK_ALREADY_EXISTED" });
        return res.status(200).json({ status: "already locked", record: existing, operationId });
      }
      const prepare = req.query?.weeklyMultiMode === "prepare";
      const dryRun = ["1", "true"].includes(String(req.query?.dryRun ?? req.body?.dryRun ?? "").toLowerCase());
      if (lockAt <= PRESERVED_LOCK_THROUGH) {
        await recordExecution(client, { ...base, stage: "FINISHED", result: "HISTORICAL_LOCK_PROHIBITED" });
        return res.status(200).json({ status: "not ready", reason: "HISTORICAL_LOCK_PROHIBITED", operationId });
      }
      // A post-lock catch-up re-locks the current unlocked week from the persisted
      // authoritative batch when the scheduled run was blocked only because that
      // batch was unavailable. It never runs before the lock and never re-locks.
      const catchUp = !prepare && now.getTime() > Date.parse(lockAt);
      if ((!prepare && now.getTime() < Date.parse(lockAt)) ||
          (!catchUp && now.getUTCDay() !== 4 && !(prepare && now.getUTCDay() === 3))) {
        await recordExecution(client, { ...base, stage: "FINISHED", result: "OUTSIDE_LOCK_WINDOW" });
        return res.status(200).json({ status: "not ready", reason: "OUTSIDE_LOCK_WINDOW", operationId });
      }
      const { data, error } = await client.from("weekly_multi_lock_plans").select("*")
        .eq("lock_at", lockAt).maybeSingle();
      if (error) throw new Error("LOCK_PLAN_READ_FAILED");
      plan = data;
      if (!plan && catchUp) plan = await deriveCatchUpPlan(client, lockAt, now);
      if (plan && validLockPlan(plan, now)) {
        base.season = plan.season;
        base.week = plan.week;
        const { data: rows, error: predictionError } = await client.from("prediction_snapshots").select("*")
          .eq("season", plan.season).eq("week", plan.week);
        if (predictionError) throw new Error("PREDICTION_READ_FAILED");
        predictions = savedPredictionRows(rows);
        // A catch-up over the atomic batch re-reads the exact pre-lock quotes
        // embedded in each persisted snapshot; the current-week snapshot table
        // has since been refreshed and no longer holds them.
        odds = catchUp && predictions.every((row) => row.batchProvenance?.source === "server-week-replacement")
          ? embeddedOddsPayload(predictions)
          : await readOdds(client, now, { season: plan.season, week: plan.week });
      }
      stage = "INPUTS_CAPTURED";
      capturedId = await persistManifest(client, buildLockManifest({
        operationId, plan, predictions, odds, now, result: "INPUTS_CAPTURED",
      }));
      const readiness = evaluateWeeklyMultiReadiness({ plan, predictions, odds, now });
      const ready = readiness.canSatisfyLegCount;
      const readinessResult = !ready && readiness.eligiblePredictionCount === readiness.expectedGameCount &&
        readiness.eligibleBestBetCount === 0 ? "NO_ELIGIBLE_CANDIDATES" : "READINESS_FAILED";
      base.readiness_result = readiness.status;
      base.preparation_result = ready ? "READY" : "FAILED";
      stage = "EVALUATED";
      const manifestId = await persistManifest(client, buildLockManifest({
        operationId, plan, predictions, odds, readiness, now, parentId: capturedId,
        result: ready ? "READY" : "READINESS_FAILED",
      }));
      await recordExecution(client, { ...base, stage, result: ready ? "READY" : readinessResult,
        manifest_id: manifestId, readiness_result: readiness.status });
      if (!ready || prepare || dryRun) {
        await recordExecution(client, { ...base, stage: "FINISHED",
          result: !ready ? readinessResult : prepare ? "PREPARED" : "DRY_RUN",
          manifest_id: manifestId, readiness_result: readiness.status });
        return res.status(200).json({ status: ready ? "prepared" : "not ready", operationId,
          manifestId, readiness, dryRun });
      }
      // No awaits that acquire new inputs after capture: retries consume only retained pre-lock evidence.
      const record = { ...makeWeeklyMultiRecord(readiness.selection, {
        season: plan.season, week: plan.week, lockAt,
      }, now), manifest_id: manifestId };
      base.lock_result = "ATTEMPTED";
      const { data: inserted, error: insertError } = await client.from("weekly_best_multis")
        .insert(record).select("*").single();
      if (insertError) {
        if (insertError.code !== "23505") throw new Error("LOCK_PERSISTENCE_FAILED");
        const { data: winner, error: winnerError } = await client.from("weekly_best_multis").select("*")
          .eq("lock_at", lockAt).maybeSingle();
        if (winnerError || !winner) throw new Error("LOCK_PERSISTENCE_FAILED");
        base.existing_lock_result = true;
        base.lock_result = "EXISTING";
        await recordExecution(client, { ...base, stage: "FINISHED", result: "LOCK_ALREADY_EXISTED", manifest_id: manifestId });
        return res.status(200).json({ status: "already locked", record: winner, operationId });
      }
      base.lock_result = "SUCCEEDED";
      await recordExecution(client, { ...base, stage: "FINISHED", result: "LOCK_SUCCEEDED", manifest_id: manifestId });
      return res.status(200).json({ status: "locked", record: inserted, operationId });
    } catch {
      const failure = { ...base, stage: "FAILED", result: "PIPELINE_FAILED",
        failure_code: stage === "STARTED" ? "INPUT_OR_AUDIT_UNAVAILABLE" : "PREPARATION_OR_PERSISTENCE_FAILED" };
      console.error("Weekly Multi execution failed", JSON.stringify(failure));
      if (client) {
        try {
          await persistManifest(client, buildLockManifest({ operationId, plan, now,
            result: failure.failure_code, parentId: capturedId || null }));
          await recordExecution(client, failure);
        } catch {
          console.error("Weekly Multi audit unavailable", JSON.stringify({ operationId, code: "AUDIT_STORAGE_UNAVAILABLE" }));
        }
      }
      return res.status(authorized ? 503 : 401).json({ error: authorized ? failure.failure_code : "Unauthorized",
        operationId, lockResult: base.lock_result });
    }
  };
}

// Builds the odds payload from the exact pre-lock quotes embedded in each
// persisted atomic-batch snapshot (game.oddsEvent). These are the quotes the
// saved Best Bets were assessed against; the snapshot table has since moved on.
function embeddedOddsPayload(predictions) {
  const events = (predictions || []).map((row) => row.game?.oddsEvent).filter((event) =>
    event && Array.isArray(event.bookmakers) && event.bookmakers.length);
  const times = events.flatMap((event) => event.bookmakers.flatMap((book) =>
    (book.markets || []).flatMap((market) => (market.outcomes || []).map((outcome) =>
      Date.parse(outcome.quoteSource?.timestamp || outcome.updatedAt || market.last_update || book.last_update)))))
    .filter(Number.isFinite);
  return {
    events,
    cacheStatus: events.length ? "fresh" : "unavailable",
    refreshedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

// Derives the expected-game plan for a post-lock catch-up directly from the
// persisted authoritative batch when no pre-lock plan was ever saved. The batch
// is the authoritative source: every snapshot must be authoritative, complete,
// pre-kickoff at the lock moment and belong to a single week whose kickoffs all
// fall inside the lock window. Returns null when no such batch exists.
async function deriveCatchUpPlan(client, lockAt, now) {
  const lock = Date.parse(lockAt);
  const { data: rows, error } = await client.from("prediction_snapshots").select("*")
    .eq("season", 2026).gte("kickoff", new Date(lock).toISOString())
    .lt("kickoff", new Date(lock + 7 * 86400000).toISOString());
  if (error) throw new Error("PREDICTION_READ_FAILED");
  const snapshots = savedPredictionRows(rows);
  if (!snapshots.length) return null;
  const weeks = new Set(snapshots.map((row) => `${row.season}:${row.week}`));
  if (weeks.size !== 1) return null;
  const { season, week } = (() => { const [s, w] = [...weeks][0].split(":"); return { season: Number(s), week: Number(w) }; })();
  const context = { season, week, lockAt };
  const games = [];
  for (const snapshot of snapshots) {
    const kickoff = Date.parse(snapshot.kickoff);
    if (!snapshotAuthority(snapshot, context).authoritative || !Number.isFinite(kickoff) ||
        kickoff <= lock || kickoff >= lock + 7 * 86400000) return null;
    games.push({ away: snapshot.awayCode, home: snapshot.homeCode, kickoff: snapshot.kickoff });
  }
  const plan = {
    id: randomUUID(), season, week, lock_at: lockAt, prepared_at: new Date(lock - 1).toISOString(),
    source: "server-prepared", expected_game_count: games.length, games,
  };
  return validLockPlan(plan, now) ? plan : null;
}
