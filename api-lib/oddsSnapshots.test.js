import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { handleOddsRequest, getCurrentWeekWindow } from "../api/nfl/odds.js";
import { SNAPSHOT_TABLE } from "./oddsSnapshots.js";

const SECRET = "test-cron-secret";
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const WINDOW = getCurrentWeekWindow(NOW);
const CURRENT_KICKOFF = new Date(WINDOW.start + 24 * 3600 * 1000).toISOString();
const FUTURE_KICKOFF = new Date(WINDOW.end + 24 * 3600 * 1000).toISOString();

function createFakeClient(initial = []) {
  const store = new Map();
  const keyOf = (row) => [row.sport, row.season, row.week, row.market].join("|");
  for (const row of initial) store.set(keyOf(row), { ...row });

  return {
    store,
    from(table) {
      assert.equal(table, SNAPSHOT_TABLE);
      return {
        select() {
          const filters = [];
          const query = {
            eq(column, value) {
              filters.push([column, (row) => row[column] === value]);
              return query;
            },
            lt(column, value) {
              filters.push([column, (row) => row[column] < value]);
              return query;
            },
            then(resolve, reject) {
              const data = [...store.values()].filter((row) => filters.every(([, test]) => test(row)));
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            },
          };
          return query;
        },
        async upsert(payload) {
          const key = keyOf(payload);
          store.set(key, { ...(store.get(key) || {}), ...payload });
          return { error: null };
        },
      };
    },
  };
}

function row(overrides = {}) {
  return {
    id: `${overrides.event_id || "e1"}-${overrides.market_type || "moneyline"}-${overrides.selection || "Home"}-${overrides.line ?? ""}`,
    event_id: "e1",
    home_team: "Home",
    away_team: "Away",
    event_start_time: CURRENT_KICKOFF,
    sportsbook: "book",
    market_type: "moneyline",
    selection: "Home",
    odds_american: -110,
    ...overrides,
  };
}

function snapshot(market, rows, extra = {}) {
  return {
    sport: "nfl",
    season: 2026,
    week: WINDOW.week,
    market,
    provider: "SharpAPI",
    rows,
    fetched_at: new Date(NOW - 3600 * 1000).toISOString(),
    status: "ok",
    row_count: rows.length,
    ...extra,
  };
}

const spreadRows = [row({ market_type: "point_spread", selection: "Home", line: -3 })];
const totalRows = [row({ market_type: "total_points", selection: "Over", selection_type: "over", line: 44.5 })];
const moneylineRows = [row(), row({ selection: "Away" })];

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function refreshRequest(market, authorization = `Bearer ${SECRET}`) {
  return { method: "GET", url: `/api/nfl/odds?refreshMarket=${market}`, headers: { authorization } };
}

let fetchCalls;
let responder;
const originalFetch = global.fetch;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.SHARP_API_KEY = "test-key";
  fetchCalls = [];
  responder = () => ({ status: 200, body: { data: [] } });
  global.fetch = async (url) => {
    const parsed = new URL(url);
    fetchCalls.push({ market: parsed.searchParams.get("market"), offset: Number(parsed.searchParams.get("offset")) });
    const { status = 200, body = {}, headers = {} } = responder(parsed, fetchCalls.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.CRON_SECRET;
  delete process.env.SHARP_API_KEY;
});

async function refresh(market, client, authorization) {
  const res = createRes();
  await handleOddsRequest(refreshRequest(market, authorization), res, { client, now: NOW });
  return res;
}

async function readCore(client, now = NOW) {
  const res = createRes();
  await handleOddsRequest({ method: "GET", url: "/api/nfl/odds", headers: {} }, res, { client, now });
  return res;
}

const get = (client, market) => client.store.get(["nfl", 2026, WINDOW.week, market].join("|"));

test("moneyline refresh writes a snapshot", async () => {
  responder = () => ({ body: { data: moneylineRows } });
  const client = createFakeClient();
  const res = await refresh("moneyline", client);
  assert.equal(res.statusCode, 200);
  assert.equal(get(client, "moneyline").status, "ok");
  assert.equal(get(client, "moneyline").row_count, 2);
  assert.ok(get(client, "moneyline").fetched_at);
});

test("spread refresh writes a snapshot", async () => {
  responder = () => ({ body: { data: spreadRows } });
  const client = createFakeClient([snapshot("moneyline", moneylineRows)]);
  const res = await refresh("point_spread", client);
  assert.equal(res.body.status, "ok");
  assert.equal(get(client, "point_spread").row_count, 1);
});

test("total refresh writes a snapshot", async () => {
  responder = () => ({ body: { data: totalRows } });
  const client = createFakeClient([snapshot("moneyline", moneylineRows)]);
  const res = await refresh("total_points", client);
  assert.equal(res.body.status, "ok");
  assert.equal(get(client, "total_points").row_count, 1);
});

test("429 retains the last-known-good snapshot and records the cooldown", async () => {
  responder = () => ({ status: 429, body: { error: "slow down" }, headers: { "retry-after": "120" } });
  const previous = snapshot("total_points", totalRows);
  const client = createFakeClient([previous]);
  const res = await refresh("total_points", client);
  assert.equal(res.statusCode, 429);
  const stored = get(client, "total_points");
  assert.equal(stored.status, "rate_limited");
  assert.deepEqual(stored.rows, totalRows);
  assert.equal(stored.fetched_at, previous.fetched_at);
  assert.equal(new Date(stored.rate_limited_until).getTime(), NOW + 120000);
});

test("provider error retains the last-known-good snapshot", async () => {
  responder = () => ({ status: 500, body: { error: "boom" } });
  const previous = snapshot("point_spread", spreadRows);
  const client = createFakeClient([previous]);
  const res = await refresh("point_spread", client);
  assert.equal(res.statusCode, 502);
  const stored = get(client, "point_spread");
  assert.equal(stored.status, "error");
  assert.deepEqual(stored.rows, spreadRows);
  assert.equal(stored.fetched_at, previous.fetched_at);
});

test("empty provider response retains the last-known-good snapshot", async () => {
  responder = () => ({ body: { data: [] } });
  const previous = snapshot("moneyline", moneylineRows);
  const client = createFakeClient([previous]);
  const res = await refresh("moneyline", client);
  assert.equal(res.body.status, "empty");
  const stored = get(client, "moneyline");
  assert.equal(stored.status, "empty");
  assert.deepEqual(stored.rows, moneylineRows);
  assert.equal(stored.fetched_at, previous.fetched_at);
});

test("normal core request makes zero SharpAPI calls", async () => {
  const client = createFakeClient([
    snapshot("moneyline", moneylineRows),
    snapshot("point_spread", spreadRows),
    snapshot("total_points", totalRows),
  ]);
  await readCore(client);
  assert.equal(fetchCalls.length, 0);
});

test("three snapshots merge into the existing events format", async () => {
  const client = createFakeClient([
    snapshot("moneyline", moneylineRows),
    snapshot("point_spread", spreadRows),
    snapshot("total_points", totalRows),
  ]);
  const res = await readCore(client);
  assert.equal(res.body.cacheStatus, "fresh");
  assert.equal(res.body.count, 1);
  const [event] = res.body.events;
  assert.equal(event.home_team, "Home");
  const marketKeys = event.bookmakers[0].markets.map((market) => market.key).sort();
  assert.deepEqual(marketKeys, ["h2h", "spreads", "totals"]);
  assert.deepEqual(
    res.body.markets.map(({ market, status, stale }) => ({ market, status, stale })),
    [
      { market: "moneyline", status: "ok", stale: false },
      { market: "point_spread", status: "ok", stale: false },
      { market: "total_points", status: "ok", stale: false },
    ]
  );
  assert.match(res.headers["Vercel-CDN-Cache-Control"], /s-maxage=300/);
});

test("stale snapshot stays usable and reports stale-fallback", async () => {
  const old = new Date(NOW - 72 * 3600 * 1000).toISOString();
  const client = createFakeClient([
    snapshot("moneyline", moneylineRows, { fetched_at: old }),
    snapshot("point_spread", spreadRows),
    snapshot("total_points", totalRows),
  ]);
  const res = await readCore(client);
  assert.equal(res.body.cacheStatus, "stale-fallback");
  assert.equal(res.body.count, 1);
  assert.equal(res.body.markets.find((market) => market.market === "moneyline").stale, true);
  assert.equal(res.headers["Vercel-CDN-Cache-Control"], "no-store");
});

test("missing snapshots report unavailable", async () => {
  const res = await readCore(createFakeClient());
  assert.equal(res.body.cacheStatus, "unavailable");
  assert.equal(res.body.count, 0);
  assert.equal(fetchCalls.length, 0);
});

test("unauthorised refresh is rejected without provider calls", async () => {
  const client = createFakeClient();
  assert.equal((await refresh("moneyline", client, "Bearer wrong")).statusCode, 401);
  assert.equal((await refresh("moneyline", client, "")).statusCode, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await refresh("moneyline", client)).statusCode, 503);
  assert.equal(fetchCalls.length, 0);
  assert.equal(client.store.size, 0);
});

test("unsupported refresh market is rejected", async () => {
  const res = await   refresh("player_not_a_market", createFakeClient());
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
});

test("one refresh request fetches only one market", async () => {
  responder = () => ({ body: { data: moneylineRows } });
  const client = createFakeClient();
  await refresh("moneyline", client);
  assert.ok(fetchCalls.length > 0);
  assert.ok(fetchCalls.every((call) => call.market === "moneyline"));
  assert.equal(client.store.size, 1);
});

test("future-week odds do not force unnecessary pagination", async () => {
  const futureRows = [row({ event_id: "future", home_team: "F1", away_team: "F2", event_start_time: FUTURE_KICKOFF, market_type: "total_points", selection: "Over", line: 41 })];
  responder = (url) => {
    const offset = Number(url.searchParams.get("offset"));
    // The first page already covers the current-week target game.
    if (offset === 0) return { body: { data: totalRows, pagination: { has_more: true, next_offset: 500 } } };
    return { body: { data: futureRows } };
  };
  const client = createFakeClient([snapshot("moneyline", moneylineRows)]);
  const res = await refresh("total_points", client);
  assert.equal(res.body.providerRequests, 1);
  assert.equal(fetchCalls.length, 1);
});

test("spread paging continues past unwanted rows until every target game is covered", async () => {
  const halfRows = [row({ market_type: "point_spread", period: "first_half", line: -1.5 })];
  responder = (url) => {
    const offset = Number(url.searchParams.get("offset"));
    if (offset === 0) return { body: { data: halfRows, pagination: { has_more: true, next_offset: 500 } } };
    return { body: { data: spreadRows } };
  };
  const client = createFakeClient([snapshot("moneyline", moneylineRows)]);
  const res = await refresh("point_spread", client);
  assert.equal(res.body.providerRequests, 2);
  assert.deepEqual(get(client, "point_spread").rows, spreadRows);
});

const ROLL_NOW = NOW + 7 * 24 * 3600 * 1000;
const earlierWeek = WINDOW.week;
const rollSnapshot = (market, rows, extra = {}) =>
  snapshot(market, rows, { week: earlierWeek + 1, fetched_at: new Date(ROLL_NOW - 3600 * 1000).toISOString(), ...extra });
const finishedKickoff = new Date(ROLL_NOW - 3 * 24 * 3600 * 1000).toISOString();
const upcomingKickoff = new Date(ROLL_NOW + 3600 * 1000).toISOString();
const earlierSpreadRows = [
  row({ market_type: "point_spread", selection: "Home", line: -7, event_id: "old-finished", event_start_time: finishedKickoff }),
  row({ market_type: "point_spread", selection: "Home", line: -2.5, event_id: "still-relevant", event_start_time: upcomingKickoff }),
];

test("rollover: missing current spread falls back per market and reports stale", async () => {
  const client = createFakeClient([
    rollSnapshot("moneyline", moneylineRows),
    rollSnapshot("total_points", totalRows),
    snapshot("point_spread", earlierSpreadRows, { week: earlierWeek }),
  ]);
  const res = await readCore(client, ROLL_NOW);
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.body.cacheStatus, "stale-fallback");
  const spread = res.body.markets.find((market) => market.market === "point_spread");
  assert.deepEqual(
    { stale: spread.stale, fallback: spread.fallback, from: spread.fallbackFromWeek },
    { stale: true, fallback: true, from: earlierWeek }
  );
  assert.equal(res.body.markets.find((market) => market.market === "moneyline").stale, false);
  // Finished previous-week games are never carried into the new week.
  assert.equal(res.body.marketRecordCounts.point_spread, 1);
  assert.equal(res.headers["Vercel-CDN-Cache-Control"], "no-store");
});

test("rollover: earlier snapshot with only finished games is not a usable fallback", async () => {
  const client = createFakeClient([
    rollSnapshot("moneyline", moneylineRows),
    rollSnapshot("total_points", totalRows),
    snapshot("point_spread", [earlierSpreadRows[0]], { week: earlierWeek }),
  ]);
  const res = await readCore(client, ROLL_NOW);
  assert.equal(res.body.cacheStatus, "partial");
  assert.deepEqual(res.body.partialMarkets, ["point_spread"]);
});

test("rollover: each current-week snapshot replaces its fallback and status becomes fresh", async () => {
  const client = createFakeClient([
    rollSnapshot("moneyline", moneylineRows),
    rollSnapshot("total_points", totalRows),
    rollSnapshot("point_spread", spreadRows),
    snapshot("point_spread", earlierSpreadRows, { week: earlierWeek }),
  ]);
  const res = await readCore(client, ROLL_NOW);
  assert.equal(res.body.cacheStatus, "fresh");
  assert.ok(res.body.markets.every((market) => !market.fallback));
});

test("rollover: nothing at all reports unavailable with zero provider calls", async () => {
  const res = await readCore(createFakeClient());
  assert.equal(res.body.cacheStatus, "unavailable");
  assert.equal(fetchCalls.length, 0);
});

test("failed refresh keeps last-known-good: fresh inside the window, stale-fallback beyond it", async () => {
  const failed = { status: "rate_limited", last_error: "429" };
  const recent = createFakeClient([
    snapshot("moneyline", moneylineRows),
    snapshot("point_spread", spreadRows, failed),
    snapshot("total_points", totalRows),
  ]);
  const recentRes = await readCore(recent);
  assert.equal(recentRes.body.cacheStatus, "fresh");
  assert.equal(recentRes.body.markets.find((m) => m.market === "point_spread").status, "rate_limited");

  const old = new Date(NOW - 72 * 3600 * 1000).toISOString();
  const aged = createFakeClient([
    snapshot("moneyline", moneylineRows),
    snapshot("point_spread", spreadRows, { ...failed, fetched_at: old }),
    snapshot("total_points", totalRows),
  ]);
  assert.equal((await readCore(aged)).body.cacheStatus, "stale-fallback");
});
