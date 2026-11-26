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

// ESPN's division-level standings: two conferences, four divisions each, entries in order.
function espnStandings({ teams = 32 } = {}) {
  const codes = ["BUF", "NE", "NYJ", "MIA", "CIN", "CLE", "PIT", "BAL", "JAX", "HOU", "IND", "TEN", "DEN", "KC", "LV", "LAC",
    "NYG", "DAL", "WSH", "PHI", "DET", "CHI", "MIN", "GB", "CAR", "TB", "ATL", "NO", "SF", "LAR", "SEA", "ARI"].slice(0, teams);
  const stat = (name, value, displayValue = String(value)) => ({ name, value, displayValue });
  const entry = (code, i) => ({ team: { abbreviation: code === "LAR" ? "LA" : code, displayName: code },
    stats: [stat("wins", 9 - (i % 4)), stat("losses", 1 + (i % 4)), stat("ties", 0), stat("playoffSeed", (i % 16) + 1),
      stat("pointsFor", 300), stat("pointsAgainst", 200), stat("pointDifferential", 100), stat("streak", 0, "W3"),
      stat("Home", 0, "4-1"), stat("Road", 0, "5-0-1"), stat("vs. Div.", 0, "2-1"), stat("vs. Conf.", 0, "6-1")] });
  const division = (conf, name, start) => ({ abbreviation: `${conf} ${name}`, standings: { entries: codes.slice(start, start + 4).map((c, j) => entry(c, start + j)) } });
  return { children: ["AFC", "NFC"].map((conf, c) => ({ abbreviation: conf,
    children: ["EAST", "NORTH", "SOUTH", "WEST"].map((d, i) => division(conf, d, c * 16 + i * 4)) })) };
}

test("standings come from ESPN in the shape the pages use, shared for ten minutes", async () => {
  providerCache.clear();
  const fake = provider(() => ok(espnStandings()));
  const runs = [];
  try {
    for (let user = 0; user < 4; user++) { const res = response(); await standings({ method: "GET", query: { season: "2026" } }, res); runs.push(res); }
  } finally { fake.restore(); }
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0], /site.api.espn.com.*season=2026.*level=3/);
  const { code, body } = runs[0];
  assert.equal(code, 200);
  assert.equal(body.count, 32);
  const buf = body.data.find((row) => row.abbreviation === "BUF");
  assert.deepEqual({ conference: buf.conference, division: buf.division, divisionRank: buf.divisionRank, conferenceRank: buf.conferenceRank,
    playoffSeed: buf.playoffSeed, wins: buf.wins, losses: buf.losses, home: buf.home, road: buf.road, streak: buf.streak },
    { conference: "AFC", division: "East", divisionRank: 1, conferenceRank: 1, playoffSeed: 1, wins: 9, losses: 1,
      home: { wins: 4, losses: 1, ties: 0 }, road: { wins: 5, losses: 0, ties: 1 }, streak: "W3" });
  assert.equal(body.data.find((row) => row.abbreviation === "MIA").divisionRank, 4);
  assert.ok(body.data.some((row) => row.abbreviation === "LAR"), "ESPN's LA becomes LAR");
  assert.equal(body.data.find((row) => row.conferenceRank === 8).playoffSeed, null, "only seeds 1-7 make the playoffs");
});

test("an incomplete or failed standings answer is reported and not kept", async () => {
  providerCache.clear();
  const fake = provider((url, n) => (n === 1 ? ok(espnStandings({ teams: 20 })) : n === 2 ? new Response("down", { status: 503 }) : ok(espnStandings())));
  const codes = [];
  try {
    for (let i = 0; i < 3; i++) { const res = response(); await standings({ method: "GET", query: { season: "2026" } }, res); codes.push(res.code); }
  } finally { fake.restore(); }
  assert.deepEqual(codes, [502, 503, 200]);
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
