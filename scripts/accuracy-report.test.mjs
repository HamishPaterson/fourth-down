import test from "node:test";
import assert from "node:assert/strict";
import { accuracyReport } from "./accuracy-report.mjs";

const row = (model_version, away, home, extra = {}) => ({ model_version, predicted_away_score: 24, predicted_home_score: 20,
  away_win_probability: 0.65, home_win_probability: 0.35, market_away_score: 23, market_home_score: 21, market_total: 45,
  actual_away_score: away, actual_home_score: home, fourth_down_correct: away > home, market_correct: away > home, ...extra });

test("the report scores the newest model only and leaves out incomplete games", () => {
  const rows = [row("12", 27, 17), row("12", 14, 21), row("11", 30, 10), row("12", 20, 10, { away_win_probability: null }),
    row("12", null, null), row(null, 21, 20)];
  const r = accuracyReport(rows);
  assert.equal(r.version, "12");
  assert.deepEqual(r.versions, ["12", "11"]);
  assert.equal(r.games, 2);
  assert.equal(r.leftOut, 3);
  assert.equal(r.winnerPicks.model, 0.5);
  assert.equal(r.againstSpread.rate, 0.5, "+4 predicted vs +2 line: won at +10, lost at -7");
  assert.equal(r.overUnder.rate, 1, "44 predicted against 45 is an under; both games finished under");
  assert.equal(r.calibration[1].games, 2);
  assert.equal(accuracyReport(rows, "all").games, 4);
});
