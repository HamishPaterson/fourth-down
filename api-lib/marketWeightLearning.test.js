import test from "node:test";
import assert from "node:assert/strict";
import { MAX_WEIGHT, MIN_GRADED_BETS, fitWeight, gradeTeamBet, gradedObservations, learnValuePolicy } from "./marketWeightLearning.js";
import { MULTI_VALUE_POLICY } from "./weeklyMultiValuePolicy.js";
import { createWeeklyMultiPreparationHandler } from "./weeklyMultiPreparation.js";
import { lockFixture, lockDatabase, lockResponse } from "./weeklyLockTestHelpers.js";

const game = (actualAwayScore, actualHomeScore) => ({ awayCode: "KC", homeCode: "DEN", actualAwayScore, actualHomeScore });

test("team bets are graded from the final score, with pushes left out", () => {
  assert.equal(gradeTeamBet({ market: "Moneyline", teamCode: "KC", selection: "KC" }, game(24, 20)), "won");
  assert.equal(gradeTeamBet({ market: "Moneyline", selection: "DEN" }, game(24, 20)), "lost");
  assert.equal(gradeTeamBet({ market: "Spread", teamCode: "KC", selection: "KC -3.5", line: -3.5 }, game(24, 20)), "won");
  assert.equal(gradeTeamBet({ market: "Spread", teamCode: "KC", selection: "KC -4", line: -4 }, game(24, 20)), null);
  assert.equal(gradeTeamBet({ market: "Spread", teamCode: "DEN", selection: "DEN +3.5", line: 3.5 }, game(24, 20)), "lost");
  assert.equal(gradeTeamBet({ market: "Game total", selection: "Over 43.5", line: 43.5 }, game(24, 20)), "won");
  assert.equal(gradeTeamBet({ market: "Game total", selection: "Under 43.5", line: 43.5 }, game(24, 20)), "lost");
  assert.equal(gradeTeamBet({ market: "Game total", selection: "Over 44", line: 44 }, game(24, 20)), null);
  assert.equal(gradeTeamBet({ market: "Receiving yards", selection: "Over 60.5", line: 60.5 }, game(24, 20)), null);
  assert.equal(gradeTeamBet({ market: "Moneyline", selection: "KC" }, game(null, 20)), null);
});

test("only graded pre-kickoff predictions from earlier weeks count", () => {
  const bet = { market: "Moneyline", teamCode: "KC", selection: "KC", decimalOdds: 1.5, modelProbability: 0.8 };
  const row = (week, extra = {}) => ({ ...game(24, 20), week, kickoff: "2026-11-01T18:00:00Z",
    generatedAt: "2026-10-30T00:00:00Z", gradedAt: "2026-11-02T09:00:00Z", candidates: [bet], ...extra });
  const observations = gradedObservations([row(10), row(12), row(9, { gradedAt: null }),
    row(9, { generatedAt: "2026-11-01T19:00:00Z" })], 12);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], { family: "moneyline", week: 10, won: true, impliedProbability: 1 / 1.5,
    modelProbability: 0.8, decimalOdds: 1.5 });
});

const bets = (count, winRate, modelProbability = 0.8, decimalOdds = 2) => Array.from({ length: count }, (_, index) =>
  ({ family: "moneyline", won: index < Math.round(count * winRate), impliedProbability: 1 / decimalOdds, modelProbability, decimalOdds }));

test("the fitted weight follows the results and never exceeds the cap", () => {
  assert.equal(fitWeight(bets(100, 0.5)), 0, "results matched the bookmaker");
  assert.equal(fitWeight(bets(100, 0.65)), 0.5, "0.65 is half way from 0.5 to 0.8");
  assert.equal(fitWeight(bets(100, 0.6)), 0.35);
  assert.equal(fitWeight(bets(100, 0.9)), MAX_WEIGHT, "even a model that beat its own claim is capped");
  assert.equal(fitWeight(bets(100, 0.3)), 0, "worse than the bookmaker");
});

test("a market with too few graded bets keeps its standing weight", () => {
  assert.equal(fitWeight(bets(MIN_GRADED_BETS - 1, 0.5), 0.4), 0.4);
  const policy = learnValuePolicy([]);
  assert.deepEqual(policy.weights, MULTI_VALUE_POLICY.weights);
  assert.equal(policy.minimumProbability, MULTI_VALUE_POLICY.minimumProbability);
  const learned = learnValuePolicy(bets(100, 0.5));
  assert.equal(learned.weights.moneyline, 0);
  assert.equal(learned.weights.spread, MULTI_VALUE_POLICY.weights.spread);
  assert.deepEqual(learned.evidence.moneyline, { bets: 100, won: 50, returnPerBet: 0 });
});

test("the production Multi is prepared with weights refitted for its week", async () => {
  const fixture = lockFixture(), db = lockDatabase(fixture), res = lockResponse(), previous = process.env.CRON_SECRET;
  const asked = [];
  process.env.CRON_SECRET = "fixture-only-secret";
  try {
    await createWeeklyMultiPreparationHandler({ createClient: () => db, getNow: () => fixture.now, readOdds: async () => fixture.odds,
      learnPolicy: async (client, season, week) => { asked.push([client, season, week]); return learnValuePolicy([]); } })(
      { method: "GET", headers: { authorization: "Bearer fixture-only-secret" }, query: { dryRun: "1" } }, res);
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
  assert.deepEqual(asked, [[db, fixture.plan.season, fixture.plan.week]]);
  assert.equal(db.tables.weekly_best_multis.length, 0);
});
