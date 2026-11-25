// Weekly production sequence, run after the week's data is deployed:
//   1. refresh every odds market within the provider's 12 calls a minute
//   2. refresh authoritative predictions until complete
//   3. report the proposed Weekly Multi
// It never locks the Multi: that needs a person to approve the exact legs.
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getCalendarWeek } from "../src/services/weekLifecycle.js";

export const MARKETS = ["moneyline", "total_points", "point_spread", "player_reception_yds", "player_receptions",
  "player_rush_yds", "player_pass_yds", "player_rush_attempts", "player_rush_reception_yds", "player_pass_tds",
  "player_pass_attempts", "player_completions"];
const MINUTE = 62000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient({ base, secret, fetchImpl = fetch }) {
  if (!secret) throw new Error("CRON_SECRET is required");
  return async (route, { method = "GET", body, timeout = 90000 } = {}) => {
    let response;
    try {
      response = await fetchImpl(base + route, { method, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) { return { status: 0, body: { error: error?.name === "TimeoutError" ? "timeout" : "transport failure" } }; }
    const text = await response.text();
    try { return { status: response.status, body: JSON.parse(text) }; }
    catch { return { status: response.status, body: { error: "non-JSON response" } }; }
  };
}

export async function refreshMarket(call, market, { sleep = pause, log = () => {}, attempts = 4 } = {}) {
  let resume = "", result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { status, body } = await call(`/api/nfl/odds?refreshMarket=${market}${resume}`);
    result = { market, status: body?.status || body?.error || `HTTP ${status}`, rows: body?.rowCount ?? 0, games: body?.gameCount };
    log(JSON.stringify(result));
    if (status === 401 || status === 403) throw new Error("Production rejected the job credentials");
    if (["ok", "empty"].includes(result.status)) return result;
    if (attempt === attempts) return result;
    resume = result.status === "partial" && body.nextOffset ? `&resumeOffset=${body.nextOffset}` : "";
    await sleep(Math.max(MINUTE, ((Number(body?.retryAfterSeconds) || 0) + 2) * 1000));
  }
  return result;
}

export async function refreshOdds(call, { sleep = pause, log = () => {}, markets = MARKETS } = {}) {
  const results = [];
  for (const [index, market] of markets.entries()) {
    if (index) await sleep(MINUTE);
    results.push(await refreshMarket(call, market, { sleep, log }));
  }
  // Without moneylines no bet can be priced, so continuing would only publish bad data.
  if (results.find((row) => row.market === "moneyline")?.status !== "ok") throw new Error("Moneyline odds are unavailable");
  return results;
}

export async function refreshPredictions(call, week, { sleep = pause, log = () => {}, maxCalls = 40, maxFailures = 6 } = {}) {
  let failures = 0;
  for (let index = 0; index < maxCalls; index += 1) {
    const { status, body } = await call("/api/nfl/game-stats?action=refresh-predictions",
      { method: "POST", body: { dryRun: false, prepareWeeklyLock: true } });
    if (status === 401 || status === 403) throw new Error("Production rejected the job credentials");
    if (status !== 200) {
      failures += 1;
      log(`refresh failed (${failures}/${maxFailures}): ${status} ${body?.reason || body?.error}`);
      if (failures >= maxFailures) throw new Error(`Prediction refresh did not complete: ${body?.reason || body?.error}`);
      await sleep(20000);
      continue;
    }
    failures = 0;
    if (body.week !== week) throw new Error(`Production is on Week ${body.week}, expected Week ${week}`);
    log(`processed ${body.processed}, remaining ${body.remaining}`);
    if (body.complete) return body;
  }
  throw new Error("Prediction refresh did not complete");
}

export async function proposeMulti(call) {
  const { status, body } = await call("/api/weekly-multi/prepare?dryRun=1");
  if (status !== 200) return { status: "unavailable", detail: body?.error || `HTTP ${status}` };
  if (body.status === "already locked") return { status: "already locked" };
  const readiness = body.readiness || {};
  return { status: body.status, blocking: readiness.blockingReasons || [],
    legs: (readiness.selection?.legs || []).map((leg) => ({ game: `${leg.awayCode} at ${leg.homeCode}`, pick: `${leg.selection} (${leg.market})`,
      odds: leg.decimalOdds, chance: leg.tempered?.probability ?? null })) };
}

export function inSeason(now) {
  const at = now.getTime();
  return at >= Date.UTC(2026, 8, 15, 7) && at < Date.UTC(2027, 0, 12, 7);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!inSeason(new Date())) { console.log("Outside the 2026 regular season; nothing to do."); process.exit(0); }
  const week = getCalendarWeek(), log = (line) => console.log(new Date().toISOString(), line);
  const call = createClient({ base: process.env.PRODUCTION_URL || "https://fourth-down-coral.vercel.app", secret: process.env.CRON_SECRET });
  const odds = await refreshOdds(call, { log });
  await refreshPredictions(call, week, { log });
  const multi = await proposeMulti(call);
  const summary = [`## Week ${week} is ready`, "", "| Market | Result | Rows |", "|---|---|---|",
    ...odds.map((row) => `| ${row.market} | ${row.status} | ${row.rows} |`), "", `**Weekly Multi:** ${multi.status} ${(multi.blocking || []).join(", ")}`,
    ...(multi.legs?.length ? ["", "| Game | Pick | Odds | Realistic chance |", "|---|---|---|---|",
      ...multi.legs.map((leg) => `| ${leg.game} | ${leg.pick} | ${leg.odds} | ${leg.chance === null ? "" : Math.round(leg.chance * 100) + "%"} |`),
      "", "Not locked. Locking needs approval of these exact legs."] : [])].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
