import test from "node:test";
import assert from "node:assert/strict";
import { createPredictionLedgerHandler, pickedWinProbability } from "../api/nfl/game-stats.js";

// A stand-in Supabase query that records the columns asked for.
function fakeClient(rows) {
  const calls = { select: [] };
  const query = {
    select(columns) { calls.select.push(columns); return query; },
    order() { return query; },
    eq() { return query; },
    then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
  };
  return { calls, client: { from: () => query } };
}

function response() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}

const gradedRow = {
  id: 7, game_key: "2026:11:BUF:KC", season: 2026, week: 11, kickoff: "2026-11-22T21:25:00Z",
  away_code: "BUF", home_code: "KC", fourth_down_pick: "KC", predicted_away_score: 23, predicted_home_score: 26,
  away_win_probability: 0.41, home_win_probability: 0.59, market_pick: "KC", actual_away_score: 20,
  actual_home_score: 27, actual_winner: "KC", fourth_down_correct: true, market_correct: true,
  graded_at: "2026-11-23T02:00:00Z", created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-23T02:00:00Z",
};

test("the Results view reads only plain columns, never the large stored detail", async () => {
  const { calls, client } = fakeClient([gradedRow]);
  const res = response();
  await createPredictionLedgerHandler({ createClient: () => client })(
    { method: "GET", query: { action: "predictions", view: "results" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.select.length, 1);
  assert.notEqual(calls.select[0], "*");
  assert.doesNotMatch(calls.select[0], /data_quality|active_layers/);
  const [row] = res.body.snapshots;
  assert.equal(row.week, 11);
  assert.equal(row.actualWinner, "KC");
  assert.equal(row.fourthDownCorrect, true);
  assert.equal(row.fourthDownWinnerProbability, 0.59);
});

test("other ledger reads still return full rows", async () => {
  const { calls, client } = fakeClient([]);
  await createPredictionLedgerHandler({ createClient: () => client })(
    { method: "GET", query: { action: "predictions", season: "2026", week: "12" }, headers: {} }, response());
  assert.deepEqual(calls.select, ["*"]);
});

test("the pick's win probability comes from the picked side", () => {
  assert.equal(pickedWinProbability({ fourthDownPick: "KC", homeCode: "KC", awayCode: "BUF", fourthDownHomeWinProbability: 0.59, fourthDownAwayWinProbability: 0.41 }), 0.59);
  assert.equal(pickedWinProbability({ fourthDownPick: "BUF", homeCode: "KC", awayCode: "BUF", fourthDownHomeWinProbability: 0.59, fourthDownAwayWinProbability: 0.41 }), 0.41);
  assert.equal(pickedWinProbability({ fourthDownPick: null, homeCode: "KC", awayCode: "BUF", fourthDownHomeWinProbability: 0.59 }), null);
  assert.equal(pickedWinProbability({ fourthDownPick: "KC", homeCode: "KC", awayCode: "BUF", fourthDownHomeWinProbability: null }), null);
});
