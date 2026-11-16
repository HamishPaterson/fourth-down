import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createPredictionLedgerHandler, normaliseSnapshot, snapshotToDatabase } from "../api/nfl/game-stats.js";
import { withApprovedUser } from "./authorization.js";

const gradeColumns = new Set(["actual_away_score", "actual_home_score", "actual_winner",
  "fourth_down_correct", "market_correct", "graded_at"]);
const pairs = [["NE", "CHI"], ["SEA", "DEN"], ["WAS", "NYG"], ["LA", "SF"],
  ["BAL", "PIT"], ["BUF", "MIA"], ["NYJ", "LV"], ["CLE", "CIN"],
  ["HOU", "IND"], ["JAX", "TEN"], ["KC", "LAC"], ["DAL", "PHI"],
  ["GB", "DET"], ["MIN", "ATL"], ["NO", "TB"], ["CAR", "ARI"],
  ["NE", "BUF"], ["SEA", "LAR"], ["CHI", "DET"]];

function snapshot(week = 4, index = 0) {
  const [awayCode, homeCode] = pairs[index];
  return {
    id: `2026:${week}:${awayCode}:${homeCode}`, season: 2026, week, awayCode, homeCode,
    kickoff: `2026-10-${String(week + 1).padStart(2, "0")}T17:00:00Z`,
    fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: .65, fourthDownHomeWinProbability: .35,
    fourthDownPick: awayCode, oddsPick: homeCode, generatedAt: "2026-09-01T00:00:00Z",
    modelVersion: "12", modelKey: "saved-model", authoritative: true,
    predictionPayload: { externalFactors2026: { unchanged: true }, score: [24, 20] },
    externalFactors2026: { unchanged: true }, bestBets: { candidates: [{ saved: true }] },
    anytimeTdScorer: { saved: true }, personnelViews: { saved: true },
    dataQuality: { QBR: { saved: true }, nflverse: { saved: true }, odds: { saved: true } },
    actualAwayScore: null, actualHomeScore: null, actualWinner: null,
  };
}
function dbRow(week = 4, index = 0) {
  const row = snapshotToDatabase(normaliseSnapshot(snapshot(week, index)));
  return { ...row, id: `db:${week}:${index}`, created_at: "2026-09-01T00:00:00Z" };
}
function finalGame(week = 4, index = 0) {
  const saved = snapshot(week, index);
  const alias = (code) => ({ WAS: "WSH", LA: "LAR" }[code] || code);
  return { season: 2026, week, date: saved.kickoff, status: "Final", completed: true,
    visitor_team: { abbreviation: alias(saved.awayCode) }, home_team: { abbreviation: alias(saved.homeCode) },
    visitor_team_score: 27 + index, home_team_score: 20 };
}
function database(initial) {
  const rows = structuredClone(initial), writes = [], reads = [];
  let fail = false, conflict = false;
  return {
    rows, writes, reads,
    failWrites() { fail = true; }, conflictWrites() { conflict = true; },
    from(table) {
      assert.equal(table, "prediction_snapshots");
      const filters = [];
      let patch;
      const execute = async (single = false) => {
        reads.push(filters);
        const found = rows.filter((row) => filters.every(([key, value, op]) =>
          op === "gte" ? row[key] >= value : op === "lte" ? row[key] <= value :
            (row[key] ?? null) === value));
        if (patch) {
          if (fail) return { data: null, error: { message: "Storage unavailable" } };
          if (conflict) return { data: null, error: null };
          for (const key of Object.keys(patch)) assert.ok(gradeColumns.has(key), `Non-grading write: ${key}`);
          found.forEach((row) => Object.assign(row, structuredClone(patch)));
          writes.push(structuredClone(patch));
        }
        return { data: single ? found[0] || null : found, error: null };
      };
      return {
        select() { return this; }, order() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        is(key, value) { filters.push([key, value]); return this; },
        gte(key, value) { filters.push([key, value, "gte"]); return this; },
        lte(key, value) { filters.push([key, value, "lte"]); return this; },
        update(value) { patch = value; return this; },
        maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
    },
  };
}
function response() {
  return { statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
const request = (results = [snapshot()]) => ({
  method: "POST", query: { mode: "grade" },
  headers: { host: "fourth-down.test", origin: "https://fourth-down.test" },
  body: { results },
});
const withoutGrades = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !gradeColumns.has(key)));

test("grading re-verifies finals, uses saved picks and writes only six result columns, idempotently", async () => {
  const db = database([dbRow()]), before = structuredClone(db.rows[0]);
  let resultReads = 0;
  const route = createPredictionLedgerHandler({ createClient: () => db,
    loadResults: async (season, week) => {
      resultReads++; assert.deepEqual([season, week], [2026, 4]); return [finalGame()];
    } });
  const forged = { ...snapshot(), actualAwayScore: 99, actualHomeScore: 0, actualWinner: "CHI",
    fourthDownPick: "CHI", oddsPick: "NE", fourthDownAwayScore: 100,
    predictionPayload: { changed: true }, generatedAt: "2099-01-01" };
  const res = response();
  await route(request([forged]), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.deepEqual([db.rows[0].actual_away_score, db.rows[0].actual_home_score, db.rows[0].actual_winner], [27, 20, "NE"]);
  assert.equal(db.rows[0].fourth_down_correct, true);
  assert.equal(db.rows[0].market_correct, false);
  assert.deepEqual(withoutGrades(db.rows[0]), withoutGrades(before));
  assert.deepEqual(db.rows[0].data_quality, before.data_quality);
  const saved = structuredClone(db.rows[0]), again = response();
  await route(request([forged]), again);
  assert.equal(again.body.count, 0);
  assert.equal(again.body.unchanged.length, 1);
  assert.equal(db.writes.length, 1);
  assert.equal(resultReads, 1);
  assert.deepEqual(db.rows[0], saved);
});

for (const [name, change] of [
  ...["Scheduled", "In Progress", "Halftime", "Delayed", "Postponed", "Incomplete", "Not Final"]
    .map((status) => [status, (game) => Object.assign(game, { status, completed: false })]),
  ...[null, undefined, "", "invalid", Infinity].map((score) =>
    [`invalid score ${String(score)}`, (game) => { game.visitor_team_score = score; }]),
]) {
  test(`server grading leaves ${name} pending despite browser-supplied scores`, async () => {
    const db = database([dbRow()]), game = finalGame(), before = structuredClone(db.rows);
    change(game);
    const res = response();
    await createPredictionLedgerHandler({ createClient: () => db, loadResults: async () => [game] })(
      request([{ ...snapshot(), actualAwayScore: 99, actualHomeScore: 0, actualWinner: "NE" }]), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pending.length, 1);
    assert.equal(res.body.count, 0);
    assert.deepEqual(db.rows, before);
    assert.equal(db.writes.length, 0);
  });
}

for (const [name, games] of [
  ["wrong season", [{ ...finalGame(), season: 2025 }]],
  ["wrong week", [{ ...finalGame(), week: 5 }]],
  ["reversed matchup", [{ ...finalGame(), visitor_team: { abbreviation: "CHI" }, home_team: { abbreviation: "NE" } }]],
  ["ambiguous duplicate", [finalGame(), finalGame()]],
]) test(`server grading rejects ${name} rather than misgrading saved evidence`, async () => {
  const db = database([dbRow()]), res = response();
  await createPredictionLedgerHandler({ createClient: () => db, loadResults: async () => games })(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.rejected.length, 1);
  assert.equal(db.writes.length, 0);
});

test("failed verified-results reads and concurrent prediction changes fail explicitly without writes", async () => {
  for (const unavailable of [true, false]) {
    const db = database([dbRow()]), before = structuredClone(db.rows), res = response();
    if (!unavailable) db.conflictWrites();
    await createPredictionLedgerHandler({ createClient: () => db, loadResults: async () => {
      if (unavailable) throw new Error("Schedule unavailable");
      return [finalGame()];
    } })(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.count, 0);
    assert.equal(res.body.rejected.length, 1);
    assert.deepEqual(db.rows, before);
  }
});

test("the production grader reads the existing schedule results path and never generates predictions or promotes incomplete status", async (t) => {
  const prior = process.env.BALLDONTLIE_API_KEY;
  process.env.BALLDONTLIE_API_KEY = "grading-schedule-test-key";
  t.after(() => {
    if (prior === undefined) delete process.env.BALLDONTLIE_API_KEY; else process.env.BALLDONTLIE_API_KEY = prior;
  });
  const requests = [];
  let final = true;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(options.cache, "no-store");
    if (url.hostname === "api.balldontlie.io") {
      assert.equal(url.searchParams.get("seasons[]"), "2026");
      assert.equal(url.searchParams.get("weeks[]"), "4");
      assert.ok(url.searchParams.has("refresh"));
      return Response.json({ data: [{ ...finalGame(), completed: final, status: final ? "Final" : "Incomplete" }], meta: {} });
    }
    assert.equal(url.hostname, "site.api.espn.com");
    assert.equal(url.searchParams.get("week"), "4");
    return Response.json({ events: [] });
  });
  for (const complete of [true, false]) {
    final = complete;
    const db = database([dbRow()]), res = response();
    await createPredictionLedgerHandler({ createClient: () => db })(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, complete ? 1 : 0);
    assert.equal(db.rows[0].actual_winner, complete ? "NE" : null);
    assert.equal(db.writes.length, complete ? 1 : 0);
  }
  assert.equal(requests.length, 4);
});

test("2026 Weeks 4-9 backfill is explicit, verified, grading-only and idempotent; Weeks 1-3/10 untouched", async (t) => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "grading-job-test";
  t.after(() => {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
  });
  const counts = [19, 16, 16, 16, 15, 14, 14, 14, 15, 14];
  const initial = counts.flatMap((count, i) => Array.from({ length: count }, (_, index) => {
    const row = dbRow(i + 1, index);
    if (i < 3 || (i === 4 && index === 0)) Object.assign(row, {
      actual_away_score: 27 + index, actual_home_score: 20, actual_winner: row.away_code,
      fourth_down_correct: true, market_correct: false, graded_at: "2026-10-01T00:00:00Z",
    });
    return row;
  }));
  const db = database(initial), readWeeks = [];
  const route = createPredictionLedgerHandler({ createClient: () => db, loadResults: async (season, week) => {
    assert.equal(season, 2026);
    assert.ok(week >= 4 && week <= 9);
    readWeeks.push(week);
    return Array.from({ length: counts[week - 1] }, (_, index) => finalGame(week, index));
  } });
  const req = (dryRun) => ({
    method: "POST", query: { mode: "backfill-grades", season: 2025, week: 10 },
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: { dryRun, results: [snapshot(10)] },
  });
  const preview = response();
  await route(req(true), preview);
  assert.equal(preview.body.count, 87);
  assert.equal(preview.body.unchanged.length, 1);
  assert.equal(preview.body.dryRun, true);
  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.rows, initial);
  const applied = response();
  await route(req(false), applied);
  assert.equal(applied.body.count, 87);
  assert.equal(applied.body.rejected.length, 0);
  assert.equal(applied.body.pending.length, 0);
  assert.deepEqual(db.rows.filter((row) => row.week <= 3 || row.week === 10),
    initial.filter((row) => row.week <= 3 || row.week === 10));
  assert.deepEqual(db.rows.map(withoutGrades), initial.map(withoutGrades));
  const after = structuredClone(db.rows), again = response();
  await route(req(false), again);
  assert.equal(again.body.count, 0);
  assert.equal(again.body.unchanged.length, 88);
  assert.equal(db.writes.length, 87);
  assert.deepEqual(db.rows, after);
  assert.deepEqual([...new Set(readWeeks)].sort(), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(counts.map((_, i) => db.rows.filter((row) => row.week === i + 1 && row.graded_at).length),
    [19, 16, 16, 16, 15, 14, 14, 14, 15, 0]);
});

test("backfill requires exact server authorization, POST and explicit dryRun; ordinary grade keeps same-origin checks", async (t) => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "grading-job-test";
  t.after(() => {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
  });
  const route = createPredictionLedgerHandler({ createClient: () => database([dbRow()]) });
  for (const authorization of [undefined, "Bearer user-jwt", "Bearer wrong-job-secret"]) {
    const res = response();
    await route({ method: "POST", query: { mode: "backfill-grades" }, headers: { authorization },
      body: { dryRun: false } }, res);
    assert.equal(res.statusCode, 401);
  }
  for (const [method, body, expected] of [["GET", {}, 405], ["POST", {}, 400],
    ["POST", { dryRun: "false" }, 400], ["POST", { dryRun: false, week: 10 }, 400],
    ["POST", { dryRun: false, week: 3 }, 400]]) {
    const res = response();
    await route({ method, query: { mode: "backfill-grades" },
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body }, res);
    assert.equal(res.statusCode, expected);
  }
  const crossOrigin = response();
  await route({ ...request(), headers: { host: "fourth-down.test", origin: "https://another.test" } }, crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);
});

test("a bounded single-week backfill cannot grade another week or non-final games", async (t) => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "grading-job-test";
  t.after(() => {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
  });
  const db = database([dbRow(4), dbRow(5), dbRow(10)]), before = structuredClone(db.rows);
  const game = { ...finalGame(4), status: "Scheduled", completed: false };
  const res = response();
  await createPredictionLedgerHandler({ createClient: () => db, loadResults: async (season, week) => {
    assert.deepEqual([season, week], [2026, 4]);
    return [game];
  } })({ method: "POST", query: { mode: "backfill-grades" },
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body: { dryRun: false, week: 4 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pending.length, 1);
  assert.equal(res.body.count, 0);
  assert.deepEqual(db.rows, before);
});

let server, ledger, results;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{
      name: "grading-test-boundaries",
      transform(code, id) {
        const file = id.replace(/\\/g, "/");
        if (file.endsWith("/src/services/sharedPredictionLedger.js") || file.endsWith("/src/pages/Results.jsx")) {
          code = code.replace(/import \{ apiFetch as fetch \} from "[^"]+supabaseAuth.js";/,
            "const fetch = (...args) => globalThis.gradingFetch(...args);");
        }
        if (file.endsWith("/src/pages/Results.jsx"))
          code += "\nexport { hydrateFinalScores, calculateWeeklyBreakdown };";
        return code;
      },
    }] });
  ledger = await server.ssrLoadModule("/src/services/predictionLedger.js");
  results = await server.ssrLoadModule("/src/pages/Results.jsx");
});
after(async () => { await server?.close(); });

test("verified Results hydration grades locally immediately and remotely through only the existing grade endpoint", async (t) => {
  const priorWindow = globalThis.window;
  const storage = new Map(), calls = [], db = database([dbRow()]);
  const original = structuredClone(db.rows[0]);
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  t.after(() => { globalThis.window = priorWindow; delete globalThis.gradingFetch; });
  let finishRemote;
  const waiting = new Promise((resolve) => { finishRemote = resolve; });
  const route = createPredictionLedgerHandler({ createClient: () => db, loadResults: async () => [finalGame()] });
  globalThis.gradingFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("/api/nfl/schedule")) return { ok: true, json: async () => ({ games: [finalGame()] }) };
    await waiting;
    const res = response();
    await route({ ...request(), body: JSON.parse(options.body) }, res);
    return { ok: res.statusCode === 200, text: async () => JSON.stringify(res.body) };
  };
  const [graded] = await results.hydrateFinalScores([snapshot()]);
  const done = ledger.saveGradedPredictions([graded]);
  const local = JSON.parse(storage.get("fourth-down:prediction-ledger:v1"));
  assert.equal(local[0].actualWinner, "NE");
  for (const [key, value] of Object.entries(snapshot())) {
    if (!["actualAwayScore", "actualHomeScore", "actualWinner"].includes(key)) {
      assert.deepEqual(local[0][key], value, `Local prediction evidence changed: ${key}`);
    }
  }
  assert.equal(db.rows[0].actual_winner, null);
  finishRemote();
  await done;
  assert.equal(db.rows[0].actual_winner, "NE");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /schedule.*results=1/);
  assert.match(calls[1].url, /action=predictions&mode=grade/);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(withoutGrades(db.rows[0]), withoutGrades(original));
  await ledger.saveGradedPredictions([graded]);
  assert.equal(db.writes.length, 1);
});

test("remote grading rejection retains immediate local finals and reports failure, without snapshot POSTs", async (t) => {
  const priorWindow = globalThis.window, storage = new Map(), warnings = [];
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  t.after(() => { globalThis.window = priorWindow; delete globalThis.gradingFetch; });
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  for (const failure of ["network", "partial", "pending", "server-write"]) {
    const db = database([dbRow()]);
    db.failWrites();
    globalThis.gradingFetch = async (url, options) => {
      assert.match(url, /mode=grade/);
      if (failure === "network") throw new Error("Offline");
      if (failure === "server-write") {
        const res = response();
        await createPredictionLedgerHandler({ createClient: () => db, loadResults: async () => [finalGame()] })(
          { ...request(), body: JSON.parse(options.body) }, res);
        assert.equal(res.statusCode, 500);
        return { ok: false, status: 500, text: async () => JSON.stringify(res.body) };
      }
      if (failure === "pending") return { ok: true, text: async () => JSON.stringify({ pending: [snapshot()] }) };
      return { ok: true, text: async () => JSON.stringify({ rejected: [{ reason: "Write failed" }] }) };
    };
    await ledger.saveGradedPredictions([{ ...snapshot(), actualAwayScore: 27, actualHomeScore: 20, actualWinner: "NE" }]);
    assert.equal(JSON.parse(storage.get("fourth-down:prediction-ledger:v1"))[0].actualWinner, "NE");
  }
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every(([message]) => /local results retained/.test(message)));
});

test("Results hydrates only verified finals and weekly breakdown dynamically includes future graded weeks", async (t) => {
  t.after(() => { delete globalThis.gradingFetch; });
  let week10Final = false;
  globalThis.gradingFetch = async (url) => {
    const week = Number(new URL(url, "https://fourth-down.test").searchParams.get("week"));
    const game = finalGame(week);
    if (week === 10 && !week10Final) Object.assign(game, { status: "In Progress", completed: false });
    return { ok: true, json: async () => ({ games: [game] }) };
  };
  const rows = await results.hydrateFinalScores(Array.from({ length: 12 }, (_, i) => snapshot(i + 1)));
  assert.equal(rows.find((row) => row.week === 10).actualWinner, null);
  const graded = rows.filter((row) => row.actualWinner);
  assert.deepEqual(results.calculateWeeklyBreakdown(graded).map((row) => row.week), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
  assert.ok(results.calculateWeeklyBreakdown(graded).every((row) => row.record.correct === 1));
  week10Final = true;
  const later = await results.hydrateFinalScores(rows);
  assert.deepEqual(results.calculateWeeklyBreakdown(later).map((row) => row.week),
    Array.from({ length: 12 }, (_, i) => i + 1));
});

test("future Week 10 and 11 finals persist through the unchanged Results-to-ledger workflow", async (t) => {
  const priorWindow = globalThis.window, storage = new Map(), db = database([dbRow(10), dbRow(11)]);
  const before = structuredClone(db.rows);
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  t.after(() => { globalThis.window = priorWindow; delete globalThis.gradingFetch; });
  let finalsAvailable = false;
  const gameFor = (week) => ({ ...finalGame(week),
    completed: finalsAvailable, status: finalsAvailable ? "Final" : "In Progress" });
  const route = createPredictionLedgerHandler({ createClient: () => db,
    loadResults: async (_season, week) => [gameFor(week)] });
  globalThis.gradingFetch = async (url, options) => {
    if (url.startsWith("/api/nfl/schedule")) {
      const week = Number(new URL(url, "https://fourth-down.test").searchParams.get("week"));
      return { ok: true, json: async () => ({ games: [gameFor(week)] }) };
    }
    const res = response();
    await route({ ...request(), body: JSON.parse(options.body) }, res);
    return { ok: res.statusCode === 200, text: async () => JSON.stringify(res.body) };
  };
  const pending = await results.hydrateFinalScores([snapshot(10), snapshot(11)]);
  await ledger.saveGradedPredictions(pending.filter((row) => row.actualWinner));
  assert.equal(db.writes.length, 0);
  finalsAvailable = true;
  const graded = await results.hydrateFinalScores(pending);
  await ledger.saveGradedPredictions(graded.filter((row) => row.actualWinner));
  assert.equal(db.writes.length, 2);
  assert.ok(db.rows.every((row) => row.actual_winner === "NE" && row.graded_at));
  assert.deepEqual(db.rows.map(withoutGrades), before.map(withoutGrades));
  assert.deepEqual(results.calculateWeeklyBreakdown(ledger.readPredictionLedger())
    .map((row) => row.week).filter((week) => week >= 10), [10, 11]);
});

test("grading remains behind JWT approval and CRON server authorization without shared caching", async (t) => {
  const db = database([dbRow()]);
  let approved = false;
  const route = withApprovedUser(createPredictionLedgerHandler({
    createClient: () => db, loadResults: async () => [finalGame()],
  }), { createUserClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user" } }, error: null }) },
    from: () => ({ select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: { user_id: "user", approved }, error: null }) }),
  }) });
  for (const [authorization, approval, status] of [[undefined, false, 401],
    ["Bearer user-jwt", false, 403], ["Bearer user-jwt", true, 200]]) {
    approved = approval;
    const res = response(), req = request();
    await route({ ...req, headers: { ...req.headers, authorization } }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
    if (status !== 200) assert.equal(db.writes.length, 0);
  }
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "grading-job-test";
  t.after(() => {
    if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior;
  });
  const cron = response();
  await route({ method: "POST", query: { mode: "backfill-grades" },
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body: { dryRun: false } }, cron);
  assert.equal(cron.statusCode, 200);
  assert.equal(cron.body.unchanged.length, 1);
});
