import test from "node:test";
import assert from "node:assert/strict";
import { handler, parseEspnTeamStats } from "../api/nfl/standings.js";

const espn = (offense, defense) => ({
  results: {
    stats: { categories: [
      { name: "passing", stats: [{ name: "netPassingYardsPerGame", value: offense.pass }, { name: "yardsPerGame", value: offense.yards }, { name: "totalPointsPerGame", value: offense.points }] },
      { name: "rushing", stats: [{ name: "rushingYardsPerGame", value: offense.rush }, { name: "totalPointsPerGame", value: 999 }] },
    ] },
    opponent: [
      { name: "passing", stats: [{ name: "netPassingYardsPerGame", value: defense.pass }, { name: "yardsPerGame", value: defense.yards }, { name: "totalPointsPerGame", value: defense.points }] },
      { name: "rushing", stats: [{ name: "rushingYardsPerGame", value: defense.rush }] },
    ],
  },
});

function call(query, fetchImpl) {
  return new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); return this; } };
    handler({ method: "GET", query }, res, { fetchImpl });
  });
}

test("ESPN team statistics become per-game figures gained and allowed", () => {
  const parsed = parseEspnTeamStats(espn(
    { pass: 198.64, yards: 336.1, points: 21.4, rush: 111.8 },
    { pass: 230.3, yards: 332.6, points: 20.1, rush: 84 },
  ));
  assert.deepEqual(parsed, {
    offense: { pointsPerGame: 21.4, yardsPerGame: 336.1, passingYardsPerGame: 198.6, rushingYardsPerGame: 111.8 },
    defense: { pointsPerGame: 20.1, yardsPerGame: 332.6, passingYardsPerGame: 230.3, rushingYardsPerGame: 84 },
  });
  assert.deepEqual(parseEspnTeamStats({}).offense, { pointsPerGame: null, yardsPerGame: null, passingYardsPerGame: null, rushingYardsPerGame: null });
});

test("the standings route answers ?team= with that team's statistics from ESPN", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => espn({ pass: 217, yards: 351.5, points: 21.8, rush: 120.1 }, { pass: 248.4, yards: 360.6, points: 24.3, rush: 96.5 }) };
  };
  const result = await call({ season: "2031", team: "was" }, fetchImpl);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.team, "WSH");
  assert.equal(result.body.data.offense.rushingYardsPerGame, 120.1);
  assert.match(urls[0], /\/teams\/wsh\/statistics\?season=2031$/);
});

test("unknown teams are refused and incomplete answers are not kept", async () => {
  assert.equal((await call({ season: "2031", team: "XYZ" }, async () => { throw new Error("no call expected"); })).status, 400);
  let calls = 0;
  const empty = async () => { calls += 1; return { ok: true, json: async () => ({}) }; };
  assert.equal((await call({ season: "2032", team: "PIT" }, empty)).status, 502);
  assert.equal((await call({ season: "2032", team: "PIT" }, empty)).status, 502);
  assert.equal(calls, 2);
});
