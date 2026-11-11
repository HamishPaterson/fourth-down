import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_FACTORS_2026_ENABLED, MAX_COMBINED_EXTERNAL_MARGIN_ADJUSTMENT,
  capExternalMarginAdjustment, computeExternalAdjustments2026,
} from "./externalFactors2026.js";
import dataset from "./externalFactors2026Data.js";
import { predictMatchup } from "./predictionEngine.js";

test("production enablement and final combined cap are exactly true and two points", () => {
  assert.equal(EXTERNAL_FACTORS_2026_ENABLED, true);
  assert.equal(MAX_COMBINED_EXTERNAL_MARGIN_ADJUSTMENT, 2);
  for (const [value, expected] of [[-100, -2], [-2.5, -2], [-2, -2], [-1.5, -1.5],
    [0, 0], [1.5, 1.5], [2, 2], [2.5, 2], [100, 2]]) {
    assert.equal(capExternalMarginAdjustment(value), expected);
  }
  for (const value of [NaN, Infinity, -Infinity, null, undefined]) {
    assert.throws(() => capExternalMarginAdjustment(value), /Non-finite combined/);
  }
});

test("enabled projections cap actual final margin flow-through and preserve factor provenance", () => {
  let capped = 0;
  for (const [away, home] of [["MIN", "GB"], ["NE", "DET"], ["SEA", "LV"], ["LAC", "BAL"]]) {
    for (const weather of [null, { dome: true }, { temperature: -10, windSpeed: 45, rain: 8 }]) {
      const prediction = predictMatchup(away, home, {
        season: 2026, week: 10, kickoff: "2026-11-15T18:00:00Z", weather,
        scheduleContext: { away: { daysRest: 4, consecutiveRoadGamesIncludingCurrent: 3 },
          home: { daysRest: 14 } },
      });
      const trace = prediction.externalFactors2026;
      assert.equal(trace.active, true);
      assert.ok(Math.abs(trace.totalExternalAdjustment) <= 2);
      assert.ok(Math.abs(prediction.continuousMargin - trace.baseModelMargin) <= 2 + 1e-9);
      assert.ok(Math.abs(prediction.home.expectedPoints - prediction.away.expectedPoints -
        prediction.continuousMargin) < 1e-9);
      assert.equal(trace.totalExternalAdjustment,
        capExternalMarginAdjustment(trace.uncappedExternalAdjustment));
      if (Math.abs(trace.uncappedExternalAdjustment) > 2) capped++;
      const raw = computeExternalAdjustments2026(dataset, { away, home, week: 10,
        kickoff: "2026-11-15T18:00:00Z", weather });
      assert.deepEqual(trace.venue, raw.trace.venue);
      assert.deepEqual(trace.travel, raw.trace.travel);
      assert.deepEqual(trace.rest, raw.trace.rest);
      assert.equal(trace.weather.source, raw.trace.weather.source);
      assert.equal(trace.weather.totalEffect, raw.trace.weather.totalEffect);
    }
  }
  assert.ok(capped > 0, "exercise actual combined adjustments exceeding the cap");
});

test("unavailable datasets and unsupported weather/travel keep explicit existing fallback evidence", () => {
  assert.equal(computeExternalAdjustments2026(null, { week: 10 }).active, false);
  const input = structuredClone(dataset);
  input.factors.timezone.awayEast2.n = 0;
  const result = computeExternalAdjustments2026(input, {
    away: "LAC", home: "BAL", week: 10, kickoff: "2026-11-15T18:00:00Z",
    weather: { weatherAvailable: false },
  });
  assert.equal(result.active, true);
  assert.equal(result.trace.travel.source, "static-fallback");
  assert.equal(result.trace.travel.n, 0);
  assert.equal(result.weatherTotalEffect, null);
  assert.equal(result.trace.weather.source, "static-only");
});
