// Read-only season accuracy report against the bookmaker.
//   node --env-file=.env.local scripts/accuracy-report.mjs [modelVersion|all]
// Defaults to the newest model version, so older models do not blur the result. Games without
// a complete pre-kickoff prediction or a final score are left out and counted.
import path from "node:path";
import { pathToFileURL } from "node:url";

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const BANDS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];

export function accuracyReport(rows, version) {
  const graded = rows.filter((row) => row.actual_away_score != null && row.actual_home_score != null);
  const versions = [...new Set(graded.map((row) => row.model_version).filter((value) => /^\d+$/.test(String(value))))]
    .sort((a, b) => Number(b) - Number(a));
  const chosen = version === "all" ? null : String(version ?? versions[0] ?? "");
  const usable = graded.filter((row) => (!chosen || String(row.model_version) === chosen) &&
    [row.predicted_away_score, row.predicted_home_score, row.away_win_probability, row.home_win_probability].every((v) => v != null));
  const out = { version: chosen || "all", versions, games: usable.length, leftOut: graded.length - usable.length };
  const picks = [], market = [], brier = [], margin = [], marketMargin = [], total = [], marketTotal = [], ats = [], ou = [];
  const bands = BANDS.map(() => ({ games: 0, claimed: 0, won: 0 }));
  for (const row of usable) {
    const actualMargin = row.actual_away_score - row.actual_home_score, actualTotal = row.actual_away_score + row.actual_home_score;
    const margin0 = row.predicted_away_score - row.predicted_home_score, total0 = row.predicted_away_score + row.predicted_home_score;
    const chance = Math.max(row.away_win_probability, row.home_win_probability), won = row.fourth_down_correct ? 1 : 0;
    picks.push(won); brier.push((chance - won) ** 2); margin.push(Math.abs(margin0 - actualMargin)); total.push(Math.abs(total0 - actualTotal));
    if (row.market_correct != null) market.push(row.market_correct ? 1 : 0);
    const band = bands[BANDS.findIndex(([low, high]) => chance >= low && chance < high)];
    if (band) { band.games++; band.claimed += chance; band.won += won; }
    if (row.market_away_score != null && row.market_home_score != null) {
      const line = row.market_away_score - row.market_home_score;
      marketMargin.push(Math.abs(line - actualMargin));
      if (margin0 !== line && actualMargin !== line) ats.push((margin0 > line) === (actualMargin > line) ? 1 : 0);
    }
    if (row.market_total != null) {
      marketTotal.push(Math.abs(row.market_total - actualTotal));
      if (total0 !== row.market_total && actualTotal !== row.market_total) ou.push((total0 > row.market_total) === (actualTotal > row.market_total) ? 1 : 0);
    }
  }
  Object.assign(out, {
    winnerPicks: { model: average(picks), bookmaker: average(market), games: picks.length },
    brier: average(brier),
    marginMiss: { model: average(margin), bookmaker: average(marketMargin), bookmakerGames: marketMargin.length },
    totalMiss: { model: average(total), bookmaker: average(marketTotal), bookmakerGames: marketTotal.length },
    againstSpread: { rate: average(ats), games: ats.length },
    overUnder: { rate: average(ou), games: ou.length },
    calibration: bands.map((band, index) => ({ band: BANDS[index][0], games: band.games,
      claimed: band.games ? band.claimed / band.games : null, won: band.games ? band.won / band.games : null })),
  });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { createWeeklyMultiClient } = await import("../api-lib/weeklyMulti.js");
  const { data, error } = await createWeeklyMultiClient().from("prediction_snapshots")
    .select("week,model_version,predicted_away_score,predicted_home_score,away_win_probability,home_win_probability,market_away_score,market_home_score,market_total,actual_away_score,actual_home_score,fourth_down_correct,market_correct")
    .eq("season", 2026);
  if (error) throw new Error(error.message);
  const r = accuracyReport(data, process.argv[2]), pct = (v) => v == null ? "-" : `${(v * 100).toFixed(1)}%`, pts = (v) => v == null ? "-" : v.toFixed(1);
  console.log(`Model version ${r.version}: ${r.games} graded games (${r.leftOut} left out). Versions seen: ${r.versions.join(", ")}`);
  console.log(`Winner picks   ${pct(r.winnerPicks.model)} vs bookmaker ${pct(r.winnerPicks.bookmaker)}`);
  console.log(`Margin miss    ${pts(r.marginMiss.model)} vs bookmaker ${pts(r.marginMiss.bookmaker)} pts (${r.marginMiss.bookmakerGames} games with a line)`);
  console.log(`Total miss     ${pts(r.totalMiss.model)} vs bookmaker ${pts(r.totalMiss.bookmaker)} pts (${r.totalMiss.bookmakerGames} games with a line)`);
  console.log(`Against spread ${pct(r.againstSpread.rate)} of ${r.againstSpread.games}; over/under ${pct(r.overUnder.rate)} of ${r.overUnder.games}; Brier ${r.brier?.toFixed(3)}`);
  for (const band of r.calibration) console.log(`  rated ${band.band * 100}%+: ${band.games} games, claimed ${pct(band.claimed)}, won ${pct(band.won)}`);
}
