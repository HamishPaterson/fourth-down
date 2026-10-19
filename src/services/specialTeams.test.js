import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpecialTeamsModel,
  KICKER_PRIOR_STRENGTH,
  KICKER_LEAGUE_FALLBACK,
  XP_PRIOR_STRENGTH,
} from "./specialTeams.js";
import { KICKER_METRICS_SCHEMA, KICKER_BUCKETS } from "../../api-lib/kickerMetrics.js";
import { PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";

const season = 2026;
const week = 6;
const cutoff = "2026-10-16T00:00:00.000Z";
const stamp = "2026-10-15T12:00:00.000Z";
const provenance = [{
  gameId: "2026_05_HOU_JAX",
  week: 5,
  kickoff: "2026-10-12T17:00:00.000Z",
  completedAsOf: "2026-10-12T21:00:00.000Z",
}];

function profile(playerId, team = "HOU", {
  under30Makes = 0,
  under30Attempts = 0,
  xpMakes = 0,
  xpAttempts = 0,
} = {}) {
  const fieldGoals = Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, {
    attempts: 0, makes: 0, misses: 0, blocks: 0, accuracyAttempts: 0,
  }]));
  fieldGoals.under30 = {
    attempts: under30Attempts, makes: under30Makes,
    misses: under30Attempts - under30Makes, blocks: 0,
    accuracyAttempts: under30Attempts,
  };
  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    provenanceVersion: 1,
    playerId,
    gsisId: playerId,
    fullName: `${playerId} Fixture`,
    team,
    teamStint: team,
    fieldGoals,
    overallFieldGoals: fieldGoals.under30,
    extraPoints: {
      attempts: xpAttempts, makes: xpMakes, misses: xpAttempts - xpMakes,
      blocks: 0, accuracyAttempts: xpAttempts,
    },
    gamesRepresented: 1,
    gameProvenance: provenance,
    latestEligibleGame: provenance[0],
    predictionSeason: season,
    predictionWeek: week,
    cutoff,
    completedAsOf: provenance[0].completedAsOf,
    sourceAsOf: stamp,
    generatedAt: stamp,
    source: "nflverse play-by-play",
    blockedAttemptTreatment: "Blocks are excluded from accuracy denominators.",
  };
}

function artifact(profilesByTeam = {}) {
  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    season,
    predictionSeason: season,
    predictionWeek: week,
    cutoff,
    sourceAsOf: stamp,
    generatedAt: stamp,
    source: "nflverse play-by-play",
    leaguePriors: {
      fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, {
        rate: KICKER_LEAGUE_FALLBACK[bucket],
        accuracyAttempts: 100,
        attempts: 100,
        attemptShare: 0.25,
      }])),
      extraPoints: { rate: 0.94, accuracyAttempts: 100, attempts: 100 },
      blockedAttemptTreatment: "Blocks are excluded from accuracy denominators.",
    },
    profilesByTeam,
  };
}

function personnelPlayer(id, {
  team = "HOU",
  position = "PK",
  rank = 1,
  status = "Active",
  statusKnown = true,
  propEligible = true,
  name = `${id} Fixture`,
} = {}) {
  return {
    canonicalId: id,
    gsisId: id,
    name,
    team,
    position,
    rank,
    chartRank: rank,
    liveRank: null,
    status,
    statusKnown,
    propEligible,
    opportunityFactor: status === "Questionable" ? 0.75 : 1,
    eligibleBeforeCutoff: true,
    sourceConflict: false,
    identityConflict: false,
    confidence: "matched-by-identity",
    provenance: { statusSource: "fixture" },
  };
}

function createModel({
  players = [personnelPlayer("kicker-1")],
  profilesByTeam = { HOU: [profile("kicker-1")] },
  personnelViewCutoff = cutoff,
} = {}) {
  return buildSpecialTeamsModel({
    away: "HOU",
    home: "JAX",
    personnelViews: {
      away: {
        version: PERSONNEL_VIEW_VERSION, team: "HOU", season, week,
        cutoff: personnelViewCutoff, players,
      },
      home: {
        version: PERSONNEL_VIEW_VERSION, team: "JAX", season, week, cutoff,
        players: [personnelPlayer("jax-k", { team: "JAX" })],
      },
    },
    kickerProfiles: artifact(profilesByTeam),
    season,
    week,
    cutoff,
  });
}

test("kicker posterior rates regress small samples and retain larger player samples", () => {
  const model = createModel({
    profilesByTeam: { HOU: [
      profile("kicker-1", "HOU", { under30Makes: 1, under30Attempts: 1, xpMakes: 1, xpAttempts: 1 }),
      profile("kicker-large", "HOU", { under30Makes: 100, under30Attempts: 100 }),
    ] },
    players: [
      personnelPlayer("kicker-1", { rank: 1 }),
      personnelPlayer("kicker-large", { rank: 2 }),
    ],
  });
  const small = model.away.fieldGoals.under30.rate;
  assert.equal(model.away.expectedKicker.playerId, "kicker-1");
  assert.equal(KICKER_PRIOR_STRENGTH, 20);
  assert.equal(XP_PRIOR_STRENGTH, 30);
  assert.ok(small < 0.97 && small > KICKER_LEAGUE_FALLBACK.under30);
  assert.ok(Number.isFinite(small) && small >= 0 && small <= 1);
  const largeSample = createModel({
    profilesByTeam: { HOU: [profile("kicker-large", "HOU", { under30Makes: 100, under30Attempts: 100 })] },
    players: [personnelPlayer("kicker-large")],
  }).away.fieldGoals.under30.rate;
  assert.ok(Math.abs(small - KICKER_LEAGUE_FALLBACK.under30) <
    Math.abs(largeSample - KICKER_LEAGUE_FALLBACK.under30));
});

test("no matching same-team identity falls back without relabeling another kicker's profile", () => {
  const model = createModel({
    players: [personnelPlayer("expected-kicker")],
    profilesByTeam: { HOU: [profile("previous-kicker")] },
  });
  assert.equal(model.away.expectedKicker.fullName, "expected-kicker Fixture");
  assert.equal(model.away.profileAvailable, false);
  assert.equal(model.away.individualizedDataAvailable, false);
  assert.equal(model.away.sampleConfidence, 0);
  assert.equal(model.away.fieldGoals.under30.rate, KICKER_LEAGUE_FALLBACK.under30);
  assert.match(model.away.unavailableReason, /No matching point-in-time/);
});

test("unavailable and doubtful starters are not selected; a supported replacement uses its own profile", () => {
  const replaced = createModel({
    players: [
      personnelPlayer("starter", { rank: 1, status: "Out" }),
      personnelPlayer("replacement", { rank: 2, name: "Replacement Kicker" }),
    ],
    profilesByTeam: {
      HOU: [
        profile("starter", "HOU", { under30Makes: 1, under30Attempts: 1 }),
        profile("replacement", "HOU", { under30Makes: 9, under30Attempts: 10 }),
      ],
    },
  });
  assert.equal(replaced.away.expectedKicker.playerId, "replacement");
  assert.equal(replaced.away.expectedKicker.replacementFor, "starter");
  assert.equal(replaced.away.fieldGoals.under30.makes, 9);

  const noReplacement = createModel({
    players: [personnelPlayer("doubtful", { status: "Doubtful" })],
    profilesByTeam: { HOU: [profile("doubtful", "HOU", { under30Makes: 1, under30Attempts: 1 })] },
  });
  assert.equal(noReplacement.away.expectedKicker, null);
  assert.equal(noReplacement.away.unavailableKicker.fullName, "doubtful Fixture");
  assert.equal(noReplacement.away.availabilityStatus, "Doubtful");
  assert.equal(noReplacement.away.individualizedDataAvailable, false);
});

test("an unresolved replacement identity conflict blocks kicker selection", () => {
  const model = createModel({
    players: [
      personnelPlayer("starter", { rank: 1, status: "Out" }),
      { ...personnelPlayer("replacement", { rank: 2 }), identityConflict: true },
    ],
    profilesByTeam: {
      HOU: [profile("starter"), profile("replacement")],
    },
  });
  assert.equal(model.away.expectedKicker, null);
  assert.equal(model.away.individualizedDataAvailable, false);
  assert.match(model.away.unavailableReason, /identity conflict is unresolved/);
});

test("unknown availability remains Unknown and uses league-only performance fallback", () => {
  const model = createModel({
    players: [personnelPlayer("unknown-kicker", { status: "Unknown", statusKnown: false, propEligible: false })],
    profilesByTeam: { HOU: [profile("unknown-kicker", "HOU", { under30Makes: 10, under30Attempts: 10 })] },
  });
  assert.equal(model.away.expectedKicker.availabilityStatus, "Unknown");
  assert.equal(model.away.profileAvailable, false);
  assert.equal(model.away.sampleConfidence, 0);
  assert.equal(model.away.fieldGoals.under30.rate, KICKER_LEAGUE_FALLBACK.under30);
});

test("personnel identity from a different cutoff cannot select a kicker", () => {
  const model = createModel({ personnelViewCutoff: "2026-10-15T00:00:00.000Z" });
  assert.equal(model.away.expectedKicker, null);
  assert.equal(model.away.individualizedDataAvailable, false);
  assert.match(model.away.unavailableReason, /No eligible shared point-in-time personnel view/);
});

test("Questionable availability applies the shared 0.75 opportunity factor to individualized evidence", () => {
  const questionable = createModel({
    players: [personnelPlayer("questionable", {
      status: "Questionable", name: "Questionable Kicker",
    })],
    profilesByTeam: {
      HOU: [profile("questionable", "HOU", { under30Makes: 100, under30Attempts: 100 })],
    },
  }).away;
  const leagueRate = questionable.fieldGoals.under30.leagueRate;
  const fullPosterior = (100 + leagueRate * KICKER_PRIOR_STRENGTH) /
    (100 + KICKER_PRIOR_STRENGTH);

  assert.equal(questionable.availabilityStatus, "Questionable");
  assert.equal(questionable.availabilityFactor, 0.75);
  assert.ok(questionable.fieldGoals.under30.rate < fullPosterior);
  assert.ok(questionable.fieldGoals.under30.rate > leagueRate);
});
