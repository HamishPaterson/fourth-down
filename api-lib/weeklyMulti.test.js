import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWeeklyMultiCurrentHandler, createWeeklyMultiLockHandler, fetchScheduleGamesForWindow, getDisplayLockCycle, getLockCycle, resolveDisplayWeekContext, resolveLockWeekContext, WEEKLY_MULTI_TIME_ZONE } from "./weeklyMulti.js";
import { createScheduleHandler } from "../api/nfl/schedule.js";

const THURSDAY = Date.UTC(2026, 9, 8, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function date(offset, hours = 0, minutes = 0) {
  return new Date(THURSDAY + offset * DAY + hours * 60 * 60 * 1000 + minutes * 60 * 1000);
}

function scheduleGame(id, season, week, kickoffAt, postseason = false) {
  return {
    id,
    season,
    week,
    date: new Date(kickoffAt).toISOString(),
    status: "scheduled",
    postseason,
    home_team: { id: id * 2, abbreviation: "HOM", full_name: "Home Team" },
    visitor_team: { id: id * 2 + 1, abbreviation: "AWY", full_name: "Away Team" },
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createLockClient({ existing = null, predictions = [] } = {}) {
  const calls = [];
  let insertedRecord = null;
  const client = {
    from(table) {
      calls.push(["from", table]);
      if (table === "weekly_best_multis") {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: existing, error: null }; },
          insert(record) {
            calls.push(["insert", record]);
            insertedRecord = record;
            return {
              select() { return this; },
              async single() { return { data: record, error: null }; },
            };
          },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: predictions, error: null }).then(resolve, reject); },
      };
    },
  };
  return { client, calls, get insertedRecord() { return insertedRecord; } };
}

function createCurrentEntry(overrides = {}) {
  return createScheduleHandler({ currentHandler: createWeeklyMultiCurrentHandler(overrides) });
}

function createLockEntry(overrides = {}) {
  return createScheduleHandler({ lockHandler: createWeeklyMultiLockHandler(overrides) });
}

test("schedule entry preserves existing schedule behavior without weeklyMultiMode", async () => {
  const originalApiKey = process.env.BALLDONTLIE_API_KEY;
  delete process.env.BALLDONTLIE_API_KEY;
  const handler = createScheduleHandler({
    currentHandler: async () => assert.fail("current handler must not run without the mode parameter"),
    lockHandler: async () => assert.fail("lock handler must not run without the mode parameter"),
  });

test("dispatcher caches successful current responses for 120 seconds", async () => {
  const handler = createScheduleHandler({
    currentHandler: async (req, res) => res.status(200).json({ status: "locked" }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.headers["Cache-Control"], "public, s-maxage=120, stale-while-revalidate=120");
});

test("dispatcher caches not-ready and error current responses for no more than 30 seconds", async () => {
  for (const [status, body] of [[200, { status: "not ready" }], [500, { error: "failed" }]]) {
    const handler = createScheduleHandler({
      currentHandler: async (req, res) => res.status(status).json(body),
    });
    const res = response();
    await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
    assert.equal(res.headers["Cache-Control"], "public, s-maxage=30, stale-while-revalidate=30");
  }
});

test("dispatcher does not add Weekly Best Multi cache headers to lock or no-mode schedule paths", async () => {
  const lockHandler = createScheduleHandler({
    lockHandler: async (req, res) => res.status(200).json({ status: "locked" }),
  });
  const lockResponse = response();
  await lockHandler({ method: "GET", query: { weeklyMultiMode: "lock" } }, lockResponse);
  assert.equal(lockResponse.headers["Cache-Control"], undefined);

  const scheduleHandler = createScheduleHandler({
    scheduleHandler: async (req, res) => res.status(200).json({ schedule: true }),
  });
  const scheduleResponse = response();
  await scheduleHandler({ method: "GET", query: { season: 2026, week: 5 } }, scheduleResponse);
  assert.equal(scheduleResponse.headers["Cache-Control"], undefined);
});

test("read route returns the current lock record at Tue 23:59 without provider lookup", async () => {
  const expectedLockAt = THURSDAY - 7 * DAY;
  const expectedLockDate = new Date(expectedLockAt);
  assert.equal(expectedLockDate.getUTCDay(), 4);
  assert.equal(expectedLockDate.getUTCHours(), 0);
  assert.equal(expectedLockDate.getUTCMinutes(), 0);
  const record = { season: 2026, week: 4, lock_at: expectedLockDate.toISOString() };
  let providerCalls = 0;
  const handler = createCurrentEntry({
    getNow: () => date(-2, 23, 59),
    fetchGames: async () => { providerCalls += 1; return []; },
    createClient: () => ({
      from: () => ({
        select() { return this; },
        eq(column, value) { assert.equal(column, "lock_at"); assert.equal(value, expectedLockDate.toISOString()); return this; },
        async maybeSingle() { return { data: record, error: null }; },
      }),
    }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.record, record);
  assert.equal(providerCalls, 0);
});

test("read route resolves the placeholder week at Wed 00:00 when the previous multi has no unsettled legs", async () => {
  const previousRecord = { season: 2026, week: 4, lock_at: new Date(THURSDAY - DAY).toISOString() };
  let providerCalls = 0;
  const handler = createCurrentEntry({
    getNow: () => date(-1),
    fetchGames: async () => {
      providerCalls += 1;
      return [{ season: 2026, week: 5, date: date(0, 1).toISOString(), postseason: false }];
    },
    createClient: () => ({
      from: () => ({
        select() { return this; },
        eq(column, value) {
          assert.equal(column, "lock_at");
          assert.equal(value, new Date(THURSDAY - 7 * DAY).toISOString());
          return this;
        },
        async maybeSingle() { return { data: null, error: null }; },
      }),
    }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "before lock");
  assert.equal(res.body.week, 5);
  assert.notEqual(res.body.record, previousRecord);
  assert.equal(providerCalls, 1);
});
  const res = response();
  try {
    await handler({ method: "GET", query: { season: 2026, week: 5 } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "BALLDONTLIE_API_KEY is not configured" });
  } finally {
    if (originalApiKey === undefined) delete process.env.BALLDONTLIE_API_KEY;
    else process.env.BALLDONTLIE_API_KEY = originalApiKey;
  }
});

test("lock-mode dispatch passes the GET request and Authorization header through unchanged", async () => {
  const request = {
    method: "GET",
    query: { weeklyMultiMode: "lock" },
    headers: { authorization: "Bearer test-only-forwarded-token" },
  };
  let received;
  const handler = createScheduleHandler({
    lockHandler: async (req, res) => {
      received = req;
      return res.status(200).json({ status: "dispatched" });
    },
  });
  const res = response();
  await handler(request, res);
  assert.strictEqual(received, request);
  assert.equal(received.headers.authorization, "Bearer test-only-forwarded-token");
  assert.equal(res.statusCode, 200);
});

test("unknown weeklyMultiMode values cannot fall through to the schedule route", async () => {
  const handler = createScheduleHandler({
    currentHandler: async () => assert.fail("unknown mode must not invoke current"),
    lockHandler: async () => assert.fail("unknown mode must not invoke lock"),
    scheduleHandler: async () => assert.fail("unknown mode must not invoke schedule"),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "unexpected" } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Unknown weekly multi mode" });
});

test("Vercel rewrites preserve Weekly Multi URLs with on-time locking and deadline finalization", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rewrites, [
    { source: "/api/weekly-multi/current", destination: "/api/nfl/schedule?weeklyMultiMode=current" },
    { source: "/api/weekly-multi/lock", destination: "/api/nfl/schedule?weeklyMultiMode=lock" },
    { source: "/api/weekly-multi/prepare", destination: "/api/nfl/schedule?weeklyMultiMode=prepare" },
  ]);
  const lockCrons = config.crons.filter((cron) => cron.path === "/api/weekly-multi/lock");
  assert.deepEqual(lockCrons, [
    { path: "/api/weekly-multi/lock", schedule: "0 0 * * *" },
    { path: "/api/weekly-multi/lock", schedule: "0 1 * * *" },
  ]);
});

test("configured AEST lock is 10:00 on Thursday, including daylight-saving season", () => {
  for (const day of ["2026-10-15", "2027-01-07", "2026-06-04"]) {
    const lock = new Date(`${day}T00:00:00Z`);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", {
      timeZone: WEEKLY_MULTI_TIME_ZONE, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(lock).map(({ type, value }) => [type, value]));
    assert.equal(parts.weekday, "Thursday");
    assert.equal(parts.hour, "10");
    assert.equal(parts.minute, "00");
    assert.equal(getLockCycle(new Date(lock.getTime() - 60000)).eligible, false);
    assert.equal(getLockCycle(lock).eligible, true);
    assert.equal(getLockCycle(new Date(lock.getTime() + 60000)).eligible, true);
    assert.equal(getDisplayLockCycle(new Date(lock.getTime() - 60000)).lockAt, lock.getTime());
  }
});

test("lock and display cycles follow UTC Thursday and Wednesday boundaries", () => {
  const cases = [
    { label: "Tue 23:59 UTC", at: date(-2, 23, 59), lockOffset: -7, displayOffset: -7, eligible: true, placeholder: false, notYetLocked: false },
    { label: "Wed 00:00 UTC", at: date(-1), lockOffset: -7, displayOffset: 0, eligible: true, placeholder: true, notYetLocked: true },
    { label: "Wed 23:59 UTC", at: date(-1, 23, 59), lockOffset: -7, displayOffset: 0, eligible: true, placeholder: true, notYetLocked: true },
    { label: "Thu 00:00 UTC", at: date(0), lockOffset: 0, displayOffset: 0, eligible: true, placeholder: false, notYetLocked: false },
    { label: "Thu 00:30 UTC", at: date(0, 0, 30), lockOffset: 0, displayOffset: 0, eligible: true, placeholder: false, notYetLocked: false },
    { label: "Thu 01:00 UTC", at: date(0, 1), lockOffset: 0, displayOffset: 0, eligible: true, placeholder: false, notYetLocked: false },
    { label: "Tue 23:59 UTC following week", at: date(5, 23, 59), lockOffset: 0, displayOffset: 0, eligible: true, placeholder: false, notYetLocked: false },
    { label: "Wed 00:00 UTC following week", at: date(6), lockOffset: 0, displayOffset: 7, eligible: true, placeholder: true, notYetLocked: true },
    { label: "Wed 23:59 UTC the following week", at: date(13, 23, 59), lockOffset: 7, displayOffset: 14, eligible: true, placeholder: true, notYetLocked: true },
  ];

  for (const item of cases) {
    const lockCycle = getLockCycle(item.at);
    assert.equal(lockCycle.lockAt, THURSDAY + item.lockOffset * DAY, item.label);
    assert.equal(lockCycle.eligible, item.eligible && !item.notYetLocked, `${item.label}: lock eligibility`);
    const displayCycle = getDisplayLockCycle(item.at);
    assert.equal(displayCycle.lockAt, THURSDAY + item.displayOffset * DAY, `${item.label}: display cycle`);
    assert.equal(displayCycle.placeholder, item.placeholder, `${item.label}: display placeholder`);
    assert.equal(!lockCycle.eligible, item.notYetLocked, `${item.label}: endpoint status`);
  }
});

test("boundary inputs map to schedule-backed season/week keys", async () => {
  const schedule = [
    { season: 2026, week: 3, date: new Date(date(-14, 1)).toISOString(), postseason: false },
    { season: 2026, week: 4, date: new Date(date(-7, 1)).toISOString(), postseason: false },
    { season: 2026, week: 5, date: new Date(date(0, 1)).toISOString(), postseason: false },
    { season: 2026, week: 6, date: new Date(date(7, 1)).toISOString(), postseason: false },
    { season: 2026, week: 7, date: new Date(date(14, 1)).toISOString(), postseason: false },
  ];
  const fetchGames = async () => schedule;
  const cases = [
    { label: "Tue 23:59", at: date(-2, 23, 59), lockAt: date(-7), lockKey: "2026/4", displayAt: date(-7), placeholder: false, displayKey: "2026/4", dryRunKey: "2026/5" },
    { label: "Wed 00:00", at: date(-1), lockAt: date(-7), lockKey: "2026/4", displayAt: date(0), placeholder: true, displayKey: "2026/5", dryRunKey: "2026/5" },
    { label: "Wed 23:59", at: date(-1, 23, 59), lockAt: date(-7), lockKey: "2026/4", displayAt: date(0), placeholder: true, displayKey: "2026/5", dryRunKey: "2026/5" },
    { label: "Thu 00:00", at: date(0), lockAt: date(0), lockKey: "2026/5", displayAt: date(0), placeholder: false, displayKey: "2026/5", dryRunKey: "2026/5" },
    { label: "Thu 00:30", at: date(0, 0, 30), lockAt: date(0), lockKey: "2026/5", displayAt: date(0), placeholder: false, displayKey: "2026/5", dryRunKey: "2026/5" },
    { label: "Thu 01:00", at: date(0, 1), lockAt: date(0), lockKey: "2026/5", displayAt: date(0), placeholder: false, displayKey: "2026/5", dryRunKey: "2026/5" },
    { label: "Wed 2026-10-14 23:59 UTC (after week 5 lock)", at: date(6, 23, 59), lockAt: date(0), lockKey: "2026/5", displayAt: date(7), placeholder: true, displayKey: "2026/6", dryRunKey: "2026/6" },
    { label: "Wed 2026-10-21 23:59 UTC (after week 6 lock)", at: date(13, 23, 59), lockAt: date(7), lockKey: "2026/6", displayAt: date(14), placeholder: true, displayKey: "2026/7", dryRunKey: "2026/7" },
  ];
  for (const item of cases) {
    const lockCycle = getLockCycle(item.at);
    assert.equal(lockCycle.lockAt, item.lockAt.getTime(), `${item.label}: lock cycle timestamp`);
    const lockCycleContext = await resolveLockWeekContext(new Date(lockCycle.lockAt), { fetchGames });
    assert.equal(`${lockCycleContext.season}/${lockCycleContext.week}`, item.lockKey, `${item.label}: lock cycle key`);

    const display = await resolveDisplayWeekContext(item.at, { fetchGames });
    assert.deepEqual(
      { placeholder: display.placeholder, key: `${display.season}/${display.week}` },
      { placeholder: item.placeholder, key: item.displayKey },
      `${item.label}: display state and week`,
    );

    const dryRun = await resolveLockWeekContext(item.at, { allowBeforeLock: true, fetchGames });
    assert.equal(`${dryRun.season}/${dryRun.week}`, item.dryRunKey, `${item.label}: dry-run key`);
  }
});

test("dry run before Thursday resolves the upcoming lock week's season/week", async () => {
  const upcomingWeek = [{ season: 2026, week: 5, date: new Date(THURSDAY + DAY).toISOString(), postseason: false }];
  const context = await resolveLockWeekContext(date(-1, 12), {
    allowBeforeLock: true,
    fetchGames: async () => upcomingWeek,
  });
  assert.equal(context.available, true);
  assert.equal(context.eligible, false);
  assert.equal(context.season, 2026);
  assert.equal(context.week, 5);
  assert.equal(context.lockAt, new Date(THURSDAY).toISOString());
});

test("week mapping handles Week 1 opener, Thanksgiving, bye week and offseason windows", async () => {
  const cases = [
    {
      name: "Week 1 opener",
      lockAt: Date.UTC(2026, 8, 10),
      games: [scheduleGame(1, 2026, 1, Date.UTC(2026, 8, 10, 17))],
      expected: [2026, 1],
      firstKickoffAt: new Date(Date.UTC(2026, 8, 10, 17)).toISOString(),
    },
    {
      name: "Thanksgiving Thursday",
      lockAt: Date.UTC(2026, 10, 26),
      games: [
        scheduleGame(2, 2026, 13, Date.UTC(2026, 10, 29, 18)),
        scheduleGame(3, 2026, 13, Date.UTC(2026, 10, 26, 17)),
      ],
      expected: [2026, 13],
      firstKickoffAt: new Date(Date.UTC(2026, 10, 26, 17)).toISOString(),
    },
    {
      name: "bye week with only the non-bye teams playing",
      lockAt: THURSDAY,
      games: [scheduleGame(4, 2026, 5, THURSDAY + DAY)],
      expected: [2026, 5],
      firstKickoffAt: new Date(THURSDAY + DAY).toISOString(),
    },
    { name: "week after final regular-season game", lockAt: Date.UTC(2027, 0, 14), games: [], expected: null },
  ];

  for (const item of cases) {
    const context = await resolveLockWeekContext(new Date(item.lockAt), { fetchGames: async () => item.games });
    if (item.expected) {
      assert.equal(context.available, true, item.name);
      assert.deepEqual([context.season, context.week], item.expected, item.name);
      assert.equal(context.firstKickoffAt, item.firstKickoffAt, `${item.name}: first kickoff`);
    } else {
      assert.equal(context.available, false, item.name);
      assert.match(context.reason, /No regular-season schedule games/);
    }
  }
});

test("offseason and schedule API failure return not ready without writing", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  try {
    const cases = [
      { name: "offseason", fetchGames: async () => [] },
      { name: "schedule API failure", fetchGames: async () => { throw new Error("schedule provider unavailable"); } },
    ];
    for (const item of cases) {
      let clientCalls = 0;
      const handler = createLockEntry({
        getNow: () => date(0, 0, 30),
        resolveContext: (now, options) => resolveLockWeekContext(now, { ...options, fetchGames: item.fetchGames }),
        createClient: () => { clientCalls += 1; throw new Error("must not create a client"); },
      });
      const res = response();
      await handler({ method: "GET", headers: { authorization: "Bearer expected-secret" }, query: { weeklyMultiMode: "lock" } }, res);
      assert.equal(res.statusCode, 200, item.name);
      assert.equal(res.body.status, "not ready", item.name);
      assert.equal(clientCalls, 0, item.name);
      if (item.name === "schedule API failure") assert.match(res.body.reason, /Schedule data is unavailable/);
    }
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("resolved lock season/week comes from games in the Thursday-to-Thursday schedule window", async () => {
  const lockAt = THURSDAY;
  const games = [
    { season: 2026, week: 5, date: new Date(lockAt + 60 * 60 * 1000).toISOString(), postseason: false },
    { season: 2026, week: 5, date: new Date(lockAt + 6 * DAY).toISOString(), postseason: false },
  ];
  const fetchGames = async () => games;
  const lockContext = await resolveLockWeekContext(date(0, 0, 30), { fetchGames });
  assert.equal(lockContext.season, 2026);
  assert.equal(lockContext.week, 5);
});

test("lock resolver returns not yet locked before Thursday without fetching schedule", async () => {
  let fetchCount = 0;
  const context = await resolveLockWeekContext(date(-1, 23, 59), {
    fetchGames: async () => { fetchCount += 1; return []; },
  });
  assert.equal(context.available, false);
  assert.equal(context.notYetLocked, true);
  assert.equal(context.eligible, false);
  assert.equal(fetchCount, 0);
});

test("lock route rejects absent and incorrect CRON_SECRET before accessing dependencies", async () => {
  const originalSecret = process.env.CRON_SECRET;
  let dependencyCalls = 0;
  const handler = createLockEntry({
    resolveContext: async () => { dependencyCalls += 1; throw new Error("should not resolve"); },
    createClient: () => { dependencyCalls += 1; throw new Error("should not create client"); },
  });
  const response = () => ({ statusCode: null, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

  try {
    delete process.env.CRON_SECRET;
    const missing = response();
    await handler({ method: "POST", headers: { authorization: "Bearer anything" }, query: { weeklyMultiMode: "lock" } }, missing);
    assert.equal(missing.statusCode, 401);
    process.env.CRON_SECRET = "expected-secret";
    const wrong = response();
    await handler({ method: "GET", headers: { authorization: "Bearer wrong-secret" }, query: { weeklyMultiMode: "lock" } }, wrong);
    assert.equal(wrong.statusCode, 401);
    assert.equal(dependencyCalls, 0);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("read route returns the saved multi for the schedule-backed display week", async () => {
  const calls = [];
  const record = { season: 2026, week: 5, lock_at: new Date(THURSDAY).toISOString(), legs: [{ result: "won" }, { result: "lost" }] };
  const chain = {
    select(columns) { calls.push(["select", columns]); return this; },
    eq(column, value) { calls.push(["eq", column, value]); return this; },
    async maybeSingle() { return { data: record, error: null }; },
  };
  const handler = createCurrentEntry({
    getNow: () => date(0, 0, 30),
    fetchGames: async () => { throw new Error("saved record must skip provider"); },
    createClient: () => ({ from(table) { calls.push(["from", table]); return chain; } }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.record, record);
  assert.equal(res.body.week, 5);
  assert.deepEqual(calls.filter(([method]) => method === "eq"), [["eq", "lock_at", new Date(THURSDAY).toISOString()]]);
});

test("windowed schedule resolver derives the key and earliest kickoff with one request", async () => {
  const requested = [];
  const games = [
    { season: 2026, week: 5, date: new Date(THURSDAY + 3 * 60 * 60 * 1000).toISOString(), postseason: false },
    { season: 2026, week: 5, date: new Date(THURSDAY + 60 * 60 * 1000).toISOString(), postseason: false },
  ];
  const context = await resolveLockWeekContext(date(0, 0, 30), {
    fetchGames: async (lockAt, end) => {
      requested.push({ lockAt, end });
      return games;
    },
  });
  assert.equal(requested.length, 1);
  assert.deepEqual([context.season, context.week], [2026, 5]);
  assert.equal(context.firstKickoffAt, new Date(THURSDAY + 60 * 60 * 1000).toISOString());
});

test("plain-text 429 returns not ready without odds refresh or writes", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  const database = createLockClient();
  let oddsCalls = 0;
  try {
    const handler = createLockEntry({
      getNow: () => date(0, 0, 30),
      resolveContext: async () => ({ available: false, lockAt: new Date(THURSDAY).toISOString(), reason: "schedule provider rate limited" }),
      createClient: () => database.client,
      fetchOdds: async () => { oddsCalls += 1; throw new Error("must not refresh odds"); },
    });
    const res = response();
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret" }, query: { weeklyMultiMode: "lock" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "not ready");
    assert.equal(res.body.reason, "schedule provider rate limited");
    assert.equal(oddsCalls, 0);
    assert.equal(database.calls.some(([method]) => method === "insert"), false);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("schedule retry honors Retry-After before the second request", async () => {
  const originalApiKey = process.env.BALLDONTLIE_API_KEY;
  process.env.BALLDONTLIE_API_KEY = "test-key";
  const waits = [];
  let requests = 0;
  const headers = { get(name) { return name === "Retry-After" ? "1" : null; } };
  const fetchImpl = async () => {
    requests += 1;
    if (requests === 1) return { ok: false, status: 429, headers, async text() { return "Too many requests"; } };
    return { ok: true, status: 200, headers: { get() { return null; } }, async text() { return JSON.stringify({ data: [] }); } };
  };
  try {
    const games = await fetchScheduleGamesForWindow(THURSDAY, THURSDAY + 7 * DAY, {
      fetchImpl,
      sleep: async (milliseconds) => waits.push(milliseconds),
    });
    assert.deepEqual(games, []);
    assert.equal(requests, 2);
    assert.deepEqual(waits, [1000]);
  } finally {
    if (originalApiKey === undefined) delete process.env.BALLDONTLIE_API_KEY;
    else process.env.BALLDONTLIE_API_KEY = originalApiKey;
  }
});

test("read route shows the placeholder only when the upcoming display week has regular-season games", async () => {
  const schedule = [{ season: 2026, week: 5, date: date(0, 1).toISOString(), postseason: false }];
  const handler = createCurrentEntry({
    getNow: () => date(-1),
    fetchGames: async () => schedule,
    createClient: () => ({
      from: () => ({
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
      }),
    }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "before lock");
  assert.equal(res.body.placeholder, true);
  assert.equal(res.body.week, 5);
});

test("read route returns not ready when the display window has no regular-season games", async () => {
  for (const schedule of [
    [],
    [{ season: 2026, week: 1, date: date(0, 1).toISOString(), postseason: true }],
  ]) {
    const handler = createCurrentEntry({
      getNow: () => date(-1),
      fetchGames: async () => schedule,
      createClient: () => ({
        from: () => ({
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: null, error: null }; },
        }),
      }),
    });
    const res = response();
    await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "not ready");
    assert.equal(res.body.placeholder, false);
    assert.match(res.body.message, /not ready yet/i);
  }
});

test("read route returns not ready when the schedule lookup fails", async () => {
  const handler = createCurrentEntry({
    getNow: () => date(-1),
    fetchGames: async () => { throw new Error("schedule unavailable"); },
    createClient: () => ({
      from: () => ({
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
      }),
    }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "not ready");
  assert.match(res.body.reason, /schedule unavailable/i);
  assert.match(res.body.message, /not ready yet/i);
});

test("read route does not fall back to an older saved week when the active week has no record", async () => {
  const calls = [];
  const chain = {
    select() { return this; },
    eq(column, value) { calls.push([column, value]); return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const handler = createCurrentEntry({
    getNow: () => date(0, 0, 30),
    fetchGames: async () => [{ season: 2026, week: 5, date: date(0, 1).toISOString(), postseason: false }],
    createClient: () => ({ from: () => chain }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.body.status, "not ready");
  assert.match(res.body.message, /No shared Weekly Best Multi has been locked for Week 5/);
  assert.deepEqual(calls, [["lock_at", new Date(THURSDAY).toISOString()]]);
});

test("read route reports a missed week when no saved multi exists after first kickoff", async () => {
  const handler = createCurrentEntry({
    getNow: () => date(0, 2),
    fetchGames: async () => [scheduleGame(5, 2026, 5, THURSDAY + 60 * 60 * 1000)],
    createClient: () => ({
      from: () => ({
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
      }),
    }),
  });
  const res = response();
  await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "missed");
  assert.equal(res.body.message, "No Weekly Best Multi was locked for this week.");
});

test("late generation is allowed at the deadline before the first kickoff and flagged", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  const context = {
    available: true,
    eligible: true,
    season: 2026,
    week: 5,
    lockAt: new Date(THURSDAY).toISOString(),
    deadlineAt: new Date(THURSDAY + 30 * 60 * 1000).toISOString(),
    retryDeadline: THURSDAY + 30 * 60 * 1000,
    firstKickoffAt: new Date(THURSDAY + 45 * 60 * 1000).toISOString(),
  };
  const database = createLockClient();
  const handler = createLockEntry({
    resolveContext: async () => context,
    getNow: () => new Date(context.retryDeadline),
    createClient: () => database.client,
    fetchOdds: async () => ({ ok: true, async json() { return { cacheStatus: "fresh", refreshedAt: new Date(THURSDAY).toISOString(), events: [] }; } }),
  });
  const res = response();
  try {
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret", host: "example.test" }, query: { weeklyMultiMode: "lock" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "generated late");
    assert.equal(res.body.record.generated_late, true);
    assert.equal(database.insertedRecord.generated_late, true);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("late lock after first kickoff is missed and performs no writes", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  const context = {
    available: true,
    eligible: true,
    season: 2026,
    week: 5,
    lockAt: new Date(THURSDAY).toISOString(),
    deadlineAt: new Date(THURSDAY + 30 * 60 * 1000).toISOString(),
    retryDeadline: THURSDAY + 30 * 60 * 1000,
    firstKickoffAt: new Date(THURSDAY + 45 * 60 * 1000).toISOString(),
  };
  const database = createLockClient();
  let oddsCalls = 0;
  const handler = createLockEntry({
    resolveContext: async () => context,
    getNow: () => new Date(THURSDAY + 46 * 60 * 1000),
    createClient: () => database.client,
    fetchOdds: async () => { oddsCalls += 1; throw new Error("late lock must not refresh odds"); },
  });
  const res = response();
  try {
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret", host: "example.test" }, query: { weeklyMultiMode: "lock" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "missed");
    assert.equal(res.body.message, "No Weekly Best Multi was locked for this week.");
    assert.equal(database.calls.some(([method]) => method === "insert"), false);
    assert.equal(oddsCalls, 0);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("dry run remains available after kickoff and does not insert a row", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  const context = {
    available: true,
    eligible: true,
    season: 2026,
    week: 5,
    lockAt: new Date(THURSDAY).toISOString(),
    deadlineAt: new Date(THURSDAY + 30 * 60 * 1000).toISOString(),
    retryDeadline: THURSDAY + 30 * 60 * 1000,
    firstKickoffAt: new Date(THURSDAY + 45 * 60 * 1000).toISOString(),
  };
  const database = createLockClient();
  const handler = createLockEntry({
    resolveContext: async () => context,
    getNow: () => new Date(THURSDAY + 46 * 60 * 1000),
    createClient: () => database.client,
    fetchOdds: async () => ({ ok: true, async json() { return { cacheStatus: "fresh", refreshedAt: new Date(THURSDAY).toISOString(), events: [] }; } }),
  });
  const res = response();
  try {
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret", host: "example.test" }, query: { weeklyMultiMode: "lock", dryRun: "true" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(database.calls.some(([method]) => method === "insert"), false);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("dry run returns selection without inserting a row", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "expected-secret";
  const calls = [];
  const context = {
    available: true,
    eligible: true,
    season: 2026,
    week: 5,
    lockAt: new Date(THURSDAY).toISOString(),
    deadlineAt: new Date(THURSDAY + 30 * 60 * 1000).toISOString(),
    retryDeadline: THURSDAY + 30 * 60 * 1000,
  };
  const firstQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const secondQuery = {
    select() { return this; },
    eq() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
  };
  const handler = createLockEntry({
    resolveContext: async () => context,
    getNow: () => new Date(THURSDAY + 2 * 60 * 1000),
    createClient: () => ({
      from(table) {
        calls.push(["from", table]);
        return table === "weekly_best_multis" ? firstQuery : secondQuery;
      },
    }),
    fetchOdds: async () => ({ ok: true, async json() { return { cacheStatus: "fresh", refreshedAt: new Date(THURSDAY).toISOString(), events: [] }; } }),
  });
  const res = { statusCode: null, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

  try {
    await handler({ method: "GET", headers: { authorization: "Bearer expected-secret", host: "example.test" }, query: { weeklyMultiMode: "lock", dryRun: "true" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(Array.isArray(res.body.legs), true);
    assert.equal(calls.some(([method]) => method === "insert"), false);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});
