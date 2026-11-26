// Scores a saved model comparison against the real results. Read-only.
//   node --env-file=.env.local scripts/compare-models.mjs reports/model-comparison/2026-week-12.json
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function scoreComparison(file, results) {
  const rows = [];
  for (const game of file.games) {
    const result = results.get(`${game.away}@${game.home}`);
    if (!result || result.awayScore == null || result.homeScore == null) continue;
    const actualMargin = result.homeScore - result.awayScore;
    const actualWinner = actualMargin > 0 ? game.home : actualMargin < 0 ? game.away : null;
    const grade = (side) => ({ winnerRight: actualWinner ? side.winner === actualWinner : null,
      marginMiss: Math.abs(side.margin - actualMargin),
      brier: actualWinner ? (side.homeWinProbability - (actualWinner === game.home ? 1 : 0)) ** 2 : null });
    rows.push({ game: `${game.away}@${game.home}`, actual: `${result.awayScore}-${result.homeScore}`, actualMargin,
      published: grade(game.published), newModel: grade(game.newModel),
      bookmaker: game.bookmaker ? { winnerRight: actualWinner ? Math.sign(game.bookmaker.homeMargin) === Math.sign(actualMargin) : null,
        marginMiss: Math.abs(game.bookmaker.homeMargin - actualMargin) } : null });
  }
  const summary = (key) => {
    const graded = rows.filter((row) => row[key]);
    const decided = graded.filter((row) => row[key].winnerRight !== null);
    const brier = graded.filter((row) => row[key].brier != null);
    return { games: graded.length, winners: decided.filter((row) => row[key].winnerRight).length, decided: decided.length,
      marginMiss: graded.length ? graded.reduce((sum, row) => sum + row[key].marginMiss, 0) / graded.length : null,
      brier: brier.length ? brier.reduce((sum, row) => sum + row[key].brier, 0) / brier.length : null };
  };
  return { rows, published: summary("published"), newModel: summary("newModel"), bookmaker: summary("bookmaker"),
    pending: file.games.length - rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = JSON.parse(fs.readFileSync(process.argv[2] || "reports/model-comparison/2026-week-12.json", "utf8"));
  const { createWeeklyMultiClient } = await import("../api-lib/weeklyMulti.js");
  const { data, error } = await createWeeklyMultiClient().from("prediction_snapshots")
    .select("away_code,home_code,actual_away_score,actual_home_score").eq("season", file.season).eq("week", file.week);
  if (error) throw new Error(error.message);
  const results = new Map(data.map((row) => [`${row.away_code}@${row.home_code}`,
    { awayScore: row.actual_away_score, homeScore: row.actual_home_score }]));
  const report = scoreComparison(file, results);
  for (const row of report.rows) {
    const mark = (side) => side ? `${side.winnerRight === null ? "tie" : side.winnerRight ? "right" : "wrong"} ${side.marginMiss.toFixed(1)}` : "-";
    console.log(`${row.game.padEnd(9)} ${row.actual.padEnd(6)} published ${mark(row.published).padEnd(11)} new ${mark(row.newModel).padEnd(11)} bookmaker ${mark(row.bookmaker)}`);
  }
  for (const key of ["published", "newModel", "bookmaker"]) {
    const s = report[key];
    console.log(`${key.padEnd(10)} winners ${s.winners}/${s.decided}  margin miss ${s.marginMiss?.toFixed(2) ?? "-"}${s.brier != null ? `  Brier ${s.brier.toFixed(3)}` : ""}`);
  }
  if (report.pending) console.log(`${report.pending} game(s) not final yet.`);
}
