import test from "node:test";
import assert from "node:assert/strict";
import { buildMatchupDrivers } from "./matchupDrivers.js";

const prediction = {
  away: { code: "NE" },
  home: { code: "LAC" },
  continuousMargin: -1.6, // NE by 1.6
  homeField: { total: 1.4 },
  schedule: { differential: -0.3 },
  externalFactors2026: { active: false },
  modelLayers: {
    awayPoints: 0, homePoints: 0, // totals, not layers
    quarterback: { active: true, awayPoints: -1.6, homePoints: 1.59 },
    rosterHealth: { active: true, awayPoints: 0.2, homePoints: -0.3 },
    successRate: { active: true, awayPoints: 0.4, homePoints: 0 },
    earlyDownEpa: { active: true, awayPoints: 0.3, homePoints: 0 },
    pace: { active: false, awayPoints: 5, homePoints: -5 },
  },
};

test("factors name the model's layers and add up to the projected margin", () => {
  const drivers = buildMatchupDrivers(prediction, { limit: 10 });
  const byLabel = Object.fromEntries(drivers.map((d) => [d.label, d]));
  assert.equal(byLabel.Quarterbacks.points, 3.2);
  assert.equal(byLabel.Quarterbacks.team, "LAC");
  assert.equal(byLabel.Injuries.points, -0.5);
  assert.equal(byLabel.Injuries.team, "NE");
  assert.equal(byLabel["Matchup stats"].points, -0.7);
  assert.equal(byLabel["Home field"].points, 1.4);
  assert.equal(byLabel["Rest and schedule"].points, -0.3);
  assert.equal(byLabel.pace, undefined, "inactive layers are left out");
  const sum = drivers.reduce((total, d) => total + d.points, 0);
  assert.ok(Math.abs(sum - prediction.continuousMargin) < 0.15, `sum ${sum}`);
  assert.equal(drivers[0].label, "Team strength and form", "largest first");
});

test("the list is trimmed to the biggest factors and empty without a margin", () => {
  assert.equal(buildMatchupDrivers(prediction, { limit: 3 }).length, 3);
  assert.deepEqual(buildMatchupDrivers({ modelLayers: {} }), []);
});

test("travel and venue effects stay inside the remainder when the external model is active", () => {
  const drivers = buildMatchupDrivers({ ...prediction, externalFactors2026: { active: true } }, { limit: 10 });
  assert.ok(!drivers.some((d) => d.label === "Home field" || d.label === "Rest and schedule"));
});
