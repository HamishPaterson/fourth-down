import test from "node:test";
import assert from "node:assert/strict";
import { getTeamRanks, rankBand } from "./teamRatings.js";

const snapshot = { teams: {
  AAA: { espnFpi: { overall: 6, offense: 5, defense: -1 } },
  BBB: { espnFpi: { overall: 2, offense: 5, defense: 3 } },
  CCC: { espnFpi: { overall: -4, offense: -2, defense: 1 } },
} };

test("ranks put the highest rating first, ties share a rank, and defence counts higher as better", () => {
  assert.deepEqual(getTeamRanks("AAA", { snapshot }), { overall: 1, offense: 1, defense: 3, total: 3 });
  assert.deepEqual(getTeamRanks({ abbreviation: "BBB" }, { snapshot }), { overall: 2, offense: 1, defense: 1, total: 3 });
  assert.deepEqual(getTeamRanks("ZZZ", { snapshot }), { overall: null, offense: null, defense: null, total: 3 });
});

test("plain-language bands for a rank out of 32", () => {
  assert.deepEqual([1, 5, 6, 12, 13, 20, 21, 27, 28, 32].map(rankBand),
    ["Elite", "Elite", "Good", "Good", "Average", "Average", "Below average", "Below average", "Poor", "Poor"]);
  assert.equal(rankBand(null), null);
});

test("every team has all three ranks in the live ratings", () => {
  const codes = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WSH"];
  for (const code of codes) {
    const ranks = getTeamRanks(code);
    for (const part of ["overall", "offense", "defense"]) assert.ok(ranks[part] >= 1 && ranks[part] <= 32, `${code} ${part}`);
  }
});
