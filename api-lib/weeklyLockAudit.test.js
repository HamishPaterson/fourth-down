import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { buildLockManifest, summarizeLockExecution, saveWeeklyLockPlan } from "./weeklyLockAudit.js";
import { lockFixture, lockDatabase, FUTURE_LOCK } from "./weeklyLockTestHelpers.js";
import { evaluateWeeklyMultiReadiness } from "./weeklyMultiReadiness.js";

test("immutable audit migration applies/reapplies locally and preserves existing historical rows", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role;");
    await db.exec(readFileSync(new URL("../supabase/weekly_best_multis.sql", import.meta.url), "utf8"));
    await db.exec(`insert into public.weekly_best_multis
      (season,week,lock_at,locked_at,legs,model_probability_threshold,status,partial,odds_cache_status)
      values (2026,6,'2026-10-15T00:00Z','2026-10-15T00:00Z','[]',.55,'partial',true,'unavailable')`);
    const before = (await db.query("select * from public.weekly_best_multis")).rows;
    const sql = readFileSync(new URL("../supabase/weekly_multi_lock_audit.sql", import.meta.url), "utf8");
    await db.exec(sql); await db.exec(sql);
    const after = (await db.query("select * from public.weekly_best_multis")).rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].week, before[0].week);
    assert.deepEqual(after[0].legs, before[0].legs);
    assert.equal((await db.query("select * from public.weekly_best_multis where week=7")).rows.length, 0);
    const fixture = lockFixture();
    const manifest = buildLockManifest({ ...fixture, operationId: "00000000-0000-4000-8000-000000000002",
      readiness: evaluateWeeklyMultiReadiness(fixture), result: "READY" });
    await db.query(`insert into public.weekly_multi_lock_manifests
      (id,operation_id,season,week,lock_at,payload,sha256) values ($1,$2,$3,$4,$5,$6,$7)`,
    [manifest.id, manifest.operation_id, manifest.season, manifest.week, manifest.lock_at,
      JSON.stringify(manifest.payload), manifest.sha256]);
    await assert.rejects(db.query("update public.weekly_multi_lock_manifests set week=9 where id=$1", [manifest.id]),
      /cannot be updated or deleted/);
    await assert.rejects(db.query("delete from public.weekly_multi_lock_manifests where id=$1", [manifest.id]),
      /cannot be updated or deleted/);
    await assert.rejects(db.exec(`insert into public.weekly_best_multis
      (season,week,lock_at,locked_at,legs,model_probability_threshold,status,partial,odds_cache_status)
      values (2026,7,'2026-10-22T00:00Z',now(),'[]',.55,'partial',true,'unavailable')`),
    /Historical lock creation prohibited/);
    await assert.rejects(db.exec(`insert into public.weekly_best_multis
      (season,week,lock_at,locked_at,legs,model_probability_threshold,status,partial,odds_cache_status)
      values (2026,8,'2026-10-29T00:00Z',now(),'[]',.55,'partial',true,'fresh')`),
    /Ready immutable lock manifest required/);
    await assert.rejects(db.query(`insert into public.weekly_best_multis
      (season,week,lock_at,locked_at,legs,model_probability_threshold,status,partial,odds_cache_status,manifest_id)
      values (2026,8,'2026-10-29T00:00Z',now(),'[]',.55,'partial',true,'fresh',$1)`, [manifest.id]),
    /Complete five-leg lock required/);
    await db.query(`insert into public.weekly_best_multis
      (season,week,lock_at,locked_at,legs,model_probability_threshold,status,partial,odds_cache_status,manifest_id)
      values (2026,8,'2026-10-29T00:00Z',now(),$2,.55,'locked',false,'fresh',$1)`,
    [manifest.id, JSON.stringify(evaluateWeeklyMultiReadiness(fixture).selection.legs)]);
    const permissions = (await db.query(`select has_table_privilege('anon','public.weekly_multi_lock_manifests','select') as anon_read,
      has_table_privilege('service_role','public.weekly_multi_lock_manifests','insert') as service_insert,
      has_table_privilege('service_role','public.weekly_multi_lock_manifests','update') as service_update`)).rows[0];
    assert.deepEqual(permissions, { anon_read: false, service_insert: true, service_update: false });
  } finally { await db.close(); }
});

test("explicit administrative plan writer only accepts complete future pre-lock schedule context", async () => {
  const fixture = lockFixture(), db = lockDatabase({ ...fixture, plan: null });
  const context = { season: 2026, week: 8, lockAt: FUTURE_LOCK,
    games: fixture.plan.games.map((game) => ({ visitor_team: { abbreviation: game.away },
      home_team: { abbreviation: game.home }, date: game.kickoff })) };
  const saved = await saveWeeklyLockPlan(db, context, new Date("2026-10-28T23:00:00Z"));
  assert.equal(saved.expected_game_count, 5);
  assert.equal(db.tables.weekly_multi_lock_plans.length, 1);
  const reused = await saveWeeklyLockPlan(db, context, new Date("2026-10-28T23:30:00Z"));
  assert.equal(reused.id, saved.id);
  await assert.rejects(saveWeeklyLockPlan(db, { ...context, games: context.games.slice(1) },
    new Date("2026-10-28T23:30:00Z")), /IMMUTABLE_LOCK_PLAN_CONFLICT/);
  await assert.rejects(saveWeeklyLockPlan(db, context, new Date(FUTURE_LOCK)), /INVALID_PRE_LOCK_PLAN/);
});

for (const [records, expected] of [
  [[], { status: "UNKNOWN", reason: "NO_INVOCATION_RECORDED" }],
  [[{ stage: "STARTED", authorization_result: "AUTHORIZED", operation_id: "op" }],
    { status: "UNKNOWN", reason: "HANDLER_INCOMPLETE", operationId: "op" }],
  [[{ stage: "STARTED", authorization_result: "DENIED" }], { status: "AUTHORIZATION_FAILED" }],
  [[{ stage: "FAILED", result: "PIPELINE_FAILED", failure_code: "INPUT_OR_AUDIT_UNAVAILABLE" }],
    { status: "HANDLER_FAILED", code: "INPUT_OR_AUDIT_UNAVAILABLE" }],
  [[{ stage: "FINISHED", result: "READINESS_FAILED" }], { status: "READINESS_FAILED" }],
  [[{ stage: "FINISHED", result: "LOCK_ALREADY_EXISTED", operation_id: "op" }],
    { status: "LOCK_ALREADY_EXISTED", operationId: "op" }],
  [[{ stage: "FINISHED", result: "LOCK_SUCCEEDED", operation_id: "op" }],
    { status: "LOCK_SUCCEEDED", operationId: "op" }],
]) {
  test(`execution summary distinguishes ${expected.status}/${expected.reason || "result"}`, () => {
    assert.deepEqual(summarizeLockExecution(records.map((row) => ({ ...row, scheduled_at: FUTURE_LOCK })), FUTURE_LOCK), expected);
  });
}
