// Weekly Multi market weights, refitted from graded results every time the Multi is prepared.
// A weight is the share of the model's disagreement with the bookmaker that results bore out:
//   probability = implied + weight * (model - implied)
// fitted by maximum likelihood over the bets the app recommended before kickoff in earlier
// weeks. A market with no demonstrated edge gets weight 0; one with too few graded bets keeps
// its standing weight from weeklyMultiValuePolicy.js until the evidence builds up. Player
// props are not graded from final scores, so they stay at 0 until a prop grader exists.
import { MULTI_VALUE_POLICY } from "./weeklyMultiValuePolicy.js";
import { weeklyMultiMarketFamily } from "./weeklyMulti.js";

export const MIN_GRADED_BETS = 30;
// Never trust more than half the disagreement: single weeks moved the fitted moneyline
// weight between 0.4 and 0.95, and the model is overconfident on strong favourites.
export const MAX_WEIGHT = 0.5;
const GRID = Array.from({ length: 11 }, (_, index) => index / 20);
const clampProbability = (value) => Math.min(0.99, Math.max(0.01, value));

// "won" / "lost" / null (push or not gradable from the final score).
export function gradeTeamBet(bet, game) {
  if (game.actualAwayScore == null || game.actualHomeScore == null) return null;
  const away = Number(game.actualAwayScore), home = Number(game.actualHomeScore);
  if (!Number.isFinite(away) || !Number.isFinite(home)) return null;
  const family = weeklyMultiMarketFamily(bet);
  const team = String(bet.teamCode || String(bet.selection || "").split(" ")[0]).toUpperCase();
  const side = team === game.awayCode ? 1 : team === game.homeCode ? -1 : 0;
  if (family === "moneyline") {
    if (!side || away === home) return null;
    return side * (away - home) > 0 ? "won" : "lost";
  }
  if (family === "spread") {
    const line = Number(bet.line);
    if (!side || !Number.isFinite(line)) return null;
    const cover = side * (away - home) + line;
    return cover === 0 ? null : cover > 0 ? "won" : "lost";
  }
  if (family === "total") {
    const line = Number(bet.line), total = away + home;
    const over = /^over\b/i.test(String(bet.selection || "")), under = /^under\b/i.test(String(bet.selection || ""));
    if (!Number.isFinite(line) || over === under || total === line) return null;
    return (total > line) === over ? "won" : "lost";
  }
  return null;
}

// Graded observations from saved pre-kickoff predictions of earlier weeks.
export function gradedObservations(rows, beforeWeek) {
  const observations = [];
  for (const row of rows || []) {
    if (!(Number(row.week) < beforeWeek) || !row.gradedAt) continue;
    if (!(Date.parse(row.generatedAt) < Date.parse(row.kickoff))) continue;
    for (const bet of row.candidates || []) {
      const decimalOdds = Number(bet.decimalOdds), modelProbability = Number(bet.modelProbability);
      if (!(decimalOdds > 1) || !(modelProbability > 0 && modelProbability < 1)) continue;
      const result = gradeTeamBet(bet, row);
      if (!result) continue;
      observations.push({ family: weeklyMultiMarketFamily(bet), week: Number(row.week), won: result === "won",
        impliedProbability: 1 / decimalOdds, modelProbability, decimalOdds });
    }
  }
  return observations;
}

export function fitWeight(observations, standing = 0) {
  if (observations.length < MIN_GRADED_BETS) return Math.min(standing, MAX_WEIGHT);
  let best = 0, bestLikelihood = -Infinity;
  for (const weight of GRID) {
    let likelihood = 0;
    for (const bet of observations) {
      const p = clampProbability(bet.impliedProbability + weight * (bet.modelProbability - bet.impliedProbability));
      likelihood += Math.log(bet.won ? p : 1 - p);
    }
    if (likelihood > bestLikelihood + 1e-9) { best = weight; bestLikelihood = likelihood; }
  }
  return best;
}

export function learnValuePolicy(observations, base = MULTI_VALUE_POLICY) {
  const weights = {}, evidence = {};
  for (const family of Object.keys(base.weights)) {
    const rows = observations.filter((bet) => bet.family === family);
    weights[family] = fitWeight(rows, base.weights[family]);
    evidence[family] = { bets: rows.length, won: rows.filter((bet) => bet.won).length,
      returnPerBet: rows.length ? Math.round(rows.reduce((sum, bet) => sum + (bet.won ? bet.decimalOdds - 1 : -1), 0) / rows.length * 1000) / 1000 : null };
  }
  return Object.freeze({ ...base, weights: Object.freeze(weights), evidence: Object.freeze(evidence) });
}

export async function loadGradedRows(client, season) {
  const { data, error } = await client.from("prediction_snapshots")
    .select("week,away_code,home_code,kickoff,actual_away_score,actual_home_score,graded_at,data_quality->snapshot->bestBets->candidates,data_quality->snapshot->generatedAt")
    .eq("season", season);
  if (error) throw new Error("GRADED_RESULTS_READ_FAILED");
  return (data || []).map((row) => ({ week: row.week, awayCode: row.away_code, homeCode: row.home_code, kickoff: row.kickoff,
    actualAwayScore: row.actual_away_score, actualHomeScore: row.actual_home_score, gradedAt: row.graded_at,
    candidates: Array.isArray(row.candidates) ? row.candidates : [], generatedAt: row.generatedAt }));
}
