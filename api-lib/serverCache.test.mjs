import test from "node:test";
import assert from "node:assert/strict";
import { createServerCache, providerCache, MINUTE, DAY } from "./serverCache.js";
import { handler as teams } from "../api/nfl/teams.js";
import { handler as game } from "../api/nfl/game.js";
import { handler as standings } from "../api/nfl/standings.js";

const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
function provider(reply) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return reply(String(url), calls.length); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("answers are shared for their lifetime, concurrent requests share one call, and failures are not kept", async () => {
  let clock = 0;
  const cache = createServerCache({ now: () => clock });
  let loads = 0;
  const load = async () => { loads++; return loads; };
  assert.deepEqual(await Promise.all([cache("k", MINUTE, load), cache("k", MINUTE, load), cache("k", MINUTE, load)]), [1, 1, 1]);
  clock = MINUTE - 1;
  assert.equal(await cache("k", MINUTE, load), 1);
  clock = MINUTE;
  assert.equal(await cache("k", MINUTE, load), 2);
  await assert.rejects(cache("bad", MINUTE, async () => { throw new Error("429"); }), /429/);
  assert.equal(await cache("bad", MINUTE, async () => "recovered"), "recovered");
  assert.equal(await cache("live", (v) => (v.final ? DAY : MINUTE), async () => ({ final: true })).then((v) => v.final), true);
  clock += 2 * MINUTE;
  assert.equal((await cache("live", (v) => (v.final ? DAY : MINUTE), async () => ({ final: false }))).final, true, "a finished game is kept for a day");
});

test("many users opening Teams make one provider call", async () => {
  providerCache.clear();
  process.env.BALLDONTLIE_API_KEY ||= "test-key";
  const fake = provider(() => ok({ data: [{ abbreviation: "PIT" }] }));
  try {
    for (let user = 0; user < 10; user++) {
      const res = response();
      await teams({ method: "GET", query: {} }, res);
      assert.equal(res.code, 200);
      assert.equal(res.body.data[0].abbreviation, "PIT");
    }
  } finally { fake.restore(); }
  assert.equal(fake.calls.length, 1);
});

test("a provider rejection is passed on and not kept", async () => {
  providerCache.clear();
  const fake = provider((url, n) => (n === 1 ? new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) : ok({ data: [] })));
  try {
    const first = response(); await teams({ method: "GET", query: {} }, first);
    assert.equal(first.code, 429);
    const second = response(); await teams({ method: "GET", query: {} }, second);
    assert.equal(second.code, 200);
  } finally { fake.restore(); }
  assert.equal(fake.calls.length, 2);
});

test("a live game is shared for a minute; a finished game is not asked for again", async () => {
  providerCache.clear();
  const fake = provider(() => ok({ data: { id: 7, status: "Final" } }));
  try {
    for (let user = 0; user < 5; user++) { const res = response(); await game({ method: "GET", query: { id: "7" } }, res); assert.equal(res.code, 200); }
  } finally { fake.restore(); }
  assert.equal(fake.calls.length, 1);
});

test("standings are not requested from a plan that does not include them", async () => {
  const fake = provider(() => ok({ data: [] }));
  const res = response();
  try { await standings({ method: "GET", query: {} }, res); } finally { fake.restore(); }
  assert.equal(fake.calls.length, 0);
  assert.equal(res.code, 401);
});

import scheduleRoute from "../api/nfl/schedule.js";
import { createScheduleHandler } from "../api/nfl/schedule.js";

test("users browsing a week's schedule share one provider call a minute", async () => {
  providerCache.clear();
  process.env.BALLDONTLIE_API_KEY ||= "test-key";
  const fake = provider((url) => (url.includes("balldontlie")
    ? ok({ data: [{ id: 1, week: 13, season: 2026, date: "2026-12-04T01:15:00Z", postseason: false,
      visitor_team: { abbreviation: "DAL" }, home_team: { abbreviation: "DET" } }], meta: {} })
    : ok({ events: [] })));
  try {
    const handler = createScheduleHandler();
    for (let user = 0; user < 6; user++) { const res = response(); await handler({ method: "GET", query: { season: "2026", week: "13" } }, res); }
  } finally { fake.restore(); }
  assert.equal(fake.calls.filter((url) => url.includes("balldontlie")).length, 1);
  assert.ok(scheduleRoute);
});
