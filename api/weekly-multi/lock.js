import {
  buildWeeklyMultiSelection,
  createWeeklyMultiClient,
  isFreshOddsPayload,
  lockIsPastDeadline,
  makeWeeklyMultiRecord,
  predictionSnapshotsForWeek,
  resolveLockWeekContext,
  secureBearerMatches,
  getOddsEndpointUrl,
} from "../../api-lib/weeklyMulti.js";

export function createWeeklyMultiLockHandler(overrides = {}) {
  const resolveContext = overrides.resolveContext || resolveLockWeekContext;
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const fetchOdds = overrides.fetchOdds || ((...args) => fetch(...args));
  const getNow = overrides.getNow || (() => new Date());

  return async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !secureBearerMatches(req.headers.authorization, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const dryRun = String(req.query?.dryRun ?? req.query?.dry_run ?? req.body?.dryRun ?? req.body?.dry_run ?? "")
    .toLowerCase() === "true" || String(req.query?.dryRun ?? req.query?.dry_run ?? req.body?.dryRun ?? req.body?.dry_run ?? "") === "1";

  try {
    const now = getNow();
    const context = await resolveContext(now, { allowBeforeLock: dryRun });
    if (!context.available) {
      return res.status(200).json({
        status: context.notYetLocked ? "not yet locked" : "not ready",
        reason: context.reason,
        lockAt: context.lockAt,
        deadlineAt: context.deadlineAt,
      });
    }
    // Allow dry-run to continue even if the schedule is marked ineligible;
    // actual writes remain gated on real eligibility (dry-run will not write).
    if (!context.eligible && !dryRun) {
      return res.status(200).json({ status: "not yet locked", season: context.season, week: context.week, lockAt: context.lockAt, deadlineAt: context.deadlineAt });
    }

    const supabase = createClient();
    const { data: existing, error: readError } = await supabase
      .from("weekly_best_multis")
      .select("*")
      .eq("season", context.season)
      .eq("week", context.week)
      .maybeSingle();
    if (readError) throw readError;
    if (existing && !dryRun) return res.status(200).json({ status: "already locked", record: existing });

    const atDeadline = lockIsPastDeadline(context, now);
    if (!dryRun && atDeadline) {
      const firstKickoff = new Date(context.firstKickoffAt || "").getTime();
      if (!Number.isFinite(firstKickoff)) {
        return res.status(200).json({
          status: "not ready",
          season: context.season,
          week: context.week,
          reason: "The first regular-season kickoff is unavailable",
        });
      }
      if (now.getTime() >= firstKickoff) {
        return res.status(200).json({
          status: "missed",
          season: context.season,
          week: context.week,
          firstKickoffAt: context.firstKickoffAt,
          message: "No Weekly Best Multi was locked for this week.",
        });
      }
    }

    const [{ data: predictionRows, error: predictionError }, oddsResponse] = await Promise.all([
      supabase.from("prediction_snapshots").select("*").eq("season", context.season).eq("week", context.week),
      fetchOdds(getOddsEndpointUrl(req), { cache: "no-store", headers: { Accept: "application/json" } }),
    ]);
    if (predictionError) throw predictionError;
    if (!oddsResponse.ok) throw new Error(`Odds refresh request failed (${oddsResponse.status})`);
    const oddsPayload = await oddsResponse.json();
    const snapshots = predictionSnapshotsForWeek(predictionRows, context, now);
    const freshOdds = isFreshOddsPayload(oddsPayload);
    const selection = buildWeeklyMultiSelection(snapshots, freshOdds ? oddsPayload : null, context, now);
    const dataReady = snapshots.length > 0 && freshOdds;
    const notReadyReason = !dataReady
      ? snapshots.length === 0 ? "No current complete prediction snapshots with fresh odds are available" : "Fresh live odds are unavailable"
      : selection.complete ? null : "Fewer than five eligible legs qualify at the 55% probability floor";

    if (dryRun) {
      return res.status(200).json({
        status: !dataReady || !selection.complete ? "not ready" : "locked",
        dryRun: true,
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
        deadlineAt: context.deadlineAt,
        legCount: selection.legs.length,
        legs: selection.legs,
        threshold: selection.threshold,
        complete: selection.complete,
        reason: notReadyReason,
        oddsCacheStatus: oddsPayload.cacheStatus || "unavailable",
        predictionCount: snapshots.length,
      });
    }

    if (!atDeadline && (!dataReady || !selection.complete)) {
      return res.status(200).json({
        status: "not ready",
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
        deadlineAt: context.deadlineAt,
        legCount: selection.legs.length,
        threshold: selection.threshold,
        reason: notReadyReason,
        oddsCacheStatus: oddsPayload.cacheStatus || "unavailable",
      });
    }

    const reason = selection.complete
      ? null
      : [notReadyReason, !dataReady ? "Saved at retry deadline with incomplete inputs" : null].filter(Boolean).join("; ");
    const record = makeWeeklyMultiRecord(selection, context, now, reason);
    const { data: inserted, error: insertError } = await supabase
      .from("weekly_best_multis")
      .insert(record)
      .select("*")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: winner, error: winnerError } = await supabase
          .from("weekly_best_multis")
          .select("*")
          .eq("season", context.season)
          .eq("week", context.week)
          .single();
        if (winnerError) throw winnerError;
        return res.status(200).json({ status: "already locked", record: winner });
      }
      throw insertError;
    }

    const status = record.generated_late ? "generated late" : record.partial ? "partial" : "locked";
    return res.status(200).json({ status, record: inserted });
  } catch (error) {
    console.error("Weekly Best Multi lock failed", error);
    return res.status(500).json({ error: "Weekly Best Multi lock failed" });
  }
  };
}

export default createWeeklyMultiLockHandler();
