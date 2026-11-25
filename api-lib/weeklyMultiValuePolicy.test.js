import test from "node:test";
import assert from "node:assert/strict";
import { MULTI_VALUE_POLICY, selectValueLegs, temperedValue } from "./weeklyMultiValuePolicy.js";
import { createWeeklyMultiPreparationHandler } from "./weeklyMultiPreparation.js";
import { lockFixture, lockDatabase, lockResponse } from "./weeklyLockTestHelpers.js";

const row = (id, decimalOdds, modelProbability, marketFamily = "moneyline", policy = MULTI_VALUE_POLICY) => {
  const bet = { matchupKey: id, selection: id, decimalOdds, modelProbability, marketFamily, impliedProbability: 1 / decimalOdds };
  return { ...bet, tempered: temperedValue(bet, policy) };
};
const pick = (rows, policy = MULTI_VALUE_POLICY) => selectValueLegs(rows, policy, 5);

test("tempering keeps only the demonstrated share of the disagreement", () => {
  assert.deepEqual(row("SF", 2, .8).tempered, { weight: .4, probability: .62, expectedValue: .24 });
  assert.equal(row("SF", 2, .8, "spread").tempered.probability, .56);
  assert.equal(row("X", 2, .8, "other").tempered, null);
});

test("moneylines and spreads compete on value alone, one leg per matchup", () => {
  const rows = [row("A", 1.58, .84), row("B", 1.94, .82, "spread"), row("B", 1.32, .9), row("C", 2, .77, "spread"),
    row("D", 1.45, .757), row("E", 1.31, .829), row("F", 1.215, .9)];
  const { legs } = pick(rows);
  assert.equal(legs.length, 5);
  assert.deepEqual(legs.map((leg) => leg.selection + ":" + leg.marketFamily),
    ["A:moneyline", "B:spread", "C:spread", "D:moneyline", "F:moneyline"]);
  for (let i = 1; i < legs.length; i++) assert.ok(legs[i - 1].tempered.expectedValue >= legs[i].tempered.expectedValue);
});

test("totals and props are in the pool and earn a leg as soon as their record gives them weight", () => {
  const families = ["total", "rushing-props", "receiving-props", "passing-props", "anytime-td"];
  const moneylines = ["A", "B", "C", "D", "E"].map((id) => row(id, 1.4, .8));
  for (const family of families) {
    assert.ok(row("X", 1.9, .95, family).tempered, family);
    assert.equal(pick([row("X", 1.9, .95, family)]).legs.length, 0, family + " has no demonstrated edge yet");
    const earned = { ...MULTI_VALUE_POLICY, weights: { ...MULTI_VALUE_POLICY.weights, [family]: .4 } };
    const { legs } = pick([...moneylines, row("X", 1.9, .8, family, earned)], earned);
    assert.equal(legs[0].marketFamily, family);
  }
});

test("long shots and bets without value stay out, and a short set is reported rather than padded", () => {
  const { legs } = pick([row("LONG", 3.65, .6), row("COIN", 2.22, .638), row("NOEDGE", 1.5, .6), row("A", 1.58, .84)]);
  assert.deepEqual(legs.map((leg) => leg.selection), ["A"]);
});

test("the stored threshold fits the weekly_best_multis constraint", () => {
  for (const rows of [[], [row("A", 1.58, .84)]]) {
    const { threshold } = pick(rows);
    assert.ok(threshold >= .55 && threshold <= .65);
  }
});

test("the production lock uses this policy and stays not ready without five legs", async () => {
  const run = async (mutate = () => {}) => {
    const fixture = lockFixture(); mutate(fixture);
    const db = lockDatabase(fixture), res = lockResponse(), previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "fixture-only-secret";
    try {
      await createWeeklyMultiPreparationHandler({ createClient: () => db, getNow: () => fixture.now, readOdds: async () => fixture.odds })(
        { method: "GET", headers: { authorization: "Bearer fixture-only-secret" }, query: {} }, res);
    } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
    return { res, db };
  };
  const locked = await run();
  assert.equal(locked.res.body.status, "locked");
  assert.equal(locked.res.body.record.legs.length, 5);
  assert.equal(locked.res.body.record.model_probability_threshold, .55);
  assert.ok(locked.res.body.record.legs.every((leg) => leg.tempered.probability >= .55));
  const short = await run((fixture) => { fixture.predictions[0].bestBets.candidates = []; });
  assert.equal(short.res.body.status, "not ready");
  assert.equal(short.db.tables.weekly_best_multis.length, 0);
});
