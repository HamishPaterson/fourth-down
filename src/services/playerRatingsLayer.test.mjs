import test from "node:test";
import assert from "node:assert/strict";
import { buildPlayerRatingsLayer } from "./gamePredictionService.js";
import { UNITS, teamUnitRatings } from "./fourthDownRatings.js";
import realRatings from "../../data/player-ratings-2026.js";
import { buildWeekRatings, buildPriorIndex, validateRatingsArtifact } from "../../scripts/player-ratings.mjs";

const team = (rating, overrides = {}) => Object.fromEntries(Object.entries(UNITS).map(([unit, spec]) =>
  [unit, Array.from({ length: spec.places + 2 }, (_, index) => ({ gsisId: `${unit}-${index}`, name: `${unit} player ${"abcdefghij"[index]}`,
    rating: overrides[unit]?.[index] ?? (index < spec.places ? rating : rating - 10), share: 1 - index * 0.1 }))]));
const ratings = (away, home) => ({ season: 2026, predictionWeek: 13, latestCompletedWeek: 12, teams: { NYJ: away, MIA: home } });
const layer = (artifact, extra = {}) => buildPlayerRatingsLayer({ away: "NYJ", home: "MIA", season: 2026, week: 13, ratings: artifact, ...extra });

test("the better-rated team gets the edge", () => {
  const result = layer(ratings(team(70), team(80)));
  assert.equal(result.available, true);
  assert.equal(result.active, true);
  assert.ok(result.homePoints > 0 && result.awayPoints < 0);
  assert.ok(result.homePassingMultiplier > 1 && result.awayPassingMultiplier < 1);
  assert.equal(result.confidence, 1);
});

test("a starter the live roster lists as out is replaced by the next player in his unit", () => {
  const artifact = ratings(team(75, { qb: [90] }), team(75));
  const healthy = layer(artifact);
  const roster = { groups: { players: [{ gsisId: "qb-0", fullName: "qb player a", injuryStatus: "Out" }] } };
  const injured = layer(artifact, { awayRoster: roster });
  assert.ok(healthy.awayPoints > 0);
  assert.ok(injured.awayPoints < healthy.awayPoints);
  assert.equal(injured.units.away.qb, 65, "the backup's rating");
  const byName = layer(artifact, { awayRoster: { groups: { players: [{ fullName: "QB Player A", status: "Injured Reserve" }] } } });
  assert.equal(byName.units.away.qb, 65);
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

test("the committed ratings cover every team for their prediction week", () => {
  assert.deepEqual(validateRatingsArtifact(realRatings, { season: 2026, week: realRatings.predictionWeek }), []);
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

import { buildQuarterbackLayer, quarterbackChange, QB_POINTS_PER_RATING } from "./gamePredictionService.js";

const qbRatings = { season: 2026, predictionWeek: 13, teams: { NE: { qb: [
  { gsisId: "00-maye", name: "Drake Maye", rating: 88.2 }, { gsisId: "00-devito", name: "Tommy DeVito", rating: 59.9 }] } } };
const view = (name, canonicalId, players = []) => ({ quarterback: { resolved: true, player: { name, canonicalId } }, players });

test("a backup starting in place of the usual quarterback costs the rating gap", () => {
  const change = quarterbackChange({ team: "NE", season: 2026, week: 13, ratings: qbRatings,
    starter: { name: "Tommy DeVito", canonicalId: "00-devito" } });
  assert.equal(change.points, (59.9 - 88.2) * QB_POINTS_PER_RATING);
  assert.ok(change.points < -4.5 && change.points > -5.5);
  assert.match(change.reason, /DeVito \(59\.9\) starts instead of Drake Maye \(88\.2\)/);
  assert.equal(quarterbackChange({ team: "NE", season: 2026, week: 13, ratings: qbRatings, starter: { name: "Drake Maye" } }), null);
  const unknown = quarterbackChange({ team: "NE", season: 2026, week: 13, ratings: qbRatings, starter: { name: "Behren Morton" } });
  assert.equal(unknown.starter.rated, false);
  assert.equal(unknown.starter.rating, UNITS.qb.replacement);
  assert.equal(quarterbackChange({ team: "NE", season: 2026, week: 12, ratings: qbRatings, starter: { name: "Tommy DeVito" } }), null);
});

test("the quarterback change replaces season QBR, which describes the usual starter", () => {
  const qbr = { available: true, playerName: "Drake Maye", seasonQbr: 75, weeklyQbr: null, plays: 300, week: 12 };
  const change = { points: -5, reason: "Quarterback change" };
  const usual = buildQuarterbackLayer(null, null, qbr, null, 13);
  const changed = buildQuarterbackLayer(null, null, qbr, null, 13, { away: change });
  assert.ok(usual.awayPoints > 0);
  assert.equal(changed.awayPoints, -5);
  assert.deepEqual(changed.quarterbackChange, { away: change, home: null });
});

test("player ratings use the selected starter and the point-in-time injury statuses", () => {
  const artifact = ratings(team(75, { qb: [90] }), team(75));
  const starter = layer(artifact, { personnelViews: { away: view("qb player b", "qb-1") } });
  assert.equal(starter.units.away.qb, 65, "the selected starter, not the snap-share leader");
  const out = layer(artifact, { personnelViews: { away: { players: [{ name: "wr player a", status: "Out" }] } } });
  assert.equal(out.units.away.wr, (75 * 2 + 65) / 3, "the next receiver replaces the one listed out");
  const conflictOnly = layer(artifact, { personnelViews: { away: { players: [{ name: "wr player a", status: "Active", projectedAvailable: false }] } } });
  assert.equal(conflictOnly.units.away.wr, 75, "an identity conflict alone is not an injury");
});
