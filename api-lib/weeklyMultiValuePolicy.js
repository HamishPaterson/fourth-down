// How Weekly Multi legs are valued. Every market competes in one pool. These are the standing
// weights: marketWeightLearning.js refits them from graded results whenever the Multi is
// prepared, and a market keeps its standing weight until it has 30 graded bets. Each weight is the
// share of the model's disagreement with the bookmaker that graded results bore out
// (maximum likelihood), so a market with no demonstrated edge has no value to offer until
// its record improves. Graded through Week 11 of 2026:
//   moneyline 65 bets, 74% won, +12%   (leaving out single weeks moved the weight 0 to 0.8)
//   spread    64 bets, 58% won, +11%   (0 to 0.5)
//   total     18 bets, 50% won, -3%
//   props     1,066 saved lines, no rule clearly ahead of the bookmaker
export const MULTI_VALUE_POLICY = Object.freeze({
  weights: Object.freeze({
    moneyline: 0.4, spread: 0.2, total: 0,
    "passing-props": 0, "rushing-props": 0, "receiving-props": 0, "anytime-td": 0,
  }),
  // Minimum tempered win chance. weekly_best_multis only accepts 0.55 to 0.65.
  minimumProbability: 0.55,
});

const round4 = (value) => Math.round(value * 10000) / 10000;

export function temperedValue(bet, policy) {
  const weight = policy.weights[bet.marketFamily];
  if (!Number.isFinite(weight)) return null;
  const probability = bet.impliedProbability + weight * (bet.modelProbability - bet.impliedProbability);
  return { weight, probability: round4(probability), expectedValue: round4(probability * bet.decimalOdds - 1) };
}

// Highest tempered value first, one leg per matchup.
export function selectValueLegs(candidates, policy, legCount) {
  const byMatchup = new Map();
  const pool = candidates.filter((row) => row.tempered && row.tempered.expectedValue > 0 &&
    row.tempered.probability >= policy.minimumProbability)
    .sort((a, b) => b.tempered.expectedValue - a.tempered.expectedValue ||
      b.tempered.probability - a.tempered.probability ||
      (a.matchupKey < b.matchupKey ? -1 : a.matchupKey > b.matchupKey ? 1 : 0));
  for (const row of pool) {
    if (byMatchup.size >= legCount) break;
    if (!byMatchup.has(row.matchupKey)) byMatchup.set(row.matchupKey, row);
  }
  return { legs: [...byMatchup.values()], threshold: policy.minimumProbability };
}
