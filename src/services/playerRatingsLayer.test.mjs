import test from "node:test";
import assert from "node:assert/strict";
import { buildInjuryLayer, buildPlayerRatingsLayer, buildQuarterbackLayer, quarterbackChange } from "./gamePredictionService.js";
import { ABSENCE_COSTS, UNITS, absenceCost, teamUnitRatings } from "./fourthDownRatings.js";
import realRatings from "../../data/player-ratings-2026.js";
import { buildWeekRatings, buildPriorIndex, validateRatingsArtifact } from "../../scripts/player-ratings.mjs";

// Starters play 90% of snaps, spares 30%; quality 0 (an average starter) unless given.
const team = (rating, overrides = {}, quality = {}) => Object.fromEntries(Object.entries(UNITS).map(([unit, spec]) =>
  [unit, Array.from({ length: spec.places + 2 }, (_, index) => ({ gsisId: `${unit}-${index}`, name: `${unit} player ${"abcdefghij"[index]}`,
    rating: overrides[unit]?.[index] ?? (index < spec.places ? rating : rating - 10), share: index < spec.places ? 0.9 : 0.3,
    quality: quality[unit]?.[index] ?? 0 }))]));
const ratings = (away, home) => ({ season: 2026, predictionWeek: 13, latestCompletedWeek: 12, teams: { NYJ: away, MIA: home } });
const layer = (artifact, extra = {}) => buildPlayerRatingsLayer({ away: "NYJ", home: "MIA", season: 2026, week: 13, ratings: artifact, ...extra });
const injuries = (artifact, extra = {}) => buildInjuryLayer({ away: "NYJ", home: "MIA", season: 2026, week: 13, ratings: artifact, ...extra });
const out = (name, injuryStatus = "Out") => ({ awayRoster: { groups: { players: [{ fullName: name, injuryStatus }] } } });

test("the better-rated team gets the edge", () => {
  const result = layer(ratings(team(70), team(80)));
  assert.equal(result.available, true);
  assert.equal(result.active, true);
  assert.ok(result.homePoints > 0 && result.awayPoints < 0);
  assert.ok(result.homePassingMultiplier > 1 && result.awayPassingMultiplier < 1);
  assert.equal(result.confidence, 1);
});

test("the ratings layer measures each team at full strength; injuries are priced separately", () => {
  const artifact = ratings(team(75, { qb: [90] }), team(75));
  assert.deepEqual(layer(artifact, out("qb player a")).units, layer(artifact).units);
});

test("measured absence costs: an average starter, and more for a better one", () => {
  assert.equal(absenceCost("wr", 0), 0.86);
  assert.equal(absenceCost("wr", 1.5), 0.86 + 1.5 * 0.74);
  assert.equal(absenceCost("ol", 2), 0.91, "linemen have no individual measure");
  assert.equal(absenceCost("db", -3), 0, "never a gain");
  assert.ok(absenceCost("qb", 1.5) > 8.5);
});

test("a starter ruled out costs his measured value; Questionable costs it times the chance he sits", () => {
  const artifact = ratings(team(75, {}, { wr: [1.5] }), team(75));
  assert.equal(injuries(artifact).active, false);
  const missing = injuries(artifact, out("wr player a"));
  assert.equal(missing.awayPoints, -Math.round(absenceCost("wr", 1.5) * 1000) / 1000);
  assert.equal(missing.homePoints, 0);
  assert.match(missing.reasons[0], /wr player a \(wr, Out/);
  assert.equal(injuries(artifact, out("WR Player A", "Doubtful")).awayPoints, missing.awayPoints, "Doubtful counts in full");
  assert.equal(injuries(artifact, out("wr player a", "Questionable")).awayPoints, -Math.round(absenceCost("wr", 1.5) * 0.25 * 1000) / 1000);
  assert.equal(injuries(artifact, out("wr player d")).active, false, "a player outside the regular starters costs nothing");
});

test("an elite player costs more to lose than an average one at the same position", () => {
  const elite = ratings(team(75, {}, { front: [1.5] }), team(75)), average = ratings(team(75), team(75));
  assert.ok(injuries(elite, out("front player a")).awayPoints < injuries(average, out("front player a")).awayPoints);
});

test("injury statuses also come from the point-in-time personnel view, and a team's total is capped", () => {
  const artifact = ratings(team(75), team(75));
  const view = { players: [{ name: "db player a", status: "Out", statusKnown: true }, { name: "db player b", status: "Unknown", statusKnown: false }] };
  assert.equal(injuries(artifact, { personnelViews: { home: view } }).homePoints, -ABSENCE_COSTS.db.starter);
  const everyone = { groups: { players: Object.values(team(75)).flat().map((p) => ({ fullName: p.name, injuryStatus: "Out" })) } };
  assert.equal(injuries(ratings(team(99, {}, { wr: [3, 3, 3] }), team(75)), { awayRoster: everyone }).awayPoints, -8);
  assert.equal(injuries({ ...artifact, predictionWeek: 12 }).available, false);
});

test("quarterbacks are left to the quarterback layer, and an identity conflict alone is not an injury", () => {
  const artifact = ratings(team(75), team(75));
  assert.equal(injuries(artifact, out("qb player a")).active, false);
  const conflictOnly = { players: [{ name: "wr player a", status: "Active", statusKnown: true, projectedAvailable: false }] };
  assert.equal(injuries(artifact, { personnelViews: { away: conflictOnly } }).active, false);
});

const qbRatings = { season: 2026, predictionWeek: 13, teams: { NE: { qb: [
  { gsisId: "00-maye", name: "Drake Maye", rating: 88.2, share: 1, quality: 1, dropbacks: 300 },
  { gsisId: "00-devito", name: "Tommy DeVito", rating: 59.9, share: 0.05, quality: null },
  { gsisId: "00-vet", name: "Veteran Starter", rating: 80, share: 0.4, quality: 0.5, dropbacks: 100 }] } } };
const change = (starter) => quarterbackChange({ team: "NE", season: 2026, week: 13, ratings: qbRatings, starter });

test("a backup starting for the usual quarterback costs the measured loss of that starter", () => {
  const backup = change({ name: "Tommy DeVito", canonicalId: "00-devito" });
  assert.equal(backup.points, -absenceCost("qb", 1));
  assert.ok(backup.points < -6.5 && backup.points > -7.5);
  assert.match(backup.reason, /DeVito starts instead of Drake Maye/);
  assert.equal(change({ name: "Drake Maye" }), null);
  assert.equal(change({ name: "Unlisted Rookie" }).points, -absenceCost("qb", 1));
  assert.equal(quarterbackChange({ team: "NE", season: 2026, week: 12, ratings: qbRatings, starter: { name: "Tommy DeVito" } }), null);
});

test("a replacement with a real season of his own is compared on quality", () => {
  const veteran = change({ name: "Veteran Starter" });
  assert.equal(veteran.starter.established, true);
  assert.equal(veteran.points, -ABSENCE_COSTS.qb.quality * ((1 * 300 + 0.5 * 100) / 400 - 0.5), "against the season mix");
});

test("the quarterback change replaces season QBR, which describes the usual starter", () => {
  const qbr = { available: true, playerName: "Drake Maye", seasonQbr: 75, weeklyQbr: null, plays: 300, week: 12 };
  const swap = { points: -5, reason: "Quarterback change" };
  assert.ok(buildQuarterbackLayer(null, null, qbr, null, 13).awayPoints > 0);
  const changed = buildQuarterbackLayer(null, null, qbr, null, 13, { away: swap });
  assert.equal(changed.awayPoints, -5);
  assert.deepEqual(changed.quarterbackChange, { away: swap, home: null });
});

test("ratings built for a different week are not used", () => {
  const result = layer({ ...ratings(team(70), team(80)), predictionWeek: 12 });
  assert.equal(result.available, false);
  assert.match(result.reasons[0], /not available/);
});

test("empty places count at replacement level and lower the confidence", () => {
  const thin = team(75); thin.ol = thin.ol.slice(0, 2);
  const { units, coverage } = teamUnitRatings(thin);
  assert.equal(units.ol, (75 * 2 + UNITS.ol.replacement * 3) / 5);
  assert.ok(coverage < 1 && coverage > 0.85);
});

test("the committed ratings cover every team for their prediction week and carry each player's quality", () => {
  assert.deepEqual(validateRatingsArtifact(realRatings, { season: 2026, week: realRatings.predictionWeek }), []);
  const starters = Object.values(realRatings.teams).flatMap((units) => units.qb.slice(0, 1));
  assert.ok(starters.every((player) => Number.isFinite(player.quality)));
});

test("ratings use only games before the prediction week and move from the prior as the sample grows", () => {
  const play = (week, extra) => ({ season: "2026", season_type: "REG", week: String(week), posteam: "NYJ", defteam: "MIA", epa: "0.5",
    qb_dropback: "1", passer_player_id: "00-1", pass_attempt: "1", ...extra });
  const snaps = (week) => ({ season: "2026", game_type: "REG", week: String(week), player: "Geno Smith", pfr_player_id: "SmitGe00",
    position: "QB", team: "NYJ", offense_snaps: "60", offense_pct: "1", defense_snaps: "0", defense_pct: "0" });
  const priors = buildPriorIndex([{ firstName: "Geno", lastName: "Smith", overallRating: 70, position: { shortLabel: "QB" } }]);
  const build = (week, plays) => buildWeekRatings({ plays, snapRows: [1, 2, 3, 4].map(snaps),
    pfrToGsis: new Map([["SmitGe00", "00-1"]]), priors, week }).teams.NYJ.qb[0];
  const few = build(2, Array.from({ length: 10 }, () => play(1)));
  const many = build(5, Array.from({ length: 400 }, (_, i) => play(1 + (i % 4))));
  const leaked = build(2, [...Array.from({ length: 10 }, () => play(1)), ...Array.from({ length: 400 }, () => play(3))]);
  assert.equal(few.prior, 70);
  assert.deepEqual(leaked, few, "later weeks never change an earlier week's rating");
  assert.ok(Math.abs(many.rating - many.performance) < Math.abs(few.rating - few.performance));
});

import { predictMatchup } from "./predictionEngine.js";

test("an elite quarterback ruled out moves the margin by his measured cost, not a capped 5 points", () => {
  const base = { season: 2026, week: 13, kickoff: "2026-12-06T18:00:00Z", weather: { dome: true } };
  const healthy = predictMatchup("NYJ", "MIA", { ...base, modelLayers: {} });
  const missing = predictMatchup("NYJ", "MIA", { ...base,
    modelLayers: { quarterback: { active: true, available: true, awayPoints: -absenceCost("qb", 1.5), homePoints: 0, confidence: 0.8 } } });
  assert.ok(missing.continuousMargin - healthy.continuousMargin > 7.5,
    `margin moved ${missing.continuousMargin - healthy.continuousMargin}`);
});
