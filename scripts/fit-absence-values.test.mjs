import test from "node:test";
import assert from "node:assert/strict";
import { designRows, fit, individualPerformance } from "./fit-absence-values.mjs";

// Synthetic seasons where a missing receiver costs 2 + 1 x quality and a missing lineman 1,
// with team strengths that differ, so a weak team's absences must not look like the cause.
function synthetic() {
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const teams = Array.from({ length: 16 }, (_, i) => `T${i}`), strength = teams.map(() => (random() - 0.5) * 12);
  const games = [];
  for (let season = 1; season <= 6; season++) for (let week = 1; week <= 17; week++) {
    const order = [...teams.keys()].sort(() => random() - 0.5);
    for (let g = 0; g < 8; g++) {
      const [h, a] = [order[2 * g], order[2 * g + 1]];
      const absent = () => [...(random() < 0.3 ? [{ unit: "wr", quality: (random() - 0.5) * 3 }] : []),
        ...(random() < 0.4 ? [{ unit: "ol", quality: 0 }] : [])];
      const homeAbsent = absent(), awayAbsent = absent();
      const cost = (list) => list.reduce((sum, p) => sum + (p.unit === "wr" ? 2 + p.quality : 1), 0);
      const margin = 2 + strength[h] - strength[a] - cost(homeAbsent) + cost(awayAbsent) + (random() - 0.5) * 8;
      games.push({ season, week, home: teams[h], away: teams[a], neutral: false, margin, homeAbsent, awayAbsent });
    }
  }
  return games;
}

test("the fit recovers known absence costs while separating team strength", () => {
  const { columns, rows } = designRows(synthetic(), { grouped: true });
  const { beta, se } = fit(rows, columns);
  const at = (name) => beta[columns.indexOf(name)];
  assert.ok(Math.abs(at("homeField") - 2) < 0.4, `home field ${at("homeField")}`);
  assert.ok(Math.abs(at("wr:starter") - 2) < 0.4, `receiver ${at("wr:starter")}`);
  assert.ok(Math.abs(at("skill:quality") - 1) < 0.3, `quality slope ${at("skill:quality")}`);
  assert.ok(Math.abs(at("ol:starter") - 1) < 0.4, `lineman ${at("ol:starter")}`);
  assert.ok(se.every(Number.isFinite));
});

test("individual performance follows the ratings' measures and has none for linemen", () => {
  const stats = { dropbacks: 10, dropbackEpa: 2, carries: 0, rushEpa: 0, rushSuccess: 0, targets: 4, targetEpa: 2,
    sacks: 1, hits: 2, tfl: 0, forcedFumbles: 0, tackles: 5, ints: 1, passesDefended: 1 };
  assert.deepEqual(individualPerformance("qb", stats, 60), { value: 0.2, sample: 10 });
  assert.equal(individualPerformance("ol", stats, 60), null);
  assert.equal(individualPerformance("wr", stats, 40).value, 0.05);
  assert.equal(individualPerformance("db", stats, 50).value, (1 + 2 + 0.5) / 50);
});
