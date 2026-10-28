import test from "node:test";
import assert from "node:assert/strict";
import { computeWeatherImpact, predictMatchup } from "./predictionEngine.js";
import { createServerPredictionGenerator } from "../../api-lib/serverPredictions.js";
import { predictionRefreshContext, validatePredictionRefreshBatch } from "../../api-lib/predictionRefresh.js";
import { buildTeamMetricsResponse } from "../../api/nfl/play-by-play.js";
import { createOpponentNetworkHandler } from "../../api/nfl/opponent-network.js";
import { invoke } from "../../api-lib/serverPredictions.js";
import { playerMetricsResponse } from "../../api-lib/playerMetrics.js";
import team from "../../api/nfl/nflverse-team-metrics.js";
import players from "../../data/nflverse-player-metrics.js";

const unavailable = { dome: false, weatherAvailable: false, fallbackActive: true,
  fallbackReason: "No saved forecast", weatherSource: null, venue: "Lambeau Field" };
const neutral = computeWeatherImpact(null);
const assertFinite = (value) => {
  if (typeof value === "number") assert(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(assertFinite);
};

test("null, indoor and explicitly unavailable weather retain neutral effects without inventing measurements", () => {
  assertFinite(neutral);
  assert.deepEqual(computeWeatherImpact({ dome: true }), { ...neutral, dome: true });
  const before = structuredClone(unavailable);
  const result = computeWeatherImpact(unavailable);
  for (const [key, value] of Object.entries(neutral)) assert.deepEqual(result[key], value);
  assert.equal(result.weatherAvailable, false);
  assert.equal(result.fallbackReason, unavailable.fallbackReason);
  assert.equal(result.weatherSource, null);
  for (const field of ["rain", "precipitation", "windSpeed", "temperature"]) assert(!(field in result));
  assert.deepEqual(unavailable, before);
});

test("valid dry/rain and measured fallback retain existing weather calculations", () => {
  const dry = { weatherAvailable: true, windSpeed: 0, temperature: 20, rain: 0 };
  assert.deepEqual(computeWeatherImpact(dry), neutral);
  const rain = { ...dry, rain: 4, windSpeed: 40, windGust: 55, weatherCode: 61 };
  const impact = computeWeatherImpact(rain);
  assertFinite(impact);
  assert(impact.coefficient < 1);
  assert(impact.fieldGoals < 1);
  assert.deepEqual(computeWeatherImpact({ ...rain, fallbackActive: true }), impact);
});

test("available malformed and non-finite weather fails with the offending source field", () => {
  const valid = { weatherAvailable: true, windSpeed: 10, temperature: 20, rain: 0 };
  for (const [field, value] of [["precipitation", "bad"], ["windSpeed", NaN],
    ["temperature", Infinity], ["rain", -Infinity], ["windGust", "40"]]) {
    assert.throws(() => computeWeatherImpact({ ...valid, [field]: value }), new RegExp(field));
  }
  for (const field of ["windSpeed", "temperature", "rain"]) {
    const invalid = { ...valid };
    delete invalid[field];
    assert.throws(() => computeWeatherImpact(invalid), new RegExp(field));
  }
});

test("stale/unavailable normalization remains neutral; stale metadata alone does not invent a policy", () => {
  const stale = { ...unavailable, fallbackReason: "No weather observation is sufficiently close to kickoff" };
  assert.equal(computeWeatherImpact(stale).fallbackReason, stale.fallbackReason);
  const measured = { windSpeed: 40, rain: 2, stale: true };
  assert.deepEqual(computeWeatherImpact(measured), computeWeatherImpact({ windSpeed: 40, rain: 2 }));
});

test("unavailable weather preserves neutral score, TD and special-teams simulation and raw provenance", () => {
  const options = { season: 2026, week: 8, kickoff: "2026-10-30T00:15:00Z" };
  const plain = predictMatchup("CAR", "GB", options);
  const fallback = predictMatchup("CAR", "GB", { ...options, weather: unavailable });
  assertFinite(fallback);
  assert.deepEqual(fallback.away, plain.away);
  assert.deepEqual(fallback.home, plain.home);
});

test("all 14 Week 8 server candidates including 11 outdoor venues are finite and pass batch validation", async () => {
  const pairs = ["CAR-GB", "BAL-BUF", "TEN-CIN", "ARI-DAL", "MIN-DET", "LV-NYJ", "CLE-PIT",
    "ATL-TB", "IND-JAX", "LAC-LAR", "KC-DEN", "NE-MIA", "PHI-WSH", "CHI-SEA"];
  const now = new Date("2026-10-28T00:00:00Z");
  const source = pairs.map((pair, i) => {
    const [away, home] = pair.split("-");
    return { id: i === 13 ? 1392336 : 1392323 + i, season: 2026, week: 8,
      date: i === 13 ? "2026-11-03T01:15:00Z" : "2026-10-30T00:15:00Z",
      visitor_team: { abbreviation: away }, home_team: { abbreviation: home } };
  });
  const context = predictionRefreshContext(source, now);
  const handler = createOpponentNetworkHandler({ loadNetwork: async () => team.opponentNetworkByWeek[8] });
  const generate = createServerPredictionGenerator({ loadInputs: (query) => ({
    playByPlay: Promise.resolve(buildTeamMetricsResponse(team, query)),
    playerMetrics: Promise.resolve(playerMetricsResponse(players, query)),
    opponentNetwork: invoke(handler, query),
  }) });
  const originalFetch = globalThis.fetch;
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  globalThis.fetch = () => assert.fail("Weather and odds providers must not be fetched");
  try {
    const snapshots = [];
    for (const game of context.games) {
      const prepared = { ...game, weather: unavailable };
      const odds = { events: [{ id: `stored-${game.id}`, commence_time: game.sourceDate,
        away_team: game.away, home_team: game.home, bookmakers: [{ key: "fixture",
          last_update: now.toISOString(), markets: [{ key: "h2h", outcomes: [
            { name: game.away, price: 100 }, { name: game.home, price: 100 },
          ] }] }] }] };
      const snapshot = await generate(prepared, odds, now);
      assertFinite(snapshot);
      assert.equal(snapshot.dataQuality.weather.weatherAvailable, false);
      assert.equal(snapshot.dataQuality.weather.fallbackReason, unavailable.fallbackReason);
      snapshots.push(snapshot);
    }
    validatePredictionRefreshBatch(snapshots, context, now);
  } finally { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate; }
});
