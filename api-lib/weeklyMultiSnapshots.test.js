import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildWeeklyMultiSelection,
  createWeeklyMultiCurrentHandler,
  createWeeklyMultiLockHandler,
  getStoredOddsUrls,
  mergeStoredOdds,
  predictionSnapshotsForWeek,
  resolveLockWeekContext,
} from "./weeklyMulti.js";
import { activePersonnelRecord, personnelViewFixture } from "./personnelTestHelpers.js";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";

const THURSDAY = Date.UTC(2026, 9, 8, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const NOW = new Date(THURSDAY + 2 * 60 * 1000);
const QUOTE_AT = new Date(THURSDAY - 2 * HOUR).toISOString();
const CONTEXT = {
  available: true,
  eligible: true,
  season: 2026,
  week: 5,
  lockAt: new Date(THURSDAY).toISOString(),
  deadlineAt: new Date(THURSDAY + 30 * 60 * 1000).toISOString(),
  retryDeadline: THURSDAY + 30 * 60 * 1000,
  firstKickoffAt: new Date(THURSDAY + 3 * HOUR).toISOString(),
};

const bet = (market, selection, extra = {}) => ({
  category: "Game", market, selection, sportsbook: "BK",
  decimalOdds: ["Moneyline", "Anytime touchdown"].includes(market) ? 2 : 1.909,
  modelProbability: 0.7, updatedAt: QUOTE_AT, ...extra,
});
const book = (markets) => ({ key: "bk", title: "BK", last_update: QUOTE_AT, markets });
const ml = book([{ key: "h2h", outcomes: [{ name: "ARI", price: 100 }] }]);
const spread = book([{ key: "spreads", outcomes: [{ name: "BUF", point: -3.5, price: -110 }] }]);
const total = book([{ key: "totals", outcomes: [{ name: "Over", point: 44.5, price: -110 }] }]);
const passYds = book([{ key: "player_pass_yds", outcomes: [{ name: "Over", playerName: "Named Quarterback", point: 250.5, price: -110 }] }]);
const anytimeTd = book([{ key: "player_anytime_td", outcomes: [{ name: "Yes", playerName: "K. Walker", price: 100 }] }]);

const GAMES = [
  { away: "ARI", home: "LAR", id: "e1", bets: [bet("Moneyline", "ARI")], core: ml },
  { away: "BUF", home: "MIA", id: "e2", bets: [bet("Spread", "BUF", { line: -3.5 })], core: spread },
  { away: "DAL", home: "NYG", id: "e3", bets: [bet("Total", "Over", { line: 44.5 })], core: total },
  { away: "KC", home: "DEN", id: "e4", bets: [bet("player_pass_yds", "Named Quarterback Over 250.5 passing yards", {
    line: 250.5, category: "Player", playerId: "named-qb", personnelId: "named-qb", playerTeam: "KC",
  })], props: passYds },
  { away: "SEA", home: "SF", id: "e5", bets: [], core: anytimeTd, scorer: {
    source: "priced-market", market: "Anytime touchdown", selection: "K. Walker Yes",
    playerId: "td-player", personnelId: "td-player", playerTeam: "SEA", modelProbability: 0.7,
    decimalOdds: 2, sportsbook: "BK", updatedAt: QUOTE_AT,
  } },
];

function snapshotFor(game, overrides = {}) {
  const candidates = [...game.bets, ...(game.scorer ? [game.scorer] : [])];
  const records = { away: [], home: [] };
  for (const candidate of candidates) {
    const team = candidate.playerTeam || candidate.teamCode;
    const id = candidate.personnelId || candidate.playerId;
    if (!team || !id || ![game.away, game.home].includes(team)) continue;
    records[team === game.away ? "away" : "home"].push(activePersonnelRecord(id, team));
  }
  const cutoff = new Date(THURSDAY + 6 * HOUR).toISOString();
  const generatedAt = new Date(THURSDAY - HOUR).toISOString();
  return {
    season: 2026, week: 5, kickoff: new Date(THURSDAY + 3 * HOUR).toISOString(), awayCode: game.away, homeCode: game.home,
    modelVersion: CURRENT_MODEL_VERSION,
    modelKey: CURRENT_MODEL_KEY,
    fourthDownPick: game.away,
    fourthDownAwayScore: 24,
    fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: 0.6,
    fourthDownHomeWinProbability: 0.4,
    predictionPayload: {},
    generatedAt,
    playerProjections: { available: true },
    personnelViews: {
      away: personnelViewFixture(game.away, 2026, 5, cutoff, records.away),
      home: personnelViewFixture(game.home, 2026, 5, cutoff, records.home),
    },
    bestBets: { recommendations: game.bets, anytimeTdScorer: game.scorer },
    dataQuality: { sources: { odds: { available: true } } },
    ...overrides,
  };
}

function predictionRow(game) {
  return {
    season: 2026, week: 5, kickoff: new Date(THURSDAY + 3 * HOUR).toISOString(), away_code: game.away, home_code: game.home,
    fourth_down_pick: game.away, predicted_away_score: 24, predicted_home_score: 20, away_win_probability: 0.6, home_win_probability: 0.4,
    model_version: CURRENT_MODEL_VERSION, created_at: new Date(THURSDAY - HOUR).toISOString(),
    data_quality: {
      snapshot: {
        modelKey: CURRENT_MODEL_KEY, predictionPayload: {}, generatedAt: new Date(THURSDAY - HOUR).toISOString(),
        ...snapshotFor(game),
        bestBets: { recommendations: game.bets, anytimeTdScorer: game.scorer },
        dataQuality: { sources: { odds: { available: true } } },
      },
    },
  };
}

function oddsEvent(game, bookmaker) {
  return { id: game.id, away_team: game.away, home_team: game.home, bookmakers: bookmaker ? [bookmaker] : [] };
}

function storedPayloads(games = GAMES, status = { core: "fresh", props: "fresh" }) {
  return {
    core: { cacheStatus: status.core, refreshedAt: QUOTE_AT, events: games.map((game) => oddsEvent(game, game.core)) },
    props: { cacheStatus: status.props, refreshedAt: QUOTE_AT, events: games.filter((game) => game.props).map((game) => oddsEvent(game, game.props)) },
  };
}

function storedOddsFetch(payloads = storedPayloads(), urls = []) {
  return async (url) => {
    urls.push(String(url));
    return { ok: true, async json() { return String(url).includes("props=1") ? payloads.props : payloads.core; } };
  };
}

function response() {
  return { statusCode: null, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function lockClient({ existing = null, predictions = GAMES.map(predictionRow), insertError = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        calls.push(["from", table]);
        if (table === "weekly_best_multis") {
          return {
            select() { return this; }, eq() { return this; },
            async maybeSingle() { return { data: existing, error: null }; },
            insert(record) {
              calls.push(["insert", record]);
              return { select() { return this; }, async single() { return { data: insertError ? null : record, error: insertError }; } };
            },
          };
        }
        return { select() { return this; }, eq() { return this; }, then(resolve, reject) { return Promise.resolve({ data: predictions, error: null }).then(resolve, reject); } };
      },
    },
  };
}

async function runLock({ fetchOdds, database = lockClient(), now = NOW, context = CONTEXT }) {
  const original = { secret: process.env.CRON_SECRET, project: process.env.VERCEL_PROJECT_PRODUCTION_URL, url: process.env.VERCEL_URL, fetch: global.fetch };
  process.env.CRON_SECRET = "expected-secret";
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  let providerCalls = 0;
  global.fetch = async () => { providerCalls += 1; throw new Error("no direct network calls allowed"); };
  const handler = createWeeklyMultiLockHandler({ resolveContext: async () => context, getNow: () => now, createClient: () => database.client, fetchOdds });
  const res = response();
  try {
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret", host: "example.test" }, query: {} }, res);
  } finally {
    global.fetch = original.fetch;
    for (const [key, value] of [["CRON_SECRET", original.secret], ["VERCEL_PROJECT_PRODUCTION_URL", original.project], ["VERCEL_URL", original.url]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  return { res, database, providerCalls };
}

const inserts = (database) => database.calls.filter(([method]) => method === "insert");
const select = (games = GAMES, payloads = mergeStoredOdds(storedPayloads(games).core, storedPayloads(games).props), now = NOW) =>
  buildWeeklyMultiSelection(games.map((game) => snapshotFor(game)), payloads, CONTEXT, now);
const legFor = (selection, away) => selection.legs.find((leg) => leg.awayCode === away);

function selectTd(overrides = {}) {
  const game = {
    ...GAMES[4],
    scorer: { ...GAMES[4].scorer, ...overrides },
    core: Object.hasOwn(overrides, "core") ? overrides.core : anytimeTd,
  };
  return select([game]);
}

test("only the shared current model identity admits new snapshots and selection", () => {
  for (const [version, key, eligible] of [
    [CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY, true],
    [String(CURRENT_MODEL_VERSION), CURRENT_MODEL_KEY, true],
    [CURRENT_MODEL_VERSION, "wrong-key", false],
    [11, "full-v11-week5-data-gap-audit", false],
    [11, CURRENT_MODEL_KEY, false],
    [undefined, CURRENT_MODEL_KEY, false],
    [CURRENT_MODEL_VERSION, undefined, false],
    ["12garbage", CURRENT_MODEL_KEY, false],
    ["v12", CURRENT_MODEL_KEY, false],
    [[CURRENT_MODEL_VERSION], CURRENT_MODEL_KEY, false],
    [true, CURRENT_MODEL_KEY, false],
    [CURRENT_MODEL_VERSION + 1, CURRENT_MODEL_KEY, false],
  ]) {
    const snapshot = snapshotFor(GAMES[0], { modelVersion: version, modelKey: key });
    const row = predictionRow(GAMES[0]);
    row.model_version = version;
    Object.assign(row.data_quality.snapshot, { modelVersion: version, modelKey: key });
    assert.equal(predictionSnapshotsForWeek([row], CONTEXT, NOW).length, eligible ? 1 : 0,
      `snapshot version ${version}, key ${key}`);
    const selection = buildWeeklyMultiSelection([snapshot],
      mergeStoredOdds(storedPayloads().core, storedPayloads().props), CONTEXT, NOW);
    assert.equal(selection.legs.length, eligible ? 1 : 0, `selection version ${version}, key ${key}`);
    assert.equal(selection.reasonCounts.stalePrediction, eligible ? 0 : 1);
  }
});

test("snapshot kickoff must be strictly future; 24-hour prediction age is inclusive", () => {
  for (const [kickoffOffset, age, eligible] of [
    [1, 24 * HOUR, true],
    [1, 24 * HOUR - 1, true],
    [1, 24 * HOUR + 1, false],
    [0, HOUR, false],
    [-1, HOUR, false],
  ]) {
    const row = predictionRow(GAMES[0]);
    row.kickoff = new Date(NOW.getTime() + kickoffOffset).toISOString();
    row.data_quality.snapshot.generatedAt = new Date(NOW.getTime() - age).toISOString();
    assert.equal(predictionSnapshotsForWeek([row], CONTEXT, NOW).length, eligible ? 1 : 0);
  }
});

test("priced legs cannot use missing or invalid timestamps", () => {
  for (const updatedAt of [undefined, null, "", "invalid"]) {
    const snapshot = snapshotFor(GAMES[0]);
    snapshot.bestBets.recommendations = [{ ...GAMES[0].bets[0], updatedAt }];
    const result = buildWeeklyMultiSelection([snapshot],
      mergeStoredOdds(storedPayloads().core, storedPayloads().props), CONTEXT, NOW);
    assert.equal(result.legs.length, 0);
    assert.equal(result.reasonCounts.staleOdds, 1);
  }
});

test("existing locked Multis stay readable and immutable for legacy and current model identities", async () => {
  for (const [modelVersion, modelKey] of [
    [11, "full-v11-week5-data-gap-audit"],
    [CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY],
  ]) {
    const saved = {
      id: "bb998fce-9992-423a-8581-e14ce4e2a8b7",
      season: CONTEXT.season, week: CONTEXT.week, lock_at: CONTEXT.lockAt,
      modelVersion, modelKey, status: "locked", partial: false,
      legs: [{ awayCode: "ARI", homeCode: "LAR", market: "Moneyline", selection: "ARI", decimalOdds: 2 }],
    };
    const before = structuredClone(saved);
    const database = lockClient({ existing: saved });
    const lock = await runLock({
      database, fetchOdds: async () => assert.fail("A stored lock must not fetch odds"),
    });
    assert.equal(lock.res.body.status, "already locked");
    const res = response();
    await createWeeklyMultiCurrentHandler({
      createClient: () => database.client, getNow: () => NOW,
      fetchGames: async () => assert.fail("A stored lock must not fetch schedule"),
      resolveDisplayContext: async () => assert.fail("A stored lock must not be regenerated"),
    })({ method: "GET" }, res);
    assert.deepEqual(res.body.record, before);
    assert.deepEqual(saved, before);
    assert.equal(inserts(database).length, 0);
  }
});

test("stored core odds are read from the snapshot endpoints, merged with stored player props", () => {
  const urls = getStoredOddsUrls({ headers: { host: "example.test" } });
  assert.deepEqual(urls, { core: "https://example.test/api/nfl/odds", props: "https://example.test/api/nfl/odds?props=1&source=snapshot" });
  const merged = mergeStoredOdds(storedPayloads().core, storedPayloads().props);
  assert.equal(merged.cacheStatus, "fresh");
  assert.deepEqual(merged.events.find((event) => event.id === "e1").bookmakers[0].markets.map((market) => market.key), ["h2h"]);
  assert.deepEqual(merged.events.find((event) => event.id === "e4").bookmakers[0].markets.map((market) => market.key), ["player_pass_yds"]);
});

test("moneyline, spread, total, player prop and positively priced Anytime TD are selected", () => {
  const selection = select();
  assert.equal(selection.complete, true);
  assert.equal(selection.legs.length, 5);
  assert.equal(legFor(selection, "ARI").market, "Moneyline");
  assert.equal(legFor(selection, "BUF").market, "Spread");
  assert.equal(legFor(selection, "DAL").market, "Total");
  assert.equal(legFor(selection, "KC").market, "player_pass_yds");
  const td = legFor(selection, "SEA");
  assert.equal(td.modelOnly, undefined);
  assert.equal(td.decimalOdds, 2);
  assert.equal(td.modelProbability, 0.7);
  assert.equal(td.impliedProbability, 0.5);
  assert.ok(Math.abs(td.edge - 0.2) < 1e-12);
  assert.equal(td.selection, "K. Walker Yes");
});

test("model-only TD predictions without market odds are excluded", () => {
  const games = GAMES.map((game, index) => ({ ...game, bets: [], scorer: {
    source: "model-only", selection: `${game.away} Player anytime TD`, market: "Anytime touchdown",
    playerId: `${game.away}-td`, personnelId: `${game.away}-td`, playerTeam: game.away,
    modelProbability: .95 - index * .04, roleConfidence: index === 0 ? .6 : 1, decimalOdds: null,
  } }));
  const selected = select(games);
  assert.equal(selected.legs.length, 0);
  assert.equal(selected.partial, true);
  assert.equal(selected.threshold, .55);
});

test("a model-only TD with a null edge cannot enter selection", () => {
  const game = { ...GAMES[4], scorer: { ...GAMES[4].scorer, source: "model-only", decimalOdds: null, edge: null } };
  const result = select([game]);
  assert.equal(result.legs.length, 0);
});

test("zero, negative, NaN and non-finite calculated edges are rejected", () => {
  for (const modelProbability of [undefined, null, 0.5, 0.49, NaN, Infinity, -Infinity]) {
    assert.equal(selectTd({ modelProbability }).legs.length, 0, `model probability ${modelProbability}`);
  }
});

test("missing or invalid Anytime TD odds are rejected", () => {
  for (const decimalOdds of [undefined, null, NaN, Infinity, 1, 0, -2]) {
    assert.equal(selectTd({ decimalOdds }).legs.length, 0, `decimal odds ${decimalOdds}`);
  }
  assert.equal(selectTd({ core: null }).legs.length, 0);
});

test("a finite positive Anytime TD edge remains eligible above the probability threshold", () => {
  const selected = selectTd({ modelProbability: 0.7, decimalOdds: 2 });
  assert.equal(selected.legs.length, 1);
  assert.equal(selected.legs[0].modelProbability, 0.7);
  assert.equal(selected.legs[0].impliedProbability, 0.5);
  assert.ok(Math.abs(selected.legs[0].edge - 0.2) < 1e-12);
  assert.ok(Number.isFinite(selected.legs[0].edge) && selected.legs[0].edge > 0);
});

test("model-only TD predictions cannot enter selection through role confidence", () => {
  for (const roleConfidence of [undefined, null, 0, 1.1, NaN, .3]) {
    const game = { ...GAMES[4], scorer: { ...GAMES[4].scorer, source: "model-only", roleConfidence } };
    assert.equal(select([game]).legs.length, 0);
  }
});

test("priced candidates retain positive edge and remain deterministic without family quotas", () => {
  const games = GAMES.map((game) => ({ ...game, bets: [...game.bets] }));
  games[1].bets.unshift(bet("Moneyline", "BUF", { modelProbability: .8 }));
  games[1].core = book([...spread.markets, { key: "h2h", outcomes: [{ name: "BUF", price: 100 }] }]);
  const selected = select(games);
  assert.equal(selected.legs.length, 5);
  assert.equal(selected.legs.filter((l) => l.marketFamily === "anytime-td").length, 1);
  assert.ok(selected.legs.filter((l) => !l.modelOnly).every((l) => l.edge > 0));
  assert.deepEqual(select([...games].reverse()).legs, selected.legs);
  assert.equal(new Set(selected.legs.map((l) => l.matchupKey)).size, 5);
  games[2].bets[0] = bet("Total", "Over", { line: 44.5, modelProbability: .49 });
  assert.ok(!select(games).legs.some((l) => l.awayCode === "DAL"));
});

test("readable player markets match exact stored market, player, direction and line without broad Over matches", () => {
  const game = { ...GAMES[3], bets: [bet("Passing yards", "Named Quarterback Over 250.5 passing yards", {
    line: 250.5, category: "Passing props",
    playerId: "named-qb", personnelId: "named-qb", playerTeam: "KC",
  })], props: book([{ key: "player_pass_yds", outcomes: [
    { name: "Over", playerName: "Named Quarterback", point: 250.5, price: -110 },
  ] }]) };
  assert.equal(select([game]).legs.length, 1);
  for (const change of [
    { playerName: "Different Quarterback" }, { name: "Under" }, { point: 249.5 },
  ]) {
    const bad = structuredClone(game);
    Object.assign(bad.props.markets[0].outcomes[0], change);
    assert.equal(select([bad]).legs.length, 0);
  }
});

test("multiple Anytime TD offers, priced or unpriced, cannot consume more than one game", () => {
  const games = GAMES.map((g) => ({ ...g, bets: [], scorer: {
    ...GAMES[4].scorer, source: "model-only", selection: `${g.away} Player anytime TD`,
    playerId: `${g.away}-td`, personnelId: `${g.away}-td`, playerTeam: g.away,
  } }));
  games[0].bets = [bet("Anytime touchdown", "Named Player Yes", {
    modelProbability: .8, playerId: "named-player", personnelId: "named-player", playerTeam: "ARI",
  })];
  games[0].core = book([{ key: "player_anytime_td", outcomes: [{ name: "Yes", playerName: "Named Player", price: 100 }] }]);
  const result = select(games);
  assert.equal(result.legs.length, 1);
  assert.equal(result.legs[0].modelOnly, undefined);
});

test("the same Anytime TD player offered in two matchups cannot produce duplicate legs", () => {
  const first = GAMES[4];
  const second = {
    ...first, home: "LAR", id: "e6",
    scorer: { ...first.scorer, selection: "K. Walker Yes" },
  };
  const result = select([first, second]);
  const tdLegs = result.legs.filter((leg) => leg.marketFamily === "anytime-td");
  assert.equal(tdLegs.filter((leg) => leg.playerId === "td-player").length, 1);
  assert.equal(new Set(tdLegs.map((leg) => leg.playerId)).size, tdLegs.length);
});

test("explicitly contradictory moneyline candidates cannot both be selected", () => {
  const game = {
    ...GAMES[0],
    bets: [
      bet("Moneyline", "ARI", { modelProbability: 0.8 }),
      bet("Moneyline", "LAR", { modelProbability: 0.8 }),
    ],
    core: book([{ key: "h2h", outcomes: [{ name: "ARI", price: 100 }, { name: "LAR", price: 100 }] }]),
  };
  const result = select([game]);
  const moneylineSelections = result.legs
    .filter((leg) => leg.market === "Moneyline")
    .map((leg) => leg.selection);
  assert.equal(moneylineSelections.length, 1);
  assert.equal(moneylineSelections.includes("ARI") && moneylineSelections.includes("LAR"), false);
  assert.equal(new Set(result.legs.map((leg) => leg.matchupKey)).size, result.legs.length);
});

test("ranking is unchanged for priced candidates", () => {
  const games = [
    { ...GAMES[0], bets: [bet("Moneyline", "ARI", { decimalOdds: 2.2, modelProbability: 0.7 })],
      core: book([{ key: "h2h", outcomes: [{ name: "ARI", price: 120 }] }]) },
    { ...GAMES[1], bets: [bet("Spread", "BUF", { line: -3.5, decimalOdds: 2.0, modelProbability: 0.8 })],
      core: book([{ key: "spreads", outcomes: [{ name: "BUF", point: -3.5, price: 100 }] }]) },
    { ...GAMES[2], bets: [bet("Total", "Over", { line: 44.5, decimalOdds: 1.9, modelProbability: 0.9 })],
      core: book([{ key: "totals", outcomes: [{ name: "Over", point: 44.5, price: -111 }] }]) },
  ];
  const selection = select(games);
  assert.deepEqual(selection.legs.map((leg) => leg.awayCode), ["DAL", "BUF", "ARI"]);
  const mixed = select([GAMES[0], { ...GAMES[4], scorer: { ...GAMES[4].scorer, source: "model-only" } }]);
  assert.deepEqual(mixed.legs.map((leg) => leg.awayCode), ["ARI"]);
});

test("missing snapshot data never fabricates a leg", () => {
  const noOdds = buildWeeklyMultiSelection(GAMES.slice(0, 4).map((game) => snapshotFor(game)), null, CONTEXT, NOW);
  assert.equal(noOdds.legs.length, 0);
  const missingProps = select(GAMES, mergeStoredOdds(storedPayloads().core, { cacheStatus: "unavailable", events: [] }));
  assert.equal(legFor(missingProps, "KC"), undefined);
  const noTd = select([{ ...GAMES[4], scorer: { source: "unavailable", selection: "No eligible scorer projection", modelProbability: 0 } }]);
  assert.equal(noTd.legs.length, 0);
});

test("missing or unavailable snapshots are never combined into a fresh payload", () => {
  for (const status of [{ core: "fresh", props: "partial" }, { core: "fresh", props: "unavailable" }, { core: "stale-fallback", props: "fresh" }, { core: "partial", props: "fresh" }]) {
    const payloads = storedPayloads(GAMES, status);
    assert.notEqual(mergeStoredOdds(payloads.core, payloads.props).cacheStatus, "fresh");
  }
  assert.notEqual(mergeStoredOdds(undefined, undefined).cacheStatus, "fresh");
});

test("refresh and lock read only stored snapshots and make zero SharpAPI calls", async () => {
  const urls = [];
  const { res, database, providerCalls } = await runLock({ fetchOdds: storedOddsFetch(storedPayloads(), urls) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "locked");
  assert.equal(providerCalls, 0);
  assert.deepEqual(urls.sort(), ["https://example.test/api/nfl/odds", "https://example.test/api/nfl/odds?props=1&source=snapshot"]);
  assert.ok(urls.every((url) => !url.includes("weeklyMultiRefresh") && !url.includes("refreshMarket")));
  assert.equal(inserts(database).length, 1);
});

test("the lock persists moneyline, spread, total, player prop and priced Anytime TD legs", async () => {
  const { res, database } = await runLock({ fetchOdds: storedOddsFetch() });
  const record = inserts(database)[0][1];
  assert.equal(record.status, "locked");
  assert.equal(record.legs.length, 5);
  assert.deepEqual(record.legs.map((leg) => leg.market).sort(), ["Anytime touchdown", "Moneyline", "Spread", "Total", "player_pass_yds"]);
  const td = record.legs.find((leg) => leg.market === "Anytime touchdown");
  assert.equal(td.modelOnly, undefined);
  assert.equal(td.decimalOdds, 2);
  assert.equal(td.modelProbability, 0.7);
  assert.ok(Number.isFinite(td.edge) && td.edge > 0);
  assert.equal(record.lock_at, CONTEXT.lockAt);
  assert.equal(res.body.record.legs.length, 5);
});

test("incomplete stored odds before the deadline do not lock; unavailable props are not treated as fresh", async () => {
  const payloads = storedPayloads(GAMES, { core: "fresh", props: "unavailable" });
  const { res, database } = await runLock({ fetchOdds: storedOddsFetch(payloads) });
  assert.equal(res.body.status, "not ready");
  assert.equal(inserts(database).length, 0);
});

test("a locked multi cannot be changed by later odds, prediction or Best Bets changes", async () => {
  const existing = { season: 2026, week: 5, lock_at: CONTEXT.lockAt, status: "locked", legs: [{ market: "Moneyline", selection: "ARI", decimalOdds: 2, awayCode: "ARI", homeCode: "LAR" }] };
  const changedGames = GAMES.map((game) => ({ ...game, bets: [bet("Moneyline", game.away, { decimalOdds: 9, modelProbability: 0.99 })] }));
  for (const database of [lockClient({ existing }), lockClient({ existing, predictions: changedGames.map(predictionRow) })]) {
    let fetched = 0;
    const { res, providerCalls } = await runLock({
      database,
      now: new Date(THURSDAY + 10 * HOUR),
      fetchOdds: async () => { fetched += 1; throw new Error("locked multi must not re-read odds"); },
    });
    assert.equal(res.body.status, "already locked");
    assert.deepEqual(res.body.record, existing);
    assert.equal(fetched, 0);
    assert.equal(providerCalls, 0);
    assert.equal(inserts(database).length, 0);
  }
});

test("the lock only runs at the scheduled lock moment", async () => {
  const database = lockClient();
  const { res } = await runLock({
    database,
    context: { available: false, notYetLocked: true, lockAt: CONTEXT.lockAt, deadlineAt: CONTEXT.deadlineAt, reason: "The current lock moment has not arrived" },
    fetchOdds: async () => { throw new Error("must not read odds before the lock"); },
  });
  assert.equal(res.body.status, "not yet locked");
  assert.equal(inserts(database).length, 0);
});

test("mocked AEST clock locks at exactly 10:00, never 09:59, and remains eligible at 10:01", async () => {
  for (const minutes of [-1, 0, 1]) {
    const now = new Date(THURSDAY + minutes * 60000);
    const context = await resolveLockWeekContext(now, { fetchGames: async () => [
      { season: 2026, week: 5, date: CONTEXT.firstKickoffAt },
    ] });
    const { res, database } = await runLock({ now, context, fetchOdds: storedOddsFetch() });
    assert.equal(res.body.status, minutes < 0 ? "not yet locked" : "locked");
    assert.equal(inserts(database).length, minutes < 0 ? 0 : 1);
  }
});

test("old September snapshots cannot fabricate current-week legs; insufficient inputs are explicit", async () => {
  const predictions = GAMES.map(predictionRow).map((row) => ({
    ...row, model_version: 6,
    data_quality: { snapshot: { ...row.data_quality.snapshot, generatedAt: "2026-09-30T06:52:29.613Z" } },
  }));
  assert.equal(predictionSnapshotsForWeek(predictions, CONTEXT, NOW).length, 0);
  for (const minutes of [0, 30]) {
    const { res } = await runLock({
      database: lockClient({ predictions }), now: new Date(THURSDAY + minutes * 60000),
      fetchOdds: storedOddsFetch(),
    });
    assert.equal(res.body.status, minutes === 0 ? "not ready" : "generated late");
    if (minutes === 30) assert.equal(res.body.record.partial, true);
    assert.match(res.body.reason || res.body.record.reason, /No fresh, current-model complete saved predictions/);
    assert.equal(res.body.legCount ?? res.body.record.legs.length, 0);
  }
});

test("persistence failure is an explicit server error, not a successful lock", async () => {
  const original = console.error, logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const { res } = await runLock({
      database: lockClient({ insertError: { code: "storage-failure", message: "write failed" } }),
      fetchOdds: storedOddsFetch(),
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Weekly Best Multi lock failed" });
    assert.equal(logs[0][0], "Weekly Best Multi lock failed");
  } finally { console.error = original; }
});

test("two clients and refresh read the identical authoritative lock, unaffected by newer odds or an old week", async () => {
  const { res: locked, database } = await runLock({ fetchOdds: storedOddsFetch() });
  const saved = locked.body.record;
  const previous = { ...saved, week: 4, lock_at: new Date(THURSDAY - 7 * 24 * HOUR).toISOString() };
  let reads = 0;
  const createClient = () => ({
    from() {
      let lockAt;
      return { select() { return this; }, eq(column, value) { assert.equal(column, "lock_at"); lockAt = value; return this; },
        async maybeSingle() { reads++; return { data: [previous, saved].find((row) => row.lock_at === lockAt), error: null }; } };
    },
  });
  const results = [];
  for (let client = 0; client < 3; client++) {
    const res = response();
    await createWeeklyMultiCurrentHandler({
      createClient, getNow: () => new Date(THURSDAY + (client + 1) * 60000),
      resolveDisplayContext: async () => assert.fail("a stored lock must not be reconstructed"),
      fetchGames: async () => assert.fail("no schedule or odds needed for an unstarted stored lock"),
    })({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    results.push(res.body.record);
  }
  assert.equal(reads, 3);
  assert.equal(inserts(database).length, 1);
  assert.deepEqual(results, [saved, saved, saved]);
});

test("an unresolved locked multi survives week rollover and snapshot refreshes", async () => {
  const lockedAt = new Date(THURSDAY).toISOString();
  const saved = { season: 2026, week: 5, lock_at: lockedAt, status: "locked", partial: false, legs: [{ awayCode: "ARI", homeCode: "LAR", market: "Moneyline", selection: "ARI", decimalOdds: 2 }] };
  const writes = [];
  const readClient = () => ({
    from(table) {
      assert.equal(table, "weekly_best_multis");
      return { select() { return this; }, eq(column, value) { this.value = value; return this; }, async maybeSingle() { return { data: this.value === lockedAt ? saved : null, error: null }; }, insert() { writes.push("insert"); }, update() { writes.push("update"); }, delete() { writes.push("delete"); } };
    },
  });
  const read = async (now) => {
    const res = response();
    await createWeeklyMultiCurrentHandler({ createClient: readClient, getNow: () => new Date(now) })({ method: "GET", query: {} }, res);
    return res.body;
  };
  // Monday night and Tuesday of the next week are still inside the lock cycle.
  for (const at of [THURSDAY + 4 * 24 * HOUR, THURSDAY + 5 * 24 * HOUR + 23 * HOUR]) {
    const body = await read(at);
    assert.equal(body.locked, true);
    assert.deepEqual(body.record, saved);
  }
  assert.deepEqual(writes, []);
});

test("a new week's lock does not overwrite an unresolved previous-week record", async () => {
  const week = 7 * 24 * HOUR;
  const quoteAt = new Date(THURSDAY + week - 2 * HOUR).toISOString();
  const newWeekGames = GAMES.map((game) => ({
    ...game,
    bets: game.bets.map((entry) => ({ ...entry, updatedAt: quoteAt })),
    scorer: game.scorer ? { ...game.scorer, updatedAt: quoteAt } : game.scorer,
  }));
  const shifted = newWeekGames.map(predictionRow).map((row) => ({
    ...row, week: 6, kickoff: new Date(THURSDAY + week + 3 * HOUR).toISOString(),
    data_quality: { snapshot: { ...row.data_quality.snapshot, generatedAt: new Date(THURSDAY + week - HOUR).toISOString() } },
  }));
  const refreshed = storedPayloads();
  for (const payload of [refreshed.core, refreshed.props]) {
    payload.refreshedAt = quoteAt;
    for (const event of payload.events) for (const bookmaker of event.bookmakers) bookmaker.last_update = quoteAt;
  }
  const database = lockClient({ existing: null, predictions: shifted });
  const { res } = await runLock({
    database,
    fetchOdds: storedOddsFetch(refreshed),
    context: { ...CONTEXT, week: 6, lockAt: new Date(THURSDAY + 7 * 24 * HOUR).toISOString(), retryDeadline: THURSDAY + 7 * 24 * HOUR + 30 * 60 * 1000, firstKickoffAt: new Date(THURSDAY + 7 * 24 * HOUR + 3 * HOUR).toISOString() },
    now: new Date(THURSDAY + 7 * 24 * HOUR + 2 * 60 * 1000),
  });
  assert.equal(res.statusCode, 200);
  const writes = inserts(database);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].week, 6);
  assert.equal(database.calls.some(([method]) => ["update", "delete", "upsert"].includes(method)), false);
});

test("snapshot refresh code cannot write the Weekly Best Multi table", () => {
  const odds = readFileSync(new URL("../api/nfl/odds.js", import.meta.url), "utf8");
  const snapshots = readFileSync(new URL("./oddsSnapshots.js", import.meta.url), "utf8");
  assert.equal(/weekly_best_multis/.test(odds + snapshots), false);
  assert.equal(/weeklyMultiRefresh/.test(odds), false);
});

function loadGrader() {
  const source = readFileSync(new URL("../src/pages/Predictions.jsx", import.meta.url), "utf8");
  const pick = (name) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  };
  return new Function(`${["normalizeTeamCode", "hasFinalResult", "resolveSelectedTeam", "gradeWeeklyParlayLeg"].map(pick).join("\n")}\nreturn gradeWeeklyParlayLeg;`)();
}

test("locked legs settle to won (tick), lost (cross) or stay pending using the locked value", () => {
  const grade = loadGrader();
  const final = (away, home) => ({ actualWinner: away > home ? "ARI" : "LAR", actualAwayScore: away, actualHomeScore: home, awayCode: "ARI", homeCode: "LAR" });
  const moneyline = { market: "Moneyline", selection: "ARI", awayCode: "ARI", homeCode: "LAR" };
  const spreadLeg = { market: "Spread", selection: "ARI", line: -3.5, awayCode: "ARI", homeCode: "LAR" };
  const totalLeg = { market: "Total", selection: "Over", line: 44.5, awayCode: "ARI", homeCode: "LAR" };
  assert.equal(grade(moneyline, final(27, 20)), "won");
  assert.equal(grade(moneyline, final(17, 20)), "lost");
  assert.equal(grade(moneyline, { awayCode: "ARI", homeCode: "LAR" }), "pending");
  // Settlement uses the locked line, not a newer market value.
  assert.equal(grade(spreadLeg, final(24, 20)), "won");
  assert.equal(grade(spreadLeg, final(22, 20)), "lost");
  assert.equal(grade(totalLeg, final(27, 20)), "won");
  assert.equal(grade(totalLeg, final(20, 17)), "lost");
  assert.equal(grade({ ...spreadLeg, line: -3.5 }, { ...final(22, 20), line: 10, spread: 10 }), "lost");
  assert.equal(grade(totalLeg, { awayCode: "ARI", homeCode: "LAR" }), "pending");
});
