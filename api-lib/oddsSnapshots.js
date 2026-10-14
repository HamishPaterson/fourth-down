import { createClient } from "@supabase/supabase-js";

export const SNAPSHOT_TABLE = "odds_market_snapshots";
export const SNAPSHOT_SPORT = "nfl";
export const SNAPSHOT_PROVIDER = "SharpAPI";
export const SNAPSHOT_SEASON = 2026;
// Markets refresh once a day, so a snapshot is stale after a day plus cron jitter.
export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 60 * 1000;

const ON_CONFLICT = "sport,season,week,market";

export function createSnapshotClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server environment variables are missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function readSnapshots(client, { sport = SNAPSHOT_SPORT, season = SNAPSHOT_SEASON, week }) {
  const { data, error } = await client
    .from(SNAPSHOT_TABLE)
    .select("*")
    .eq("sport", sport)
    .eq("season", season)
    .eq("week", week);
  if (error) throw new Error(`Reading odds snapshots failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

export async function readEarlierSnapshots(client, { sport = SNAPSHOT_SPORT, season = SNAPSHOT_SEASON, week }) {
  const { data, error } = await client
    .from(SNAPSHOT_TABLE)
    .select("*")
    .eq("sport", sport)
    .eq("season", season)
    .lt("week", week);
  if (error) throw new Error(`Reading earlier odds snapshots failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

// Previous-week games that finished long ago are not relevant to the new week.
export const ROLLOVER_GAME_GRACE_MS = 4 * 60 * 60 * 1000;

/*
 * Rollover fallback for one market whose current-week snapshot has no data.
 * The newest earlier successful snapshot is used, but only rows for games that
 * are still upcoming/in progress, or that are already current-week events.
 * Rows are never re-keyed to other games.
 */
export function selectRolloverFallback(earlierSnapshots, market, { now, currentEventIds = new Set() }) {
  const candidates = (earlierSnapshots || [])
    .filter((snapshot) => snapshot.market === market && hasSnapshotData(snapshot))
    .sort((a, b) => b.week - a.week);

  for (const snapshot of candidates) {
    const rows = snapshotRows(snapshot).filter((row) => {
      const kickoff = new Date(row?.event_start_time || 0).getTime();
      return currentEventIds.has(String(row?.event_id)) || kickoff >= now - ROLLOVER_GAME_GRACE_MS;
    });
    if (rows.length) return { ...snapshot, rows, fallbackFromWeek: snapshot.week };
  }
  return null;
}

// Replaces only this market's rows. Nothing else in the table is touched.
export async function writeSnapshotSuccess(client, key, { rows, pageCount = 0, now = new Date() }) {
  const timestamp = now.toISOString();
  const { error } = await client.from(SNAPSHOT_TABLE).upsert(
    {
      ...snapshotKey(key),
      provider: SNAPSHOT_PROVIDER,
      rows,
      row_count: rows.length,
      page_count: pageCount,
      fetched_at: timestamp,
      last_attempt_at: timestamp,
      status: "ok",
      last_error: null,
      rate_limited_until: null,
    },
    { onConflict: ON_CONFLICT }
  );
  if (error) throw new Error(`Writing odds snapshot failed: ${error.message}`);
}

/*
 * Failures write metadata only. rows, row_count and fetched_at are omitted
 * from the upsert payload so the previous successful snapshot is preserved.
 */
export async function writeSnapshotFailure(
  client,
  key,
  { status, error: message, rateLimitedUntil = null, pageCount = 0, now = new Date() }
) {
  const { error } = await client.from(SNAPSHOT_TABLE).upsert(
    {
      ...snapshotKey(key),
      provider: SNAPSHOT_PROVIDER,
      last_attempt_at: now.toISOString(),
      status,
      last_error: String(message || "").slice(0, 500) || null,
      rate_limited_until: rateLimitedUntil ? rateLimitedUntil.toISOString() : null,
      page_count: pageCount,
    },
    { onConflict: ON_CONFLICT }
  );
  if (error) throw new Error(`Recording odds snapshot failure failed: ${error.message}`);
}

function snapshotKey({ sport = SNAPSHOT_SPORT, season = SNAPSHOT_SEASON, week, market }) {
  return { sport, season, week, market };
}

export function snapshotRows(snapshot) {
  return Array.isArray(snapshot?.rows) ? snapshot.rows : [];
}

// A snapshot only counts as data when a successful refresh stored rows.
export function hasSnapshotData(snapshot) {
  return Boolean(snapshot?.fetched_at) && snapshotRows(snapshot).length > 0;
}

export function summarizeSnapshots(snapshots, markets, now = Date.now()) {
  const byMarket = new Map((snapshots || []).map((snapshot) => [snapshot.market, snapshot]));

  const details = markets.map((market) => {
    const snapshot = byMarket.get(market);
    const hasData = hasSnapshotData(snapshot);
    const fetchedAt = hasData ? snapshot.fetched_at : null;
    const age = fetchedAt ? now - new Date(fetchedAt).getTime() : null;
    return {
      market,
      fetchedAt,
      status: snapshot?.status || "missing",
      fallback: Boolean(snapshot?.fallbackFromWeek),
      fallbackFromWeek: snapshot?.fallbackFromWeek ?? null,
      // Rollover fallback data is always reported as stale.
      stale: !hasData || Boolean(snapshot?.fallbackFromWeek) || !(age <= SNAPSHOT_MAX_AGE_MS),
      hasData,
      rowCount: hasData ? snapshotRows(snapshot).length : 0,
      lastAttemptAt: snapshot?.last_attempt_at || null,
      lastError: snapshot?.last_error || null,
      rateLimitedUntil: snapshot?.rate_limited_until || null,
    };
  });

  const missing = details.filter((detail) => !detail.hasData).map((detail) => detail.market);
  let cacheStatus = "fresh";
  if (missing.length === markets.length) cacheStatus = "unavailable";
  else if (missing.length > 0) cacheStatus = "partial";
  else if (details.some((detail) => detail.stale)) cacheStatus = "stale-fallback";

  return { cacheStatus, markets: details, missing };
}
