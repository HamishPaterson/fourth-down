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
  const keyOf = (item) => [item.sport, item.season, item.week, item.market].join("|");
  for (const item of initial) store.set(keyOf(item), { ...item });
  return {
    store,
    from(table) {
      assert.equal(table, SNAPSHOT_TABLE);
      return {
        select() {
          const filters = [];
          const query = {
            eq(column, value) {
              filters.push((item) => item[column] === value);
              return query;
            },
            lt(column, value) {
              filters.push((item) => item[column] < value);
              return query;
            },
            then(resolve, reject) {
              const data = [...store.values()].filter((item) => filters.every((test) => test(item)));
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

function playerRow(marketType, overrides = {}) {
  const isTd = marketType.includes("anytime") || marketType === "anytime_touchdown";
  return {
    id: `${marketType}-${overrides.player_name || "Player One"}-${overrides.selection || "Over"}`,
    event_id: "e1",
    home_team: "Home",
    away_team: "Away",
    event_start_time: CURRENT_KICKOFF,
    sportsbook: "book",
    market_type: marketType,
    player_name: "Player One",
    selection: isTd ? "Yes" : "Over",
    selection_type: isTd ? undefined : "over",
    line: isTd ? undefined : 49.5,
    odds_american: -115,
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

function coreRow(marketType, overrides = {}) {
  return {
    id: `core-${marketType}-${overrides.selection || "Home"}`,
    event_id: "e1",
    home_team: "Home",
    away_team: "Away",
    event_start_time: CURRENT_KICKOFF,
    sportsbook: "book",
    market_type: marketType,
    selection: "Home",
    line: marketType === "moneyline" ? undefined : -3,
    odds_american: -110,
    ...overrides,
  };
}

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
    fetchCalls.push({ raw: String(url), market: parsed.searchParams.get("market"), offset: Number(parsed.searchParams.get("offset")) });
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

async function refresh(market, client) {
  const res = createRes();
  const req = {
    method: "GET",
    url: `/api/nfl/odds?refreshMarket=${market}`,
    headers: { authorization: `Bearer ${SECRET}` },
  };
  await handleOddsRequest(req, res, { client, now: NOW });
  return res;
}

async function read(url, client) {
  const res = createRes();
  await handleOddsRequest({ method: "GET", url, headers: {} }, res, { client, now: NOW });
  return res;
}

const stored = (client, market) => client.store.get(["nfl", 2026, WINDOW.week, market].join("|"));

// Provider market_type values that the existing getMarketKey maps to each canonical market.
const PROVIDER_TYPE = {
  player_pass_yds: "player_passing_yards",
  player_rush_yds: "player_rushing_yards",
  player_receptions: "player_receptions",
  player_reception_yds: "player_receiving_yards",
  player_pass_tds: "player_passing_touchdowns",
  player_pass_attempts: "player_passing_attempts",
  player_completions: "player_completions",
  player_rush_attempts: "player_rushing_attempts",
  player_rush_reception_yds: "player_rushing_+_receiving_yards",
};

const PLAYER_MARKETS = [
  "player_pass_yds",
  "player_rush_yds",
  "player_receptions",
  "player_reception_yds",
  "player_pass_tds",
  "player_pass_attempts",
  "player_completions",
  "player_rush_attempts",
  "player_rush_reception_yds",
];

for (const market of PLAYER_MARKETS) {
  test(`${market} refresh writes its own snapshot`, async () => {
    const rows = [playerRow(PROVIDER_TYPE[market])];
    responder = (url) => ([market, PROVIDER_TYPE[market]].includes(url.searchParams.get("market")) ? { body: { data: rows } } : { body: { data: [] } });
    const client = createFakeClient();
    const res = await refresh(market, client);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(stored(client, market).status, "ok");
    assert.equal(stored(client, market).row_count, 1);
    assert.ok(stored(client, market).fetched_at);
    assert.equal(client.store.size, 1);
  });
}

test("receiving yards requests the verified SharpAPI name and stores under the canonical market", async () => {
  responder = (url) =>
    url.searchParams.get("market") === "player_receiving_yards"
      ? { body: { data: [playerRow("player_receiving_yards")] } }
      : { body: { data: [] } };
  const client = createFakeClient();
  const res = await refresh("player_reception_yds", client);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.providerMarket, "player_receiving_yards");
  assert.deepEqual(fetchCalls.map((call) => call.market), ["player_receiving_yards"]);
  assert.equal(stored(client, "player_reception_yds").row_count, 1);
  assert.equal(client.store.size, 1);
});

test("rushing + receiving yards sends the literal + URL-encoded as %2B", async () => {
  responder = (url) =>
    url.searchParams.get("market") === "player_rushing_+_receiving_yards"
      ? { body: { data: [playerRow("player_rushing_+_receiving_yards")] } }
      : { body: { data: [] } };
  const client = createFakeClient();
  const res = await refresh("player_rush_reception_yds", client);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.providerMarket, "player_rushing_+_receiving_yards");
  assert.ok(fetchCalls.every((call) => call.raw.includes("market=player_rushing_%2B_receiving_yards")));
  assert.ok(fetchCalls.every((call) => !call.raw.includes("market=player_rushing_+")));
  assert.equal(stored(client, "player_rush_reception_yds").row_count, 1);
});
test("an alias is tried only when the previous name had no usable rows", async () => {
  responder = (url) =>
    url.searchParams.get("market") === "passing_yards"
      ? { body: { data: [playerRow(PROVIDER_TYPE.player_pass_yds)] } }
      : { body: { data: [] } };
  const client = createFakeClient();
  const res = await refresh("player_pass_yds", client);
  assert.equal(res.body.status, "ok");
  assert.deepEqual(fetchCalls.map((call) => call.market), ["player_pass_yds", "passing_yards"]);
});

test("one player refresh fetches only that market's provider names", async () => {
  responder = () => ({ body: { data: [] } });
  await refresh("player_rush_yds", createFakeClient());
  const allowed = new Set(["player_rush_yds", "rushing_yards", "player_rushing_yards"]);
  assert.ok(fetchCalls.length > 0);
  assert.ok(fetchCalls.every((call) => allowed.has(call.market)));
});

test("player refresh never fetches core markets and writes no core snapshot", async () => {
  responder = (url) => ({ body: { data: [playerRow(url.searchParams.get("market"))] } });
  const client = createFakeClient();
  await refresh("player_pass_tds", client);
  const core = new Set(["moneyline", "point_spread", "total_points"]);
  assert.ok(fetchCalls.every((call) => !core.has(call.market)));
  assert.deepEqual([...client.store.values()].map((item) => item.market), ["player_pass_tds"]);
});

test("core refresh never fetches player markets", async () => {
  responder = () => ({ body: { data: [coreRow("moneyline")] } });
  const client = createFakeClient();
  await refresh("moneyline", client);
  assert.ok(fetchCalls.length > 0);
  assert.ok(fetchCalls.every((call) => call.market === "moneyline"));
});

test("429 preserves the previous prop snapshot and stops immediately", async () => {
  responder = () => ({ status: 429, body: { error: "slow" }, headers: { "retry-after": "90" } });
  const previous = snapshot("player_pass_yds", [playerRow(PROVIDER_TYPE.player_pass_yds)]);
  const client = createFakeClient([previous]);
  const res = await refresh("player_pass_yds", client);
  assert.equal(res.statusCode, 429);
  assert.equal(fetchCalls.length, 1);
  const after = stored(client, "player_pass_yds");
  assert.equal(after.status, "rate_limited");
  assert.deepEqual(after.rows, previous.rows);
  assert.equal(after.fetched_at, previous.fetched_at);
  assert.equal(new Date(after.rate_limited_until).getTime(), NOW + 90000);
});

test("provider error preserves the previous prop snapshot and stops immediately", async () => {
  responder = () => ({ status: 500, body: { error: "boom" } });
  const previous = snapshot("player_receptions", [playerRow(PROVIDER_TYPE.player_receptions)]);
  const client = createFakeClient([previous]);
  const res = await refresh("player_receptions", client);
  assert.equal(res.statusCode, 502);
  assert.equal(fetchCalls.length, 1);
  const after = stored(client, "player_receptions");
  assert.equal(after.status, "error");
  assert.deepEqual(after.rows, previous.rows);
  assert.equal(after.fetched_at, previous.fetched_at);
});

test("empty response preserves the previous prop snapshot", async () => {
  const previous = snapshot("player_receptions", [playerRow(PROVIDER_TYPE.player_receptions)]);
  const client = createFakeClient([previous]);
  const res = await refresh("player_receptions", client);
  assert.equal(res.body.status, "empty");
  const after = stored(client, "player_receptions");
  assert.equal(after.status, "empty");
  assert.deepEqual(after.rows, previous.rows);
  assert.equal(after.fetched_at, previous.fetched_at);
});

test("future-week and half-game prop rows are not stored", async () => {
  const T = PROVIDER_TYPE.player_pass_yds;
  const wanted = playerRow(T);
  responder = () => ({
    body: {
      data: [
        wanted,
        playerRow(T, { id: "future", event_id: "e2", event_start_time: FUTURE_KICKOFF }),
        playerRow(T, { id: "half", period: "first_half" }),
        playerRow(T, { id: "alt", is_alternate_line: true }),
        playerRow(T, { id: "live", is_live: true }),
      ],
    },
  });
  const client = createFakeClient();
  await refresh("player_pass_yds", client);
  assert.deepEqual(stored(client, "player_pass_yds").rows.map((item) => item.id), [wanted.id]);
});

test("active cooldown causes zero SharpAPI calls", async () => {
  const previous = snapshot("player_pass_yds", [playerRow(PROVIDER_TYPE.player_pass_yds)], {
    status: "rate_limited",
    rate_limited_until: new Date(NOW + 600000).toISOString(),
  });
  const client = createFakeClient([previous]);
  const res = await refresh("player_pass_yds", client);
  assert.equal(res.body.status, "cooldown");
  assert.equal(res.statusCode, 429);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(stored(client, "player_pass_yds").rows, previous.rows);
});

test("snapshots stay isolated from one another", async () => {
  const core = snapshot("moneyline", [coreRow("moneyline")]);
  const other = snapshot("player_rush_yds", [playerRow(PROVIDER_TYPE.player_rush_yds)]);
  const client = createFakeClient([core, other]);
  responder = () => ({ status: 429, body: {} });
  await refresh("player_pass_yds", client);
  assert.deepEqual(stored(client, "moneyline"), core);
  assert.deepEqual(stored(client, "player_rush_yds"), other);
  responder = (url) => ({ body: { data: [playerRow(url.searchParams.get("market"))] } });
  await refresh("player_pass_yds", client);
  assert.deepEqual(stored(client, "moneyline"), core);
  assert.deepEqual(stored(client, "player_rush_yds"), other);
});

test("unsupported and core-style markets are validated, props never start from a core job", async () => {
  const res = await refresh("player_unknown", createFakeClient());
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
});

test("normal core read ignores player snapshots and makes zero SharpAPI calls", async () => {
  const client = createFakeClient([
    snapshot("moneyline", [coreRow("moneyline")]),
    snapshot("point_spread", [coreRow("point_spread")]),
    snapshot("total_points", [coreRow("total_points", { selection: "Over", selection_type: "over", line: 44.5 })]),
    snapshot("player_pass_yds", [playerRow(PROVIDER_TYPE.player_pass_yds)]),
  ]);
  const res = await read("/api/nfl/odds", client);
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.body.cacheStatus, "fresh");
  assert.equal(res.body.scope, "core");
  assert.equal(res.body.count, 1);
  assert.deepEqual(
    res.body.events[0].bookmakers[0].markets.map((market) => market.key).sort(),
    ["h2h", "spreads", "totals"]
  );
  assert.deepEqual(res.body.markets.map((market) => market.market).sort(), ["moneyline", "point_spread", "total_points"]);
});

test("?props=1&source=snapshot reads stored player snapshots with zero SharpAPI calls", async () => {
  const client = createFakeClient([
    snapshot("player_pass_yds", [playerRow(PROVIDER_TYPE.player_pass_yds)]),
    snapshot("player_receptions", [playerRow(PROVIDER_TYPE.player_receptions)]),
  ]);
  const res = await read("/api/nfl/odds?props=1&source=snapshot", client);
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.body.scope, "props");
  assert.equal(res.body.source, "snapshot");
  assert.equal(res.body.cacheStatus, "partial");
  assert.equal(res.body.count, 1);
  const keys = res.body.events[0].bookmakers[0].markets.map((market) => market.key).sort();
  assert.deepEqual(keys, ["player_pass_yds", "player_receptions"]);
  assert.equal(res.body.partialMarkets.length, 7);
});

test("player_anytime_td is not a snapshot market: refresh rejected, not required", async () => {
  const res = await refresh("player_anytime_td", createFakeClient());
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
  const read1 = await read("/api/nfl/odds?props=1&source=snapshot", createFakeClient());
  assert.ok(!JSON.stringify(read1.body.markets).includes("player_anytime_td"));
});

test("?props=1&source=snapshot reports unavailable with nothing stored and fresh when all are stored", async () => {
  const empty = await read("/api/nfl/odds?props=1&source=snapshot", createFakeClient());
  assert.equal(empty.body.cacheStatus, "unavailable");
  const full = createFakeClient(PLAYER_MARKETS.map((market) => snapshot(market, [playerRow(PROVIDER_TYPE[market])])));
  const res = await read("/api/nfl/odds?props=1&source=snapshot", full);
  assert.equal(res.body.cacheStatus, "fresh");
  assert.equal(fetchCalls.length, 0);
});

test("plain ?props=1 still uses the live provider path", async () => {
  await read("/api/nfl/odds?props=1", createFakeClient());
  assert.ok(fetchCalls.length > 0);
});
