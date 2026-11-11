import test from "node:test";
import assert from "node:assert/strict";
import { withApprovedUser } from "./authorization.js";

const response = () => ({
  headers: {}, statusCode: 200,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
function fixture() {
  const state = { valid: true, approved: true, calls: 0, lookups: 0 };
  const createUserClient = (token) => {
    assert.equal(token, "user-jwt");
    return {
      auth: { getUser: async () => ({ data: { user: state.valid ? { id: "own-user" } : null },
        error: state.valid ? null : new Error("invalid") }) },
      from(table) {
        assert.equal(table, "app_users");
        return {
          select(columns) { assert.equal(columns, "user_id, approved"); return this; },
          eq(key, value) { assert.equal(key, "user_id"); assert.equal(value, "own-user"); return this; },
          async maybeSingle() {
            state.lookups++;
            return { data: { user_id: "own-user", approved: state.approved }, error: null };
          },
        };
      },
    };
  };
  const route = withApprovedUser((_req, res) => {
    state.calls++;
    res.setHeader("Cache-Control", "public, s-maxage=3600");
    res.setHeader("Vercel-CDN-Cache-Control", "public, max-age=3600");
    return res.status(200).json({ ok: true });
  }, { createUserClient });
  return { state, route };
}
function env(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("missing/invalid JWT stops before the data/provider handler; approval is read-only and rechecked", async () => {
  const { state, route } = fixture();
  for (const authorization of [undefined, "", "Basic invalid", "Bearer user-jwt"]) {
    state.valid = false;
    const res = response();
    await route({ headers: { authorization } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(state.calls, 0);
    assert.equal(state.lookups, 0);
  }
  state.valid = true;
  for (const [approved, expected] of [[false, 403], [true, 200], [false, 403]]) {
    state.approved = approved;
    const res = response();
    await route({ headers: { authorization: "Bearer user-jwt" }, approved: true }, res);
    assert.equal(res.statusCode, expected);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.headers["vercel-cdn-cache-control"], "private, no-store");
    assert.match(res.headers.vary, /Authorization/);
  }
  assert.equal(state.calls, 1);
  assert.equal(state.lookups, 3, "approval revocation must affect the next request");
});

test("exact existing CRON_SECRET bypasses interactive auth; other values do not", async (t) => {
  env(t, { CRON_SECRET: "test-cron-secret" });
  let calls = 0;
  const route = withApprovedUser((_req, res) => { calls++; return res.status(200).json({ ok: true }); },
    { createUserClient: () => { throw new Error("Interactive auth must not run for cron"); } });
  const res = response();
  await route({ headers: { authorization: "Bearer test-cron-secret" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  const rejected = response();
  await route({ headers: { authorization: "Bearer wrong" } }, rejected);
  assert.equal(rejected.statusCode, 503);
  assert.equal(calls, 1);
});

test("deployed refresh and Weekly Multi dispatch preserve their existing cron-only handlers", async (t) => {
  env(t, { CRON_SECRET: "test-job-secret" });
  t.mock.method(globalThis, "fetch", () => assert.fail("Dispatch checks must not reach network"));
  const { default: gameStats } = await import("../api/nfl/game-stats.js");
  const { default: odds } = await import("../api/nfl/odds.js");
  const { default: schedule } = await import("../api/nfl/schedule.js");
  const headers = { authorization: "Bearer test-job-secret" };
  const res = response();
  await gameStats({ method: "PUT", headers, query: { action: "refresh-predictions" } }, res);
  assert.equal(res.statusCode, 405);
  const oddsRes = response();
  await odds({ method: "GET", headers, query: {}, url: "/api/nfl/odds?refreshMarket=unknown" }, oddsRes);
  assert.equal(oddsRes.statusCode, 400);
  const scheduleRes = response();
  await schedule({ method: "GET", headers, query: { weeklyMultiMode: "unknown" } }, scheduleRes);
  assert.equal(scheduleRes.statusCode, 404);
});

for (const name of ["teams", "standings", "schedule", "game", "game-stats", "odds",
  "qb-roster-health", "sleeper-players", "kicker-stats", "play-by-play", "opponent-network"]) {
  test(`deployed ${name} entry point denies unauthenticated access before any network call`, async (t) => {
    const { default: handler } = await import(`../api/nfl/${name}.js`);
    t.mock.method(globalThis, "fetch", () => assert.fail("No network call before authorization"));
    const res = response();
    await handler({ method: "GET", headers: {}, query: {}, url: `/api/nfl/${name}` }, res);
    assert.equal(res.statusCode, 401);
  });
}

test("approval lookup failure and missing row fail closed", async () => {
  for (const profile of [{ data: null, error: null }, { data: null, error: new Error("offline") }]) {
    const route = withApprovedUser(() => assert.fail("Do not start a provider request"), {
      createUserClient: () => ({
        auth: { getUser: async () => ({ data: { user: { id: "own" } }, error: null }) },
        from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => profile }),
      }),
    });
    const res = response();
    await route({ headers: { authorization: "Bearer test-jwt" } }, res);
    assert.equal(res.statusCode, profile.error ? 503 : 403);
  }
});

test("deployed teams route verifies JWT and own approval before provider work, including revocation", async (t) => {
  const { default: handler } = await import("../api/nfl/teams.js");
  env(t, { SUPABASE_URL: "https://test-project.supabase.co", SUPABASE_ANON_KEY: "test-anon-key",
    BALLDONTLIE_API_KEY: "test-provider-key" });
  let valid = false, approved = false, providerCalls = 0, approvalReads = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(new Headers(options.headers).get("Authorization"), "Bearer user-jwt");
      return Response.json(valid ? { id: "own-user" } : { message: "Invalid token" }, { status: valid ? 200 : 401 });
    }
    if (url.pathname === "/rest/v1/app_users") {
      approvalReads++;
      assert.equal(url.searchParams.get("user_id"), "eq.own-user");
      assert.equal(new Headers(options.headers).get("Authorization"), "Bearer user-jwt");
      assert.equal(options.method, "GET");
      return Response.json({ user_id: "own-user", approved });
    }
    assert.equal(url.hostname, "api.balldontlie.io");
    providerCalls++;
    return Response.json({ data: [] });
  });
  for (const [isValid, isApproved, status, expectedProviderCalls] of [
    [false, false, 401, 0], [true, false, 403, 0], [true, true, 200, 1], [true, false, 403, 1],
  ]) {
    valid = isValid; approved = isApproved;
    const res = response();
    await handler({ method: "GET", headers: { authorization: "Bearer user-jwt" }, query: {} }, res);
    assert.equal(res.statusCode, status, JSON.stringify(res.body));
    assert.equal(providerCalls, expectedProviderCalls);
  }
  assert.equal(approvalReads, 3);
});
