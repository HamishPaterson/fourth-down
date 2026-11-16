import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { applyPredictionSnapshot } from "../src/services/predictionSnapshot.js";
import { choosePredictionSnapshot, readPredictionLedger, savePredictionSnapshot } from "../src/services/predictionLedger.js";
import { fetchSharedPredictionLedger } from "../src/services/sharedPredictionLedger.js";
import { combinedDecimalOdds, formatAustralianOdds, usableDecimalOdds } from "../src/services/oddsDisplay.js";
import { createPredictionLedgerHandler, snapshotToDatabase } from "../api/nfl/game-stats.js";
import { createScheduleHandler } from "../api/nfl/schedule.js";
import { createWeeklyMultiCurrentHandler } from "./weeklyMulti.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { predictionFeatureFixture } from "./personnelTestHelpers.js";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import { resultGameKey } from "../src/services/gameResults.js";
import { getCurrentWeekWindow } from "../api/nfl/odds.js";
import { withApprovedUser } from "./authorization.js";

const saved = () => {
  const cutoff = "2030-10-16T00:15:00Z";
  const features = predictionFeatureFixture("SEA", "DEN", 2030, 6, cutoff);
  return ({
  id: "6:SEA:DEN:2030-10-16T00:15:00Z", season: 2030, week: 6,
  awayCode: "SEA", homeCode: "DEN", kickoff: "2030-10-16T00:15:00Z",
  modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
  predictionFeatureVersion: features.predictionFeatureVersion,
  opponentNetworkStatus: features.opponentNetworkStatus,
  personnelVersion: features.personnelVersion,
  personnelViews: features.personnelViews,
  fourthDownAwayScore: 21, fourthDownHomeScore: 19, fourthDownPick: "SEA",
  fourthDownAwayWinProbability: .585, fourthDownHomeWinProbability: .415, fourthDownWinnerProbability: .585,
  confidenceScore: .6, confidenceLabel: "Medium",
  bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, candidates: [], recommendations: [], assessed: 3 },
  playerProjections: { available: true },
  predictionPayload: { away: { code: "SEA", score: 22 }, home: { code: "DEN", score: 19 },
    total: 99, winner: "SEA", winnerWinProbability: .6, confidence: "Medium",
    modelLayers: { opponentNetwork: features.predictionPayloadFeatures.opponentNetwork },
    matchupIntelligence: features.predictionPayloadFeatures },
  dataQuality: { personnelTiming: { cutoff }, sources: {
    odds: { available: true }, opponentNetwork: { available: true },
  } },
  shared: true, authoritative: true,
  generatedAt: "2026-10-15T01:24:49.759Z", snapshotAt: "2026-10-15T01:24:49.759Z", updatedAt: "2026-10-15T01:25:30.904Z",
  });
};

for (const [name, value] of [["null", null], ["zero", 0], ["undefined", undefined], ["Infinity", Infinity], ["NaN", NaN]]) {
  test(`invalid ${name} odds never produce a monetary price or combined return`, () => {
    assert.equal(usableDecimalOdds(value), null);
    assert.equal(formatAustralianOdds(value), "Odds unavailable");
    assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: value }]), null);
    assert.equal(formatAustralianOdds(null, value), "Odds unavailable");
  });
}
test("finite priced legs combine; model-only and overflowing combinations stay pending", () => {
  assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: 1.5 }]), 3);
  assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: null, price: null }]), null);
  assert.equal(combinedDecimalOdds([{ decimalOdds: Number.MAX_VALUE }, { decimalOdds: 2 }]), null);
  assert.equal(formatAustralianOdds(null, -110), "$1.91");
  assert.equal(formatAustralianOdds(0, -110), "Odds unavailable");
  assert.equal(combinedDecimalOdds([]), null);
});

test("both views preserve saved identity/version/timestamps and use saved scores, not stale payload totals", () => {
  const snapshot = saved(), prediction = applyPredictionSnapshot(snapshot);
  assert.deepEqual([prediction.away.score, prediction.home.score, prediction.total], [21, 19, 40]);
  assert.equal(prediction.margin, 2);
  assert.equal(prediction.winner, "SEA");
  assert.equal(prediction.winnerWinProbability, .585);
  assert.equal(snapshot.id, saved().id);
  assert.equal(snapshot.modelVersion, CURRENT_MODEL_VERSION);
  assert.equal(snapshot.snapshotAt, saved().snapshotAt);
  assert.equal(snapshot.predictionPayload.total, 99);
});

test("complete shared predictions defeat newer partial/local data; richer current records replace incomplete ones", () => {
  const snapshot = saved();
  const local = { ...snapshot, shared: false, authoritative: false, fourthDownAwayScore: 22, updatedAt: "2026-10-15T02:00:00Z" };
  assert.equal(choosePredictionSnapshot(snapshot, local), snapshot);
  assert.equal(choosePredictionSnapshot(local, snapshot), snapshot);
  const partial = { ...local, bestBets: null };
  assert.equal(choosePredictionSnapshot(snapshot, partial), snapshot);
  assert.equal(choosePredictionSnapshot(partial, snapshot), snapshot);
  const old = { ...snapshot, modelVersion: 6 };
  assert.equal(choosePredictionSnapshot(old, snapshot), snapshot);
  const newer = { ...snapshot, updatedAt: "2026-10-15T02:00:00Z" };
  assert.equal(choosePredictionSnapshot(snapshot, newer), newer);
  assert.equal(choosePredictionSnapshot(newer, snapshot), newer);
});

test("a local Matchup save cannot overwrite a shared complete browser row or issue a duplicate write", () => {
  const originalWindow = global.window, originalFetch = global.fetch;
  const storage = new Map([["fourth-down:prediction-ledger:v1", JSON.stringify([saved()])]]);
  global.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  let writes = 0;
  global.fetch = async () => { writes++; throw new Error("Unexpected write"); };
  try {
    savePredictionSnapshot({ ...saved(), fourthDownAwayScore: 22, source: "matchup-full-model" });
    const row = readPredictionLedger().find((r) => r.id === saved().id);
    assert.equal(row.fourthDownAwayScore, 21);
    assert.equal(row.snapshotAt, saved().snapshotAt);
    assert.equal(writes, 0);
  } finally { global.window = originalWindow; global.fetch = originalFetch; }
});

test("shared-ledger refresh retains the action query and sends only a GET with valid season/week", async () => {
  const original = global.fetch;
  let requested;
  global.fetch = async (url, options) => {
    requested = { url, options };
    return { ok: true, text: async () => JSON.stringify({ snapshots: [saved()] }) };
  };
  try {
    const rows = await fetchSharedPredictionLedger({ season: 2026, week: 6 });
    const url = new URL(requested.url, "https://example.test");
    assert.equal(url.searchParams.get("action"), "predictions");
    assert.equal(url.searchParams.get("season"), "2026");
    assert.equal(url.searchParams.get("week"), "6");
    assert.equal(requested.options.body, undefined);
    assert.equal(rows[0].modelVersion, CURRENT_MODEL_VERSION);
  } finally { global.fetch = original; }
});

test("real ledger refresh repairs corrupted local scores at the same saved timestamp without posting a snapshot", async () => {
  const originalWindow = global.window, originalFetch = global.fetch;
  const corrupt = { ...saved(), fourthDownAwayScore: 22 };
  const storage = new Map([["fourth-down:prediction-ledger:v1", JSON.stringify([corrupt])]]);
  global.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ snapshots: [saved()] }) };
  };
  try {
    const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
    await ledger.refreshPredictionLedger({ season: 2030, week: 6 });
    await ledger.migrateLocalPredictionLedger();
    const row = readPredictionLedger().find((r) => r.id === saved().id);
    assert.equal(row.fourthDownAwayScore, 21);
    assert.equal(row.snapshotAt, saved().snapshotAt);
    assert.equal(row.modelVersion, CURRENT_MODEL_VERSION);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body, undefined);
  } finally { global.window = originalWindow; global.fetch = originalFetch; }
});

const resultFields = new Set(["actualAwayScore", "actualHomeScore", "actualWinner",
  "fourthDownCorrect", "oddsCorrect", "gradedAt", "resultUpdatedAt", "resultSource"]);
const predictionEvidence = (row) => Object.fromEntries(Object.entries(row)
  .filter(([key]) => !resultFields.has(key)));
const finalSnapshot = () => ({
  ...saved(), actualAwayScore: 27, actualHomeScore: 20, actualWinner: "SEA",
  fourthDownCorrect: true, oddsCorrect: false, gradedAt: "2030-10-17T01:00:00Z",
  resultUpdatedAt: "2030-10-17T01:00:00Z", resultSource: "verified-server",
});
function browserLedger(t, initial, remoteRows) {
  const priorWindow = global.window, calls = [];
  const storage = new Map([["fourth-down:prediction-ledger:v1", JSON.stringify(initial)]]);
  global.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  t.after(() => { global.window = priorWindow; });
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, undefined, "Reconciliation must never grade or save predictions");
    assert.equal(options.cache, "no-store");
    return { ok: true, text: async () => JSON.stringify({ snapshots: remoteRows() }) };
  });
  return { calls, cached: () => JSON.parse(storage.get("fourth-down:prediction-ledger:v1")) };
}

for (const state of ["stale final", "ungraded"]) {
  test(`refresh replaces ${state} local grading and prediction evidence with the shared snapshot`, async (t) => {
    const shared = finalSnapshot();
    const local = { ...shared, fourthDownAwayScore: 99, fourthDownHomeScore: 0,
      fourthDownAwayWinProbability: .99, fourthDownHomeWinProbability: .01,
      modelKey: "local-corruption", predictionPayload: { corrupted: true },
      bestBets: { corrupted: true }, anytimeTdScorer: { corrupted: true },
      personnelViews: { corrupted: true }, externalFactors2026: { corrupted: true },
      generatedAt: "2099-01-01", updatedAt: "2099-01-01", localOnlyEvidence: "must not leak",
      actualAwayScore: state === "stale final" ? 7 : null,
      actualHomeScore: state === "stale final" ? 35 : null,
      actualWinner: state === "stale final" ? "DEN" : null,
      fourthDownCorrect: false, oddsCorrect: true, gradedAt: "2099-01-01",
    };
    const { cached, calls } = browserLedger(t, [local], () => [shared]);
    const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
    const rows = await ledger.refreshPredictionLedger();
    assert.deepEqual(rows, [shared], "the network response wins even over cached shared flags and newer timestamps");
    assert.deepEqual(cached(), [shared], "existing storage self-heals without being cleared");
    assert.deepEqual(await ledger.refreshPredictionLedger(), rows);
    assert.deepEqual(cached(), rows);
    assert.equal(calls.length, 2);
  });
}

test("pending local final overlays only result fields until the shared persisted grade arrives", async (t) => {
  const shared = { ...saved(), oddsPick: "DEN", actualAwayScore: null, actualHomeScore: null,
    actualWinner: null, fourthDownCorrect: null, oddsCorrect: null, gradedAt: null };
  const local = { ...finalSnapshot(), shared: false, authoritative: false,
    awayCode: "DEN", homeCode: "SEA", actualAwayScore: 20, actualHomeScore: 27,
    fourthDownPick: "DEN", oddsPick: "SEA", fourthDownCorrect: false, oddsCorrect: true,
    predictionPayload: { corrupted: true }, bestBets: { corrupted: true },
    personnelViews: { corrupted: true }, generatedAt: "2099-01-01", localOnlyEvidence: true };
  let remote = shared;
  const { cached } = browserLedger(t, [local], () => [remote]);
  const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
  const [pending] = await ledger.refreshPredictionLedger();
  assert.deepEqual(predictionEvidence(pending), predictionEvidence(shared));
  assert.deepEqual([pending.actualAwayScore, pending.actualHomeScore, pending.actualWinner], [27, 20, "SEA"]);
  assert.equal(pending.fourthDownCorrect, true, "correctness uses the authoritative saved pick");
  assert.equal(pending.oddsCorrect, false);
  assert.equal(pending.resultSource, local.resultSource);
  assert.deepEqual(await ledger.refreshPredictionLedger(), [pending]);
  remote = { ...shared, actualAwayScore: 24, actualHomeScore: 30, actualWinner: "DEN",
    fourthDownCorrect: false, oddsCorrect: true, gradedAt: "2030-10-17T02:00:00Z" };
  assert.deepEqual(await ledger.refreshPredictionLedger(), [remote]);
  assert.deepEqual(cached(), [remote]);
  assert.deepEqual(await ledger.refreshPredictionLedger(), [remote]);
});

test("shared authority takes precedence over local finality when selecting snapshots", () => {
  const shared = saved(), local = { ...finalSnapshot(), shared: false, authoritative: false };
  assert.equal(choosePredictionSnapshot(local, shared), shared);
  assert.equal(choosePredictionSnapshot(shared, local), shared);
  const newer = { ...finalSnapshot(), updatedAt: "2030-10-17T02:00:00Z" };
  const stale = { ...finalSnapshot(), actualWinner: "DEN" };
  assert.equal(choosePredictionSnapshot(stale, newer), newer);
});

test("legacy browser finals cannot replace persisted shared results when the healed cache is read", async (t) => {
  const shared = { ...finalSnapshot(), id: "shared-week-two", season: 2026, week: 2,
    awayCode: "NO", homeCode: "BAL", actualAwayScore: 31, actualHomeScore: 28,
    actualWinner: "NO", fourthDownPick: "NO", oddsPick: "BAL",
    savedBeforeKickoff: false, resultSource: "persisted-correction" };
  browserLedger(t, [], () => [shared]);
  const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
  await ledger.refreshPredictionLedger();
  assert.deepEqual(ledger.readPredictionLedger().find((row) => row.id === shared.id), shared);
});

test("incomplete local scores do not become a temporary final on the authoritative shared row", async (t) => {
  const shared = { ...saved(), actualAwayScore: null, actualHomeScore: null, actualWinner: null };
  const local = { ...finalSnapshot(), actualAwayScore: null, shared: false };
  browserLedger(t, [local], () => [shared]);
  const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
  assert.deepEqual(await ledger.refreshPredictionLedger(), [shared]);
});

function response() {
  return {
    statusCode: 200, body: null, headers: {}, headersSent: false, responses: 0, lateHeaders: 0,
    setHeader(key, value) {
      if (this.headersSent) { this.lateHeaders++; throw new Error("Headers already sent"); }
      this.headers[key] = value;
    },
    status(code) { assert.equal(this.headersSent, false); this.statusCode = code; return this; },
    json(body) { assert.equal(this.headersSent, false); this.headersSent = true; this.responses++; this.body = body; return this; },
    end() { return this.json(null); },
  };
}
function database({ initial = [], error = null, throwError = false } = {}) {
  const rows = [...initial], writes = [];
  return {
    rows, writes,
    from() {
      const filters = [];
      let operation, payload;
      const execute = async (single = false) => {
        if (throwError) throw new Error("Unexpected storage failure");
        if (error) return { data: null, error };
        let found = rows.filter((r) => filters.every(([key, value]) => r[key] === value));
        if (operation === "insert") {
          const row = { ...payload, id: "database-id" };
          rows.push(row); writes.push(row); found = [row];
        }
        if (operation === "update") {
          found.forEach((row) => Object.assign(row, payload)); writes.push(payload);
        }
        return { data: single ? found[0] || null : found, error: null };
      };
      return {
        select() { return this; }, order() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        is(key, value) { filters.push([key, value]); return this; },
        insert(row) { operation = "insert"; payload = row; return this; },
        update(row) { operation = "update"; payload = row; return this; },
        maybeSingle() { return execute(true); }, single() { return execute(true); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
    },
  };
}
async function ledgerRequest(db, overrides = {}) {
  const res = response();
  await createPredictionLedgerHandler({ createClient: () => db })({
    method: "GET", query: {}, headers: { host: "example.test", origin: "https://example.test" }, ...overrides,
  }, res);
  assert.equal(res.responses, 1);
  assert.equal(res.lateHeaders, 0);
  return res;
}
test("ledger successful and not-found reads return HTTP 200 exactly once", async () => {
  for (const initial of [[], [snapshotToDatabase(saved())]]) {
    const res = await ledgerRequest(database({ initial }), { query: { season: "2030", week: "6" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.snapshots.length, initial.length);
  }
});

test("authenticated ledger GET and normal refresh expose all graded weeks and repair a stale browser cache", async (t) => {
  const counts = [19, 16, 16, 16, 15, 14, 14, 14, 15, 14];
  const matchups = [["SEA", "NE"], ["LAR", "SF"], ["DET", "NO"], ["CIN", "TB"],
    ["IND", "BAL"], ["JAX", "CLE"], ["TEN", "NYJ"], ["HOU", "BUF"],
    ["PIT", "ATL"], ["CAR", "CHI"], ["MIN", "GB"], ["LV", "MIA"],
    ["LAC", "ARI"], ["PHI", "WSH"], ["NYG", "DAL"], ["DEN", "KC"],
    ["NE", "CHI"], ["SEA", "DEN"], ["GB", "DET"]];
  const snapshots = counts.flatMap((count, i) => Array.from({ length: count }, (_, index) => {
    const week = i + 1;
    const [awayCode, homeCode] = week === 2 && index < 2
      ? [["NO", "BAL"], ["NYG", "LAR"]][index] : matchups[index];
    const graded = week !== 10 || index < 12;
    return { ...saved(), id: `2026:${week}:${awayCode}:${homeCode}`, season: 2026, week,
      awayCode, homeCode, fourthDownPick: awayCode, oddsPick: homeCode,
      kickoff: `2026-09-${String(week + 10).padStart(2, "0")}T17:00:00Z`,
      actualAwayScore: graded ? 27 : null, actualHomeScore: graded ? 20 : null,
      actualWinner: graded ? awayCode : null, fourthDownCorrect: graded ? true : null,
      oddsCorrect: graded ? false : null, gradedAt: graded ? "2026-11-16T03:00:00Z" : null };
  }));
  const db = database({ initial: snapshots.map((row) => snapshotToDatabase(row)) });
  let approved = true, lookups = 0;
  const route = withApprovedUser(createPredictionLedgerHandler({ createClient: () => db }), {
    createUserClient: (token) => {
      assert.equal(token, "approved-user-jwt");
      return {
        auth: { getUser: async () => ({ data: { user: { id: "own-user" } } }) },
        from: () => ({ select() { return this; }, eq() { return this; },
          maybeSingle: async () => {
            lookups++;
            return { data: { user_id: "own-user", approved } };
          } }),
      };
    },
  });
  const get = async () => {
    const res = response();
    await route({ method: "GET", headers: { authorization: "Bearer approved-user-jwt" }, query: {} }, res);
    return res;
  };
  const endpoint = await get();
  assert.equal(endpoint.statusCode, 200);
  assert.deepEqual(counts.map((_, i) => endpoint.body.snapshots
    .filter((row) => row.week === i + 1 && row.actualWinner).length),
  [19, 16, 16, 16, 15, 14, 14, 14, 15, 12]);
  assert.equal(endpoint.body.snapshots.filter((row) => row.week === 10 && !row.actualWinner).length, 2);
  for (const name of ["Cache-Control", "CDN-Cache-Control", "Vercel-CDN-Cache-Control"]) {
    assert.equal(endpoint.headers[name], "private, no-store");
  }
  assert.match(endpoint.headers.Vary, /Authorization/);
  const local = snapshots.filter((row) => [1, 2, 3, 5].includes(row.week)).slice(0, 49)
    .map((row) => ({ ...row, actualWinner: row.homeCode, actualAwayScore: 0, actualHomeScore: 99,
      fourthDownCorrect: false, oddsCorrect: true, predictionPayload: { stale: true } }));
  const { cached } = browserLedger(t, local, () => endpoint.body.snapshots);
  const ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
  const refreshed = await ledger.refreshPredictionLedger();
  assert.equal(refreshed.length, 153);
  assert.equal(refreshed.filter((row) => row.actualWinner).length, 151);
  assert.deepEqual(cached(), refreshed);
  const html = renderToStaticMarkup(createElement(Results));
  for (let week = 1; week <= 10; week++) {
    assert.ok(html.includes(`<option value="${week}">Week ${week}</option>`), `Missing week ${week}`);
  }
  assert.match(html, /Week 10/);
  assert.deepEqual(await ledger.refreshPredictionLedger(), refreshed);
  assert.deepEqual(cached(), refreshed);
  assert.deepEqual(db.writes, [], "GET and browser reconciliation must not write Supabase");
  approved = false;
  assert.equal((await get()).statusCode, 403);
  assert.equal(lookups, 2, "approval remains checked for each authenticated request");
});

test("completed display exclusions preserve saved Best Bets and skip all current-quote reads when only finals remain", async () => {
  const week = getCurrentWeekWindow().week;
  const snapshot = { ...saved(), season: 2026, week, kickoff: "2026-10-23T00:15Z" };
  const initial = [snapshotToDatabase(snapshot)];
  const before = structuredClone(initial);
  const db = database({ initial }), tables = [], originalFrom = db.from;
  db.from = (table) => { tables.push(table); assert.equal(table, "prediction_snapshots"); return originalFrom.call(db, table); };
  const res = await ledgerRequest(db, { query: { season: "2026", week: String(week), bets: "display",
    historicalGames: resultGameKey(snapshot) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.snapshots.length, 1);
  assert.deepEqual(res.body.snapshots[0].bestBets, snapshot.bestBets);
  assert.equal(res.body.snapshots[0].displayBestBetsAsOf, undefined);
  assert.deepEqual(tables, ["prediction_snapshots"]);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(initial, before);
});
test("ledger validation, persistence and unexpected errors send explicit JSON once", async () => {
  const invalid = await ledgerRequest(database(), { query: { week: "invalid" } });
  assert.equal(invalid.statusCode, 400);
  const missing = await ledgerRequest(database(), { method: "POST", body: { snapshots: [] } });
  assert.equal(missing.statusCode, 400);
  const invalidSave = await ledgerRequest(database(), { method: "POST", body: { snapshots: [{ ...saved(), week: 0 }] } });
  assert.equal(invalidSave.statusCode, 400);
  const failure = await ledgerRequest(database({ error: { message: "Persistence unavailable" } }));
  assert.equal(failure.statusCode, 500);
  const writeFailure = await ledgerRequest(database({ error: { message: "Persistence unavailable" } }), {
    method: "POST", body: { snapshots: [saved()] },
  });
  assert.equal(writeFailure.statusCode, 500);
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const thrown = await ledgerRequest(database({ throwError: true }));
    assert.equal(thrown.statusCode, 500);
    assert.deepEqual(logs, [["Prediction ledger request failed"]]);
  } finally { console.error = original; }
});
test("successful duplicate saves merge once; partial writes do not replace complete authoritative data", async () => {
  const incoming = { ...saved(), shared: false, authoritative: false };
  const db = database();
  const res = await ledgerRequest(db, { method: "POST", body: { snapshots: [incoming, incoming] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.saved.length, 1);
  assert.equal(db.writes.length, 1);
  const authoritative = database({ initial: [{ ...snapshotToDatabase(saved()), id: "server-id" }] });
  const partial = { ...incoming, bestBets: null, predictionPayload: null };
  const retained = await ledgerRequest(authoritative, { method: "POST", body: { snapshots: [partial] } });
  assert.equal(retained.statusCode, 200);
  assert.equal(retained.body.saved[0].fourthDownAwayScore, 21);
  assert.equal(authoritative.writes.length, 0);
});

test("Weekly Multi dispatcher never mutates headers after successful/not-found/error read responses", async () => {
  for (const outcome of ["stored", "missing", "error"]) {
    const record = { season: 2026, week: 6, legs: [], locked_at: "2026-10-15T01:46:28Z" };
    const handler = createScheduleHandler({ currentHandler: createWeeklyMultiCurrentHandler({
      getNow: () => new Date("2026-10-15T02:00:00Z"),
      createClient: () => ({ from: () => ({
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: outcome === "stored" ? record : null, error: outcome === "error" ? new Error("read failed") : null }),
      }) }),
      resolveDisplayContext: async () => ({ available: false, reason: "No current record" }),
    }) });
    const res = response(), original = console.error;
    console.error = () => {};
    try { await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res); }
    finally { console.error = original; }
    assert.equal(res.responses, 1);
    assert.equal(res.lateHeaders, 0);
    assert.equal(res.statusCode, outcome === "error" ? 500 : 200);
    assert.ok(res.headers["Cache-Control"]);
  }
});

let server, Matchup, PredictionCard, WeeklyParlay, Results;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "ledger-network-test-boundary", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/services/sharedPredictionLedger.js")) {
        return code.replace('import { apiFetch as fetch } from "./supabaseAuth.js";',
          "const fetch = (...args) => globalThis.fetch(...args);");
      }
    } }] });
  Matchup = (await server.ssrLoadModule("/src/components/MatchupPrediction.jsx")).default;
  const predictions = await server.ssrLoadModule("/src/pages/Predictions.jsx");
  PredictionCard = predictions.PredictionCard;
  WeeklyParlay = predictions.WeeklyParlay;
  Results = (await server.ssrLoadModule("/src/pages/Results.jsx")).default;
});
after(async () => { await server?.close(); });
test("actual Predictions and Matchup renders use the same saved score sum rather than the stale payload", () => {
  const snapshot = saved();
  const card = renderToStaticMarkup(createElement(PredictionCard, { prediction: snapshot }));
  const matchup = renderToStaticMarkup(createElement(Matchup, {
    awayCode: "SEA", homeCode: "DEN", week: 6, kickoff: snapshot.kickoff, savedPrediction: snapshot,
  }));
  assert.match(card, /Projected total 40/);
  assert.match(matchup, /Projected total 40/);
  assert.doesNotMatch(matchup, /Projected total (41|99)/);
  assert.doesNotMatch(matchup, /Scoring breakdown/);
  const source = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getFullGamePrediction|createOfficialSnapshot/);
  assert.match(source, /!hasActual \|\| !officialSnapshot/);
});

test("actual Multi render guards invalid individual/combined odds while preserving probability and ticks/crosses", () => {
  for (const invalid of [null, undefined, 0, Infinity, NaN]) {
    const legs = [
      { awayCode: "SEA", homeCode: "DEN", market: "Moneyline", selection: "SEA", decimalOdds: 2, result: "won" },
      { awayCode: "CHI", homeCode: "ATL", market: "Anytime touchdown", selection: "Named Player anytime TD", decimalOdds: invalid, price: null, result: "lost" },
    ];
    const markup = renderToStaticMarkup(createElement(WeeklyParlay, {
      parlay: { legs, decimalOdds: invalid, modelProbability: .4, modelProbabilityThreshold: .55, locked: true, partial: true },
      week: 6,
    }));
    assert.match(markup, /Odds unavailable/);
    assert.match(markup, /Pending/);
    assert.match(markup, /Model probability 40.0%/);
    assert.match(markup, /Successful leg/);
    assert.match(markup, /Failed leg/);
    assert.doesNotMatch(markup, /Infinity|NaN|\$0\.00/);
  }
});
