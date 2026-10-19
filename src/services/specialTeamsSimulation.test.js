import test from "node:test";
import assert from "node:assert/strict";
import { predictMatchup } from "./predictionEngine.js";
import { buildSpecialTeamsModel, KICKER_LEAGUE_FALLBACK } from "./specialTeams.js";
import { KICKER_BUCKETS, KICKER_METRICS_SCHEMA } from "../../api-lib/kickerMetrics.js";
import { PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";

const season = 2026;
const week = 6;
const cutoff = "2026-10-16T00:00:00.000Z";
const stamp = "2026-10-15T12:00:00.000Z";
const gameProvenance = [{
  gameId: "2026_05_HOU_JAX",
  week: 5,
  kickoff: "2026-10-12T17:00:00.000Z",
  completedAsOf: "2026-10-12T21:00:00.000Z",
}];

function kickerProfile(id, {
  bucket = "under30",
  makes = 0,
  attempts = 0,
  xpMakes = 0,
  xpAttempts = 0,
} = {}) {
  const fieldGoals = Object.fromEntries(KICKER_BUCKETS.map((name) => [name, {
    attempts: 0, makes: 0, misses: 0, blocks: 0, accuracyAttempts: 0,
  }]));
  fieldGoals[bucket] = {
    attempts, makes, misses: attempts - makes, blocks: 0, accuracyAttempts: attempts,
  };
  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    provenanceVersion: 1,
    playerId: id,
    gsisId: id,
    fullName: `${id} Fixture`,
    team: "HOU",
    teamStint: "HOU",
    fieldGoals,
    overallFieldGoals: fieldGoals[bucket],
    extraPoints: {
      attempts: xpAttempts, makes: xpMakes, misses: xpAttempts - xpMakes,
      blocks: 0, accuracyAttempts: xpAttempts,
    },
    gamesRepresented: 1,
    gameProvenance,
    latestEligibleGame: gameProvenance[0],
    predictionSeason: season,
    predictionWeek: week,
    cutoff,
    sourceAsOf: stamp,
    generatedAt: stamp,
    source: "nflverse play-by-play",
    blockedAttemptTreatment: "Blocks are excluded from accuracy denominators.",
  };
}

function model({
  profile = kickerProfile("hou-k"),
  fieldGoalShares = { under30: 0.18, from30to39: 0.29, from40to49: 0.31, from50plus: 0.22 },
} = {}) {
  const leaguePriors = {
    fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, {
      rate: KICKER_LEAGUE_FALLBACK[bucket],
      attemptShare: fieldGoalShares[bucket] || 0,
      accuracyAttempts: 100,
      attempts: 100,
    }])),
    extraPoints: { rate: 0.94, accuracyAttempts: 100, attempts: 100 },
    blockedAttemptTreatment: "Blocks are excluded from accuracy denominators.",
  };
  return buildSpecialTeamsModel({
    away: "HOU",
    home: "JAX",
    personnelViews: {
      away: { version: PERSONNEL_VIEW_VERSION, team: "HOU", season, week, cutoff, players: [{
        canonicalId: "hou-k", gsisId: "hou-k", name: "HOU Fixture",
        team: "HOU", position: "K", rank: 1, chartRank: 1,
        eligibleBeforeCutoff: true, sourceConflict: false, identityConflict: false,
        confidence: "matched-by-identity", status: "Active", statusKnown: true, propEligible: true,
      }] },
      home: { version: PERSONNEL_VIEW_VERSION, team: "JAX", season, week, cutoff, players: [] },
    },
    kickerProfiles: {
      schemaVersion: KICKER_METRICS_SCHEMA,
      season,
      predictionSeason: season,
      predictionWeek: week,
      cutoff,
      sourceAsOf: stamp,
      generatedAt: stamp,
      source: "nflverse play-by-play",
      leaguePriors,
      profilesByTeam: { HOU: profile ? [profile] : [] },
    },
    season,
    week,
    cutoff,
    weather: { dome: true, venue: "NRG Stadium", venueConfidence: 1, venueSource: "scheduled-venue", weatherAvailable: true },
  });
}

function predict(specialTeams, weather = { dome: true }) {
  return predictMatchup("HOU", "JAX", {
    season, week, specialTeams, weather,
    modelLayers: { specialTeams: { active: true, available: true, confidence: 1, awayPoints: 4, homePoints: -4 } },
  });
}

test("FG simulation uses distance shares and stronger bucket accuracy helps the correct team", () => {
  const strong = model({
    profile: kickerProfile("hou-k", { bucket: "under30", makes: 100, attempts: 100 }),
    fieldGoalShares: { under30: 1, from30to39: 0, from40to49: 0, from50plus: 0 },
  });
  const result = predict(strong);
  const simulation = result.specialTeams.away;

  assert.ok(simulation.fieldGoalRatesByBucket.under30 > KICKER_LEAGUE_FALLBACK.under30);
  assert.ok(simulation.expectedFieldGoalAttempts > 0);
  assert.equal(simulation.expectedFieldGoalAttemptsByBucket.under30, simulation.expectedFieldGoalAttempts);
  assert.equal(simulation.expectedFieldGoalAttemptsByBucket.from30to39, 0);
  assert.ok(result.specialTeams.predictedIncrementalEffect.awayExpectedPoints > 0);
  assert.ok(result.specialTeams.predictedIncrementalEffect.continuousMargin < 0);
  assert.ok(result.specialTeams.predictedIncrementalEffect.awayWinProbability > 0);
  assert.equal(result.modelLayers.specialTeams.active, false);
  assert.equal(result.modelLayers.specialTeams.awayPoints, 0);
  assert.equal(result.modelLayers.specialTeams.homePoints, 0);
});

test("strong samples in every FG distance bucket improve the kicker's scoring contribution", () => {
  for (const bucket of KICKER_BUCKETS) {
    const shares = Object.fromEntries(KICKER_BUCKETS.map((name) => [name, name === bucket ? 1 : 0]));
    const strong = predict(model({
      profile: kickerProfile("hou-k", { bucket, makes: 100, attempts: 100 }),
      fieldGoalShares: shares,
    }));
    const league = predict(model({
      profile: null,
      fieldGoalShares: shares,
    }));
    assert.ok(strong.specialTeams.predictedIncrementalEffect.awayExpectedPoints >
      league.specialTeams.predictedIncrementalEffect.awayExpectedPoints, bucket);
    assert.ok(strong.specialTeams.predictedIncrementalEffect.awayWinProbability >
      league.specialTeams.predictedIncrementalEffect.awayWinProbability, bucket);
  }
});

test("supported sample generates a named explanation only when its final-margin effect is clear", () => {
  const shares = { under30: 1, from30to39: 0, from40to49: 0, from50plus: 0 };
  const strong = predict(model({
    profile: kickerProfile("hou-k", { bucket: "under30", makes: 100, attempts: 100 }),
    fieldGoalShares: shares,
  }));
  const weak = predict(model({
    profile: kickerProfile("hou-k", { bucket: "under30", makes: 0, attempts: 100 }),
    fieldGoalShares: shares,
  }));
  assert.match(strong.specialTeams.away.explanation, /HOU Fixture has been more reliable/);
  assert.match(weak.specialTeams.away.explanation, /HOU Fixture has been less reliable/);
  assert.match(strong.specialTeams.away.explanation, /Houston Texans' scoring expectation/);
  assert.doesNotMatch(strong.specialTeams.away.explanation, /equation|posterior|under30/i);
});

test("FG attempt generation is drive-based and uses the configured 40-49 yard bucket", () => {
  const rates = model({
    profile: kickerProfile("hou-k", { bucket: "from40to49", makes: 18, attempts: 20 }),
    fieldGoalShares: { under30: 0, from30to39: 0, from40to49: 1, from50plus: 0 },
  });
  const result = predict(rates);
  assert.equal(result.specialTeams.away.expectedFieldGoalAttemptsByBucket.from40to49,
    result.specialTeams.away.expectedFieldGoalAttempts);
  assert.equal(result.specialTeams.away.expectedFieldGoalAttemptsByBucket.under30, 0);
  assert.ok(result.specialTeams.away.fieldGoalRatesByBucket.from40to49 >
    result.specialTeams.away.fieldGoalRatesByBucket.from50plus);
  assert.ok(result.specialTeams.away.fieldGoalAttemptRate > 0);
  assert.notEqual(result.specialTeams.away.expectedFieldGoalAttempts, 2.1);
});

test("personalized extra-point posterior changes expected scoring and XP weather is applied once", () => {
  const strongXp = model({
    profile: kickerProfile("hou-k", { xpMakes: 100, xpAttempts: 100 }),
  });
  const leagueXp = model({ profile: kickerProfile("hou-k") });
  const strongResult = predict(strongXp);
  const leagueResult = predict(leagueXp);

  assert.ok(strongResult.specialTeams.away.extraPointMakeRate > 0.94);
  assert.ok(strongResult.specialTeams.predictedIncrementalEffect.awayExpectedPoints >
    leagueResult.specialTeams.predictedIncrementalEffect.awayExpectedPoints);
  assert.notEqual(strongResult.specialTeams.away.extraPointMakeRate, 0.945);
  const outdoor = predict(strongXp, {
    dome: false, windSpeed: 48, windGust: 60, rain: 4, weatherCode: 61,
    venue: "Wembley Stadium", venueConfidence: 1, venueSource: "scheduled-venue",
  });
  assert.ok(outdoor.specialTeams.away.fieldGoalWeatherMultiplier < 1);
  assert.ok(outdoor.specialTeams.away.extraPointWeatherMultiplier < 1);
  assert.ok(outdoor.specialTeams.away.extraPointMakeRate < strongResult.specialTeams.away.extraPointMakeRate);
  assert.ok(Math.abs(outdoor.specialTeams.away.extraPointMakeRate -
    outdoor.specialTeams.away.extraPointProfile.posteriorRate *
      outdoor.specialTeams.away.extraPointWeatherMultiplier) < 0.001);
  assert.ok(Math.abs(outdoor.specialTeams.away.fieldGoalRatesByBucket.under30 -
    outdoor.specialTeams.away.fieldGoalProfile.under30.rate *
      outdoor.specialTeams.away.fieldGoalWeatherMultiplier) < 0.001);
});

test("league fallback has no individualized confidence and explicit venue/weather diagnostics", () => {
  const result = predict(model({ profile: null }));
  assert.equal(result.specialTeams.away.individualizedDataAvailable, false);
  assert.equal(result.specialTeams.away.confidence, 0);
  assert.equal(result.specialTeams.away.fallbackActive, true);
  assert.equal(result.specialTeams.away.expectedKicker.playerId, "hou-k");
  assert.equal(result.specialTeams.venue, "NRG Stadium");
  assert.equal(result.specialTeams.venueConfidence, 1);
  assert.equal(result.specialTeams.weatherAvailable, true);
  assert.match(result.specialTeams.away.explanation, /using the league-average fallback/);
  assert.match(result.specialTeams.away.explanation, /Houston Texans' kicker performance is using the league-average fallback/);
});

test("Phase 1, Phase 2A and Opponent-Network model layers are invariant under kicker-only changes", () => {
  const input = {
    season,
    week,
    weather: { dome: true },
    modelLayers: {
      scoringBaseline: { active: true, awayExpected: 24, homeExpected: 24, confidence: 0.8 },
      opponentNetwork: { active: true, available: true, confidence: 0.6, awayPoints: 0.4, homePoints: -0.4 },
    },
    teamMetrics: {
      season,
      week,
      away: {
        team: "HOU", games: 5, offensivePlays: 350, defensivePlays: 350,
        passingEpaPerPlay: 0.1, passingEpaAllowedPerPlay: 0.05,
        rushingEpaPerPlay: 0.02, rushingEpaAllowedPerPlay: -0.01,
        successRate: 0.45, defensiveSuccessRate: 0.45,
        explosivePlayRate: 0.1, explosivePlayRateAllowed: 0.1,
        pressureAllowedRate: 0.15, pressureGeneratedRate: 0.15,
        opponentAdjusted: { opponents: ["DAL"], passingEpaPerPlay: 0.1, rushingEpaPerPlay: 0.02 },
      },
      home: {
        team: "JAX", games: 5, offensivePlays: 350, defensivePlays: 350,
        passingEpaPerPlay: 0.08, passingEpaAllowedPerPlay: 0.06,
        rushingEpaPerPlay: 0.01, rushingEpaAllowedPerPlay: -0.02,
        successRate: 0.44, defensiveSuccessRate: 0.46,
        explosivePlayRate: 0.09, explosivePlayRateAllowed: 0.11,
        pressureAllowedRate: 0.16, pressureGeneratedRate: 0.14,
        opponentAdjusted: { opponents: ["TEN"], passingEpaPerPlay: 0.08, rushingEpaPerPlay: 0.01 },
      },
    },
  };
  const average = predictMatchup("HOU", "JAX", { ...input, specialTeams: model({ profile: kickerProfile("hou-k") }) });
  const strong = predictMatchup("HOU", "JAX", {
    ...input,
    specialTeams: model({ profile: kickerProfile("hou-k", { bucket: "under30", makes: 100, attempts: 100 }) }),
  });

  assert.deepEqual(strong.modelLayers, average.modelLayers);
  assert.deepEqual(strong.matchupIntelligence.situational, average.matchupIntelligence.situational);
  assert.deepEqual(strong.modelLayers.opponentNetwork, average.modelLayers.opponentNetwork);
});
