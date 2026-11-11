import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPredictionSnapshots, predictionSnapshotRow, groupSnapshotRows, isPreGameRow, predictionRows,
} from "./externalFactorsData.mjs";

const snapshot = {
  season: 2026, week: 9, kickoff: "2026-11-06T01:15:00Z", awayCode: "JAX", homeCode: "BAL",
  fourthDownAwayScore: 31, fourthDownHomeScore: 17,
  fourthDownAwayWinProbability: .862, fourthDownHomeWinProbability: .138, fourthDownPick: "JAX",
  modelVersion: "12", modelKey: "full-v12-special-teams-kicker-model",
  generatedAt: "2026-11-04T04:53:29Z", snapshotAt: "2026-11-04T04:52:59Z",
  updatedAt: "2026-11-04T04:54:11Z", savedBeforeKickoff: true,
  oddsPick: "BAL", marketSpread: -3, marketAwayScore: 20, marketHomeScore: 23, marketGameTotal: 43,
  game: { venue: "M&T Bank Stadium" }, predictionPayload: { total: 48 }, dataQuality: { available: true },
};

test("ledger adapter preserves prediction, identity, provenance and market semantics through reconciliation", () => {
  const raw = predictionSnapshotRow(snapshot);
  const { snapshots } = groupSnapshotRows([raw]);
  const row = snapshots.get("2026:9:JAX:BAL");
  assert.equal(isPreGameRow(row), true);
  assert.equal(row.modelKey, snapshot.modelKey);
  assert.equal(row.data_quality.snapshot.generatedAt, snapshot.generatedAt);
  assert.equal(row.snapshotAt, snapshot.snapshotAt);
  assert.deepEqual(row.data_quality.snapshot.predictionPayload, snapshot.predictionPayload);
  assert.deepEqual([raw.market_away_score, raw.market_home_score, raw.market_total], [20, 23, 43]);
  const [prediction] = predictionRows([{ snapshot: row, preGame: isPreGameRow(row),
    actualMargin: -7, actualWinner: "JAX", away: "JAX", home: "BAL" }]);
  assert.equal(prediction.predictedMargin, -14);
  assert.equal(prediction.marketMargin, 3);
  assert.equal(prediction.winnerProb, .862);
  assert.equal(prediction.currentModel, true);
  assert.equal(prediction.actualMargin, -7);
  assert.equal(prediction.modelPick, "JAX");
  assert.equal(prediction.marketPick, "BAL");
});

for (const change of [
  { savedBeforeKickoff: false }, { savedBeforeKickoff: undefined },
  { snapshotAt: undefined }, { snapshotAt: "invalid" },
  { snapshotAt: "2026-11-07T00:00:00Z" },
]) test(`unproven/backfilled ledger evidence remains excluded: ${JSON.stringify(change)}`, () => {
  const { snapshots } = groupSnapshotRows([predictionSnapshotRow({ ...snapshot, ...change })]);
  assert.equal(isPreGameRow([...snapshots.values()][0]), false);
});

test("weekly production ledger GET reads require no authorization and cover the complete season", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    const week = Number(new URL(url).searchParams.get("week"));
    return { ok: true, json: async () => ({ count: week === 9 ? 1 : 0,
      snapshots: week === 9 ? [snapshot] : [] }) };
  });
  assert.equal((await fetchPredictionSnapshots()).length, 1);
  assert.equal(requests.length, 18);
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://fourth-down-coral.vercel.app");
    assert.equal(url.searchParams.get("week"), String(index + 1));
    assert.deepEqual(request.options, { headers: { Accept: "application/json" } });
  }
});

test("ledger transport failure is explicit rather than an empty success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 500 }));
  await assert.rejects(fetchPredictionSnapshots(), /week 1 fetch failed \(500\)/);
});
