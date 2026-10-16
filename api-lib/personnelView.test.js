import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPersonnelView,
  canonicalPosition,
  normalizeAvailability,
  PERSONNEL_VIEW_VERSION,
  QUESTIONABLE_OPPORTUNITY_FACTOR,
} from "./personnelView.js";
import { personnelSignature } from "./predictionEligibility.js";

const cutoff = "2026-10-18T17:00:00.000Z";
const sourceAsOf = "2026-10-15T12:00:00.000Z";

function chartPlayer(id, position, group, rank = 1) {
  return {
    playerId: id,
    gsisId: id,
    name: id,
    team: "PHI",
    position,
    group,
    slot: `${position}-${rank}`,
    rank,
    available: true,
    status: "Unknown",
    statusKnown: false,
  };
}

function lineup(team, players, startingQuarterback) {
  return {
    schemaVersion: 2,
    available: true,
    schemaValidated: true,
    season: 2026,
    predictionWeek: 6,
    team,
    cutoff,
    snapshotAt: "2026-10-14T12:00:00.000Z",
    roster: players,
    players: startingQuarterback ? [startingQuarterback] : [],
    startingQuarterback,
  };
}

function livePlayer(id, position, depthChartOrder, injuryStatus, team = "PHI") {
  return {
    id: `sleeper-${id}`,
    gsisId: id,
    fullName: id,
    team,
    position,
    depthChartPosition: position,
    depthChartOrder,
    status: "Active",
    injuryStatus,
  };
}

function roster(team, players, options = {}) {
  return {
    team,
    sourceAsOf: options.sourceAsOf || sourceAsOf,
    groups: { all: players },
    leagueIdentityIndex: options.leagueIdentityIndex || players.map((player) => ({
      gsisId: player.gsisId,
      team: player.team,
    })),
  };
}

test("availability normalization preserves medical unknown and applies one explicit Questionable policy", () => {
  for (const [input, expected] of [
    ["Active", "Active"], ["Probable", "Probable"], ["Questionable - ankle", "Questionable"],
    ["Doubtful", "Doubtful"], ["Out", "Out"], ["Inactive", "Inactive"],
    ["Injured Reserve", "IR"], ["Physically Unable to Perform (PUP)", "PUP"],
    ["Suspended", "Suspended"], ["Non-Football Injury (NFI)", "NFI"],
    ["Unknown vendor designation", "Unknown"], ["", "Unknown"],
  ]) assert.equal(normalizeAvailability({ injuryStatus: input }).status, expected);
  const rosterOnlyActive = normalizeAvailability({ rosterStatus: "Active" });
  assert.equal(rosterOnlyActive.status, "Unknown");
  assert.equal(rosterOnlyActive.statusKnown, false);
  assert.equal(rosterOnlyActive.propEligible, false);
  assert.equal(normalizeAvailability({ injuryStatus: "Questionable", rosterStatus: "IR" }).status, "IR");
  const questionable = normalizeAvailability({ injuryStatus: "Questionable" });
  assert.equal(questionable.propEligible, true);
  assert.equal(questionable.opportunityFactor, QUESTIONABLE_OPPORTUNITY_FACTOR);
  assert.equal(normalizeAvailability({ injuryStatus: "Doubtful" }).propEligible, false);
  assert.equal(normalizeAvailability({ injuryStatus: "Unknown" }).propEligible, false);
});

test("position aliases canonicalize across offense, defense and special teams", () => {
  for (const [source, expected] of [
    ["LT", "LT"], ["RT", "RT"], ["OT", "OT"], ["T", "OT"], ["LG", "LG"],
    ["RG", "RG"], ["G", "G"], ["OG", "G"], ["C", "C"], ["LWR", "WR"],
    ["XWR", "WR"], ["TE1", "TE"], ["HB", "RB"], ["FB", "FB"], ["PK", "K"],
    ["P", "P"], ["KR", "KR"], ["PR", "PR"], ["EDGE", "EDGE"], ["RDE", "DE"],
    ["LDT", "DT"], ["NT", "NT"], ["LOLB", "OLB"], ["ILB", "LB"], ["MLB", "LB"],
    ["LCB", "CB"], ["NB", "CB"], ["DB", "DB"], ["FS", "FS"], ["SS", "SS"],
  ]) assert.equal(canonicalPosition(source), expected, source);
});

test("Hurts Out promotes only proven McKee replacement identity and preserves provenance", () => {
  const hurts = chartPlayer("hurts-id", "QB", "QB");
  const mckee = chartPlayer("mckee-id", "QB", "QB", 2);
  hurts.name = "Jalen Hurts";
  mckee.name = "Tanner McKee";
  const depth = lineup("PHI", [hurts, mckee], hurts);
  const view = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("PHI", [
      livePlayer("hurts-id", "QB", 1, "Out"),
      livePlayer("mckee-id", "QB", 2, "Active"),
    ]),
  });
  assert.equal(view.version, PERSONNEL_VIEW_VERSION);
  assert.equal(view.quarterback.player.canonicalId, "mckee-id");
  assert.equal(view.quarterback.player.replacementFor, "hurts-id");
  assert.match(view.quarterback.reason, /Philadelphia Eagles: Tanner McKee.*Jalen Hurts/);
  assert.equal(view.quarterback.player.provenance.statusSource, "live-personnel-status");
  assert.equal(view.players.find((player) => player.canonicalId === "hurts-id").projectedAvailable, false);
});

test("QB identity conflicts are explicitly resolved by timely live depth or withheld when ambiguous", () => {
  const chartStarter = chartPlayer("00-0034855", "QB", "QB");
  chartStarter.name = "Baker Mayfield";
  const liveStarter = livePlayer("00-0041251", "QB", 1, "Active", "TB");
  liveStarter.fullName = "Jalon Daniels";
  const depth = lineup("TB", [chartStarter], chartStarter);
  depth.roster = depth.roster.map((player) => ({ ...player, team: "TB" }));
  const resolved = buildPersonnelView({
    team: "TB", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("TB", [liveStarter]),
  });
  assert.equal(resolved.quarterback.conflict, true);
  assert.equal(resolved.quarterback.resolved, true);
  assert.equal(resolved.quarterback.chartStarter, "00-0034855");
  assert.equal(resolved.quarterback.liveStarter, "00-0041251");
  assert.equal(resolved.quarterback.player.canonicalId, "00-0041251");

  const tied = buildPersonnelView({
    team: "TB", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("TB", [
      livePlayer("00-0034855", "QB", 1, "Active", "TB"),
      livePlayer("00-0041251", "QB", 1, "Active", "TB"),
    ]),
  });
  assert.equal(tied.quarterback.conflict, true);
  assert.equal(tied.quarterback.resolved, false);
  assert.equal(tied.quarterback.player, null);
});

test("late live statuses cannot rewrite the chart view and transferred players are excluded", () => {
  const qb = chartPlayer("qb-id", "QB", "QB");
  const depth = lineup("PHI", [qb], qb);
  const late = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("PHI", [livePlayer("qb-id", "QB", 1, "Out")], {
      sourceAsOf: "2026-10-19T00:00:00.000Z",
    }),
  });
  assert.equal(late.players[0].status, "Unknown");
  assert.equal(late.players[0].statusKnown, false);

  const moved = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("PHI", [], {
      leagueIdentityIndex: [{ gsisId: "qb-id", team: "TB" }],
    }),
  });
  assert.equal(moved.players[0].sourceConflict, true);
  assert.equal(moved.players[0].projectedAvailable, false);
  assert.equal(moved.players[0].exclusionReason, "Player now listed with TB");
});

test("post-cutoff status observations do not change the historical personnel signature", () => {
  const qb = chartPlayer("qb-id", "QB", "QB");
  const depth = lineup("PHI", [qb], qb);
  const before = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
  });
  const after = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("PHI", [livePlayer("qb-id", "QB", 1, "Out")], {
      sourceAsOf: "2026-10-19T00:00:00.000Z",
    }),
  });
  const snapshot = (view) => ({ personnelViews: { away: view, home: view } });
  assert.equal(after.players[0].status, "Unknown");
  assert.equal(after.players[0].statusKnown, false);
  assert.equal(personnelSignature(snapshot(before)), personnelSignature(snapshot(after)));
});

test("defensive aliases select only supported available depth replacements", () => {
  const unavailable = chartPlayer("edge-1", "DE", "front", 1);
  unavailable.status = "Out";
  unavailable.statusKnown = true;
  const replacement = chartPlayer("edge-2", "DE", "front", 2);
  const depth = lineup("PHI", [unavailable, replacement], null);
  const view = buildPersonnelView({
    team: "PHI", lineup: depth, season: 2026, week: 6, cutoff,
    roster: roster("PHI", [
      livePlayer("edge-1", "RDE", 1, "Out"),
      livePlayer("edge-2", "DE", 2, "Active"),
    ]),
  });
  assert.equal(view.players.find((player) => player.canonicalId === "edge-2").replacementFor, "edge-1");
  assert.equal(view.units.front.unavailable[0], "edge-1");
  assert.equal(view.units.front.replacements[0].playerId, "edge-2");
});
