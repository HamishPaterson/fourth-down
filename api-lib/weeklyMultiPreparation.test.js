import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWeeklyMultiPreparationHandler } from "./weeklyMultiPreparation.js";
import { createWeeklyMultiLockHandler, createWeeklyMultiCurrentHandler, getLockCycle,
  isGeneratedLate, lockIsPastDeadline } from "./weeklyMulti.js";
import { lockFixture, lockDatabase, lockResponse, FUTURE_LOCK } from "./weeklyLockTestHelpers.js";
import { buildLockManifest } from "./weeklyLockAudit.js";

async function run({ fixture = lockFixture(), db = lockDatabase(fixture), prepare = false,
  authorized = true, dryRun = false, handlerFactory = createWeeklyMultiPreparationHandler, ...overrides } = {}) {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "fixture-only-secret";
  const res = lockResponse();
  try {
    await handlerFactory({ createClient: () => db, getNow: () => fixture.now,
      readOdds: async () => fixture.odds, ...overrides })({
      method: "GET", headers: { authorization: authorized ? "Bearer fixture-only-secret" : "Bearer denied" },
      query: { weeklyMultiMode: prepare ? "prepare" : "lock", dryRun: dryRun ? "1" : "0" },
    }, res);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  }
  return { res, db };
}

test("saved-only locking accepts current core legs despite stale totals, with immutable manifest reference", async () => {
  const { res, db } = await run({
    generatePrediction: () => assert.fail("No prediction generation"), fetchOdds: () => assert.fail("No provider request"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "locked");
  assert.equal(res.body.record.legs.length, 5);
  assert.equal(res.body.record.lock_at, FUTURE_LOCK);
  assert.equal(res.body.record.generated_late, false);
  assert.equal(db.tables.weekly_multi_lock_manifests.length, 2);
  assert.equal(res.body.record.manifest_id, db.tables.weekly_multi_lock_manifests[1].id);
  assert.equal(db.tables.weekly_multi_lock_manifests[0].payload.preparationResult, "INPUTS_CAPTURED");
  assert.equal(db.tables.weekly_multi_lock_manifests[1].payload.parentId, db.tables.weekly_multi_lock_manifests[0].id);
  assert.equal(db.writes.some((write) => write.table === "prediction_snapshots"), false);
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "LOCK_SUCCEEDED");
  assert.equal(db.tables.weekly_multi_lock_manifests[0].payload.consideredCandidates.length, 5);
  assert.equal(db.tables.weekly_multi_lock_manifests[0].payload.consideredCandidates[0].modelProbability, .7);
});

test("zero eligible candidates has its own execution outcome and retains rejection evidence", async () => {
  const fixture = lockFixture();
  for (const prediction of fixture.predictions) prediction.bestBets.candidates[0].modelProbability = .4;
  const { res, db } = await run({ fixture });
  assert.equal(res.body.status, "not ready");
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "NO_ELIGIBLE_CANDIDATES");
  assert.equal(db.tables.weekly_best_multis.length, 0);
  assert.equal(db.tables.weekly_multi_lock_manifests.at(-1).payload.candidates.length, 5);
});

test("a post-insert audit failure reports that the lock actually succeeded instead of claiming no lock", async () => {
  const { recordLockExecution } = await import("./weeklyLockAudit.js");
  const { res, db } = await run({ recordExecution: async (client, record) => {
    if (record.result === "LOCK_SUCCEEDED") throw new Error("fixture-audit-unavailable");
    return recordLockExecution(client, record);
  } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.lockResult, "SUCCEEDED");
  assert.equal(db.tables.weekly_best_multis.length, 1);
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).lock_result, "SUCCEEDED");
});

for (const offset of [-60000, 0, 60000]) {
  test(`valid inputs lock immediately ${offset / 60000} minutes from the former scheduled time`, async () => {
    const fixture = lockFixture();
    fixture.now = new Date(Date.parse(FUTURE_LOCK) + offset);
    const result = await run({ fixture });
    assert.equal(result.res.body.status, "locked");
    assert.equal(result.db.tables.weekly_best_multis.length, 1);
  });
}

test("prepare also locks valid retained inputs immediately without prediction writes", async () => {
  const fixture = lockFixture(); fixture.now = new Date("2026-10-28T23:30:00Z");
  const { res, db } = await run({ fixture, prepare: true });
  assert.equal(res.body.status, "locked");
  assert.equal(db.tables.weekly_best_multis.length, 1);
  assert.ok(db.writes.every((row) => row.table !== "prediction_snapshots"));
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "LOCK_SUCCEEDED");
  const current = lockResponse();
  await createWeeklyMultiCurrentHandler({
    createClient: () => db, getNow: () => fixture.now,
    fetchGames: () => assert.fail("An early current-week lock must be returned without a schedule lookup"),
  })({ method: "GET" }, current);
  assert.equal(current.body.status, "locked");
  assert.deepEqual(current.body.record, res.body.record);
});

test("dry-run evaluation persists audit evidence, never predictions or a Multi", async () => {
  const { res, db } = await run({ dryRun: true });
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.readiness.selection.legs.length, 5);
  assert.equal(db.tables.weekly_best_multis.length, 0);
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "DRY_RUN");
});

test("insufficient candidates retain structured failed-preparation manifest without empty/partial fake lock", async () => {
  const fixture = lockFixture();
  fixture.predictions[0].bestBets.candidates = [];
  const { res, db } = await run({ fixture });
  assert.equal(res.body.status, "not ready");
  assert.equal(db.tables.weekly_best_multis.length, 0);
  const manifest = db.tables.weekly_multi_lock_manifests.at(-1);
  assert.equal(manifest.payload.preparationResult, "READINESS_FAILED");
  assert.ok(manifest.payload.readiness.blockingReasons.includes("INSUFFICIENT_ELIGIBLE_MATCHUPS"));
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "READINESS_FAILED");
});

test("incomplete inputs become lockable on the next normal invocation, on any polling day", async () => {
  const fixture = lockFixture();
  fixture.now = new Date("2026-10-30T00:01:00Z");
  for (const row of fixture.predictions) row.generatedAt = "2026-10-29T23:50:00Z";
  const db = lockDatabase(fixture);
  const missing = db.tables.prediction_snapshots.pop();
  const first = await run({ fixture, db, prepare: true });
  assert.equal(first.res.body.status, "not ready");
  assert.equal(db.tables.weekly_best_multis.length, 0);
  db.tables.prediction_snapshots.push(missing);
  const second = await run({ fixture, db, prepare: true });
  assert.equal(second.res.body.status, "locked");
  const saved = structuredClone(second.res.body.record);
  db.tables.prediction_snapshots = [];
  fixture.odds = null;
  for (const prepare of [false, true]) {
    const again = await run({ fixture, db, prepare,
      readOdds: () => assert.fail("Cannot regenerate an existing lock") });
    assert.deepEqual(again.res.body.record, saved);
  }
  assert.equal(db.tables.weekly_best_multis.length, 1);
});

test("all expected authoritative predictions are required, not merely five arbitrary saved rows", async () => {
  const fixture = lockFixture();
  fixture.predictions[0].authoritative = false;
  const { res, db } = await run({ fixture });
  assert.equal(res.body.status, "not ready");
  assert.ok(res.body.readiness.blockingReasons.includes("AUTHORITATIVE_PREDICTIONS_NOT_READY"));
  assert.equal(db.tables.weekly_best_multis.length, 0);
  const rejection = db.tables.weekly_multi_lock_manifests.at(-1).payload.candidates
    .find((candidate) => candidate.predictionId === fixture.predictions[0].id);
  assert.equal(rejection.finalEligibility, false);
  assert.ok(rejection.rejectionCodes.includes("MISSING_AUTHORITY"));
});

test("availability polling after the former deadline locks without a generated-late flag", async () => {
  const fixture = lockFixture(); fixture.now = new Date("2026-10-29T01:00:00Z");
  const { res } = await run({ fixture });
  assert.equal(res.body.status, "locked");
  assert.equal(res.body.record.generated_late, false);
  assert.ok(res.body.record.legs.every((leg) => leg.updatedAt < FUTURE_LOCK));
});

test("new valid saved predictions after the former deadline can lock an unlocked week", async () => {
  const fixture = lockFixture(); fixture.now = new Date("2026-10-29T01:00:00Z");
  for (const row of fixture.predictions) row.generatedAt = "2026-10-29T00:10:00Z";
  for (const [index, row] of fixture.predictions.entries()) {
    const updatedAt = "2026-10-29T00:05:00Z";
    row.bestBets.candidates[0].updatedAt = updatedAt;
    const quote = fixture.odds.events[index].bookmakers[0].markets[0].outcomes[0];
    quote.updatedAt = updatedAt;
    quote.quoteSource.timestamp = updatedAt;
    quote.quoteSource.fetchedAt = updatedAt;
  }
  const { res, db } = await run({ fixture });
  assert.equal(res.body.status, "locked");
  assert.equal(db.tables.weekly_best_multis.length, 1);
  assert.ok(res.body.record.legs.every((leg) => leg.updatedAt > FUTURE_LOCK));
  assert.equal(db.writes.some((row) => row.table === "prediction_snapshots"), false);
});

test("existing locks are returned byte-for-byte and do not reacquire inputs", async () => {
  const fixture = lockFixture();
  const saved = { season: 2026, week: 8, lock_at: FUTURE_LOCK, legs: [{ historical: true }], status: "locked" };
  const db = lockDatabase(fixture, { existing: [saved] });
  const { res } = await run({ fixture, db, readOdds: () => assert.fail("Existing lock cannot read odds") });
  assert.deepEqual(res.body.record, saved);
  assert.deepEqual(db.tables.weekly_best_multis, [saved]);
  assert.equal(db.tables.weekly_multi_lock_manifests.length, 0);
  assert.equal(db.tables.weekly_multi_lock_executions.at(-1).result, "LOCK_ALREADY_EXISTED");
});

test("the legacy lock export reaches the same strict audited pipeline", async () => {
  const { res } = await run({ handlerFactory: createWeeklyMultiLockHandler });
  assert.equal(res.body.status, "locked");
  assert.ok(res.body.record.manifest_id);
});

test("authorization denial is recorded with no secret/header/input access", async () => {
  const { res, db } = await run({ authorized: false, readOdds: () => assert.fail("Unauthorized input access") });
  assert.equal(res.statusCode, 401);
  assert.equal(db.tables.weekly_multi_lock_executions[0].result, "AUTHORIZATION_FAILED");
  assert.equal(db.tables.weekly_multi_lock_executions[0].authorization_result, "DENIED");
  assert.equal(db.tables.weekly_best_multis.length, 0);
  assert.doesNotMatch(JSON.stringify(db.tables), /fixture-only-secret|Bearer denied/);
});

for (const table of ["weekly_multi_lock_executions", "weekly_multi_lock_manifests",
  "weekly_multi_lock_plans", "prediction_snapshots", "weekly_best_multis"]) {
  test(`missing/broken ${table} fails closed without prediction writes`, async () => {
    const fixture = lockFixture(), db = lockDatabase(fixture, { failTable: table });
    const { res } = await run({ fixture, db });
    assert.equal(res.statusCode, 503);
    assert.equal(db.tables.weekly_best_multis.length, 0);
    assert.doesNotMatch(JSON.stringify(res.body), /secret-remote-error/);
    assert.ok(db.writes.every((row) => row.table !== "prediction_snapshots"));
  });
}

test("failed preparation reads retain a safe failure manifest, not arbitrary exception messages", async () => {
  const { res, db } = await run({ readOdds: () => { throw new Error("secret-remote-error"); } });
  assert.equal(res.statusCode, 503);
  assert.equal(db.tables.weekly_multi_lock_manifests.at(-1).payload.preparationResult, "INPUT_OR_AUDIT_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(db.tables), /secret-remote-error/);
});

for (const now of ["2026-10-22T00:00:00Z", "2026-10-22T07:00:00Z", "2026-10-23T00:01:00Z"]) {
  test(`Week 7 stays missing at ${now}; current inputs cannot reconstruct the 10am lock`, async () => {
    const fixture = lockFixture(); fixture.now = new Date(now);
    fixture.plan.week = 7; fixture.plan.lock_at = "2026-10-22T00:00:00Z";
    const db = lockDatabase(fixture), before = structuredClone(db.tables.prediction_snapshots);
    const { res } = await run({ fixture, db, readOdds: () => assert.fail("No historical odds substitution") });
    assert.equal(res.body.reason, "HISTORICAL_LOCK_PROHIBITED");
    assert.equal(db.tables.weekly_best_multis.length, 0);
    assert.deepEqual(db.tables.prediction_snapshots, before);
  });
}

test("existing Week 7 records are untouched and their display is not relabelled", async () => {
  const fixture = lockFixture(); fixture.now = new Date("2026-10-22T07:00:00Z");
  const legacy = { season: 2026, week: 6, lock_at: "2026-10-15T00:00:00Z", legs: [], status: "partial" };
  const db = lockDatabase(fixture, { existing: [legacy] });
  await run({ fixture, db });
  assert.deepEqual(db.tables.weekly_best_multis, [legacy]);
  const res = lockResponse();
  await createWeeklyMultiCurrentHandler({ getNow: () => fixture.now, createClient: () => db,
    resolveDisplayContext: async () => ({ available: true, season: 2026, week: 7,
      lockAt: "2026-10-22T00:00:00Z", firstKickoffAt: "2026-10-23T00:15:00Z" }),
  })({ method: "GET" }, res);
  assert.equal(res.body.locked, false);
  assert.equal(db.tables.weekly_best_multis.length, 1);
});

test("manifest contains safe exact inputs, ranking values and selected quote provenance", () => {
  const fixture = lockFixture();
  fixture.predictions[0].authorization = "never-store-this";
  fixture.odds.events[0].rawProviderBody = "never-store-this";
  const manifest = buildLockManifest({ operationId: "00000000-0000-4000-8000-000000000002",
    ...fixture, result: "INPUTS_CAPTURED" });
  assert.equal(manifest.payload.predictions.length, 5);
  assert.equal(manifest.payload.quotes.length, 15);
  assert.equal(manifest.payload.quotes[0].provider, "SharpAPI");
  assert.equal(manifest.payload.quotes[0].quoteAt, "2026-10-28T23:00:00.000Z");
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(manifest), /never-store-this|authorization|rawProviderBody/);
});

test("legacy timestamp interpretation and existing availability polls remain compatible", () => {
  const context = { lockAt: FUTURE_LOCK, retryDeadline: Date.parse(FUTURE_LOCK) + 30 * 60000 };
  assert.equal(isGeneratedLate(context, new Date(Date.parse(FUTURE_LOCK) + 15 * 60000)), false);
  assert.equal(isGeneratedLate(context, new Date(Date.parse(FUTURE_LOCK) + 15 * 60000 + 1)), true);
  assert.equal(lockIsPastDeadline(context, new Date(context.retryDeadline)), true);
  assert.equal(getLockCycle(new Date(FUTURE_LOCK)).lockAt, Date.parse(FUTURE_LOCK));
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.crons.filter((job) => job.path === "/api/weekly-multi/lock")
    .map((job) => job.schedule), ["0 0 * * *", "0 1 * * *"]);
});

function atomicBatchFixture() {
  const fixture = lockFixture();
  for (const [index, row] of fixture.predictions.entries()) {
    delete row.lockProvenance;
    row.id = `8:${row.awayCode}:${row.homeCode}`;
    row.generatedAt = "2026-10-28T05:36:59.000Z";
    row.batchProvenance = { version: 1, source: "server-week-replacement", operationId: "23b1c421-93c5-4e3c-b820-8d1a3b647e8e" };
    row.generationMarketDependencies = [];
    for (const bet of row.bestBets.candidates) bet.updatedAt = "2026-10-27T12:34:16.012515305Z";
    for (const bet of row.bestBets.recommendations) bet.updatedAt = "2026-10-27T12:34:16.012515305Z";
    const outcome = fixture.odds.events[index].bookmakers[0].markets[0].outcomes[0];
    outcome.updatedAt = "2026-10-27T12:34:16.012515305Z";
    outcome.quoteValidation = { status: "validated" };
    outcome.quoteSource = { id: `q${index}`, provider: "SharpAPI",
      timestamp: "2026-10-27T12:34:16.012515305Z", fetchedAt: "2026-10-27T12:34:16.012515305Z" };
    // The atomic batch embeds the exact pre-lock odds event in each snapshot.
    row.game = { id: `game${index}`, oddsEvent: fixture.odds.events[index] };
  }
  return fixture;
}

test("fresh atomic batch derives its plan before the former deadline, locks once, and is idempotent", async () => {
  const fixture = atomicBatchFixture();
  fixture.plan = null; // no pre-lock plan was ever saved
  fixture.now = new Date("2026-10-28T23:30:00Z");
  for (const [index, row] of fixture.predictions.entries()) {
    row.generatedAt = "2026-10-28T23:00:00Z";
    row.bestBets.candidates[0].updatedAt = "2026-10-28T22:00:00Z";
    const outcome = row.game.oddsEvent.bookmakers[0].markets[0].outcomes[0];
    outcome.updatedAt = "2026-10-28T22:00:00Z";
    outcome.quoteSource = { id: `q${index}`, provider: "SharpAPI",
      timestamp: outcome.updatedAt, fetchedAt: outcome.updatedAt };
  }
  const db = lockDatabase(fixture);
  const first = await run({ fixture, db });
  assert.equal(first.res.body.status, "locked", JSON.stringify(first.res.body));
  assert.equal(first.res.body.record.week, 8);
  assert.equal(first.res.body.record.legs.length, 5);
  assert.equal(db.tables.weekly_best_multis.length, 1);
  assert.equal(db.writes.some((row) => row.table === "prediction_snapshots"), false);
  // A second invocation returns the same record without duplication.
  const second = await run({ fixture, db });
  assert.equal(second.res.body.status, "already locked");
  assert.equal(second.res.body.record.lock_at, first.res.body.record.lock_at);
  assert.equal(db.tables.weekly_best_multis.length, 1);
});

test("a partially refreshed week cannot lock; the same rows lock once the full plan exists", async () => {
  // Five of six scheduled games are saved, each individually lock-eligible.
  const fixture = lockFixture();
  const savedPlan = fixture.plan;
  fixture.plan = null;
  const partial = lockDatabase(fixture);
  for (const prepare of [true, false]) {
    const { res } = await run({ fixture, db: partial, prepare });
    assert.equal(res.body.status, "not ready");
    assert.deepEqual(res.body.readiness.blockingReasons.includes("LOCK_PLAN_UNAVAILABLE_OR_INVALID"), true);
  }
  assert.equal(partial.tables.weekly_best_multis.length, 0);

  const full = { ...savedPlan, expected_game_count: 6,
    games: [...savedPlan.games, { away: "KC", home: "BUF", kickoff: savedPlan.games[0].kickoff }] };
  const missing = await run({ fixture: { ...fixture, plan: full } });
  assert.equal(missing.res.body.status, "not ready");
  assert.ok(missing.res.body.readiness.blockingReasons.includes("PREDICTIONS_MISSING"));
  assert.equal(missing.db.tables.weekly_best_multis.length, 0);

  const complete = await run({ fixture: { ...fixture, plan: savedPlan } });
  assert.equal(complete.res.body.status, "locked");
});

for (const [label, mutate] of [
  ["mixed operations", (rows) => { rows[0].batchProvenance.operationId = "00000000-0000-4000-8000-000000000009"; }],
  ["a row outside the batch", (rows) => { delete rows[0].batchProvenance; }],
  ["no operation identity", (rows) => rows.forEach((row) => { delete row.batchProvenance.operationId; })],
]) {
  test(`a derived plan requires one atomic whole-week operation: ${label}`, async () => {
    const fixture = atomicBatchFixture();
    fixture.plan = null;
    fixture.now = new Date("2026-10-28T06:00:00Z");
    mutate(fixture.predictions);
    const db = lockDatabase(fixture);
    const { res } = await run({ fixture, db });
    assert.equal(res.body.status, "not ready");
    assert.ok(res.body.readiness.blockingReasons.includes("LOCK_PLAN_UNAVAILABLE_OR_INVALID"));
    assert.equal(db.tables.weekly_best_multis.length, 0);
  });
}

test("availability polling never fabricates a lock without a persisted authoritative batch", async () => {
  const fixture = atomicBatchFixture();
  fixture.plan = null;
  fixture.now = new Date("2026-11-02T06:00:00Z");
  for (const row of fixture.predictions) delete row.batchProvenance; // not the atomic batch
  const db = lockDatabase(fixture);
  const { res } = await run({ fixture, db });
  assert.equal(res.body.status, "not ready");
  assert.equal(db.tables.weekly_best_multis.length, 0);
});
