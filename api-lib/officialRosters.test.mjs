import test from "node:test";
import assert from "node:assert/strict";
import { officialEntry, officiallyUnavailable, onTeam, rosterIndex } from "./officialRosters.js";
import { reportedDeparture } from "../src/services/rosterChanges.js";
import { buildRosterArtifact, validateRosterArtifact } from "../scripts/update-rosters.mjs";
import { buildInjuryLayer, quarterbackChange } from "../src/services/gamePredictionService.js";
import { absenceCost } from "../src/services/fourthDownRatings.js";
import rosters from "../data/nflverse-rosters-2026.js";

const index = rosterIndex({ week: 12, teams: { PIT: [
  { sleeperId: "4972", gsisId: "00-rudolph", name: "Mason Rudolph", position: "QB", status: "ACT" },
  { sleeperId: null, gsisId: "00-ir", name: "Injured Lineman", position: "T", status: "RES" },
] } });

test("players off the official roster drop out; players on it are matched by any ID or name", () => {
  assert.equal(officialEntry("PIT", { playerId: "4972" }, index).name, "Mason Rudolph");
  assert.equal(officialEntry("PIT", { gsis_id: "00-ir" }, index).status, "RES");
  assert.equal(officialEntry("PIT", { full_name: "Mason Rudolph" }, index).sleeperId, "4972");
  assert.equal(officialEntry("PIT", { playerId: "138", full_name: "Ben Roethlisberger" }, index), null);
  assert.equal(onTeam("PIT", { playerId: "138", full_name: "Ben Roethlisberger" }, index), false);
  assert.equal(officialEntry("ZZZ", { playerId: "1" }, index), undefined, "no roster loaded: nothing to check");
  assert.equal(onTeam("ZZZ", { playerId: "1" }, index), true);
  assert.equal(officiallyUnavailable(officialEntry("PIT", { gsis_id: "00-ir" }, index)), true);
});

test("a reported release removes a player even while the official roster still lists him", () => {
  const rodgers = { playerId: "96", gsis_id: "00-0023459", full_name: "Aaron Rodgers" };
  assert.equal(reportedDeparture("PIT", rodgers).change, "released");
  assert.equal(reportedDeparture("NYJ", rodgers), null, "only at the team he left");
  assert.equal(onTeam("PIT", rodgers), false);
  assert.ok(rosters.teams.PIT.some((p) => p.name === "Aaron Rodgers"), "the official file still has him");
});

test("the roster build keeps only the latest week and drops departures", () => {
  const rows = [
    { season: "2026", week: "11", team: "PIT", position: "QB", status: "ACT", full_name: "Old Week", gsis_id: "1" },
    { season: "2026", week: "12", team: "PIT", position: "QB", status: "ACT", full_name: "Current", gsis_id: "2" },
    { season: "2026", week: "12", team: "PIT", position: "QB", status: "CUT", full_name: "Cut Player", gsis_id: "3" },
    { season: "2026", week: "12", team: "LA", position: "WR", status: "RES", full_name: "On Reserve", gsis_id: "4" },
  ];
  const artifact = buildRosterArtifact(rows, { season: 2026, now: new Date("2026-11-26T00:00:00Z") });
  assert.equal(artifact.week, 12);
  assert.deepEqual(artifact.teams.PIT.map((p) => p.name), ["Current"]);
  assert.equal(artifact.teams.LAR[0].status, "RES");
  assert.deepEqual(validateRosterArtifact(rosters), []);
});

const ratings = { season: 2026, predictionWeek: 13, teams: {
  PIT: { qb: [{ gsisId: "00-0023459", name: "Aaron Rodgers", rating: 75, share: 0.92, quality: 0.5, dropbacks: 397 },
    { gsisId: "00-rudolph", name: "Mason Rudolph", rating: 65.6, share: 0.08, quality: -0.1, dropbacks: 6 }],
  wr: [{ gsisId: "00-cut", name: "Cut Receiver", rating: 80, share: 0.9, quality: 1, departed: true }] },
  DEN: { qb: [{ gsisId: "00-nix", name: "Bo Nix", rating: 80, share: 1, quality: 0 }] } } };

test("a released starting quarterback is priced as his team losing him, and the next quarterback starts", () => {
  const change = quarterbackChange({ team: "PIT", season: 2026, week: 13, ratings,
    starter: { name: "Aaron Rodgers", canonicalId: "00-0023459" } });
  assert.match(change.reason, /Mason Rudolph starts instead of Aaron Rodgers/);
  assert.equal(change.points, -absenceCost("qb", 0.5));
  const noChart = quarterbackChange({ team: "PIT", season: 2026, week: 13, ratings, starter: null });
  assert.equal(noChart.points, change.points);
});

test("a player who has left the team is out for good in injury pricing", () => {
  const layer = buildInjuryLayer({ away: "DEN", home: "PIT", season: 2026, week: 13, ratings });
  assert.equal(layer.homePoints, -Math.round(absenceCost("wr", 1) * 1000) / 1000);
  assert.match(layer.reasons[1], /Cut Receiver \(wr, Left team/);
});
