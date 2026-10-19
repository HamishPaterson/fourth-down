import { canonicalPosition, canonicalTeam, PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";
import { KICKER_BUCKETS, KICKER_METRICS_SCHEMA } from "../../api-lib/kickerMetrics.js";
import { resolveStadium } from "./stadiums.js";

// These pseudo-attempt counts keep sparse bucket/XP samples near the eligible league rate;
// they are conservative modelling choices, not claims of historical calibration.
export const KICKER_PRIOR_STRENGTH = 20;
export const XP_PRIOR_STRENGTH = 30;
export const KICKER_EXPLANATION_CONFIDENCE = 0.65;
export const KICKER_LEAGUE_FALLBACK = Object.freeze({
  under30: 0.84,
  from30to39: 0.84,
  from40to49: 0.84,
  from50plus: 0.84,
  extraPoints: 0.945,
});
export const DEFAULT_FIELD_GOAL_DISTANCE_SHARES = Object.freeze({
  under30: 0.18,
  from30to39: 0.29,
  from40to49: 0.31,
  from50plus: 0.22,
});
const UNAVAILABLE = new Set(["Out", "Doubtful", "Inactive", "IR", "PUP", "Suspended", "NFI"]);
const number = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function buildSpecialTeamsModel({
  away,
  home,
  personnelViews,
  kickerProfiles,
  season,
  week,
  cutoff,
  weather,
  venue,
} = {}) {
  const artifactValid = validateArtifact(kickerProfiles, season, week, cutoff);
  const leaguePriors = artifactValid ? kickerProfiles.leaguePriors : null;
  const venueResolution = resolveStadium(home, weather?.venue || venue);
  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    season,
    predictionWeek: week,
    cutoff: cutoff || null,
    source: artifactValid ? kickerProfiles.source : "league-simulation-fallback",
    artifactAvailable: artifactValid,
    venue: weather?.venue || venueResolution.stadium?.name || venue || null,
    venueConfidence: number(weather?.venueConfidence) ?? venueResolution.confidence,
    venueSource: weather?.venueSource || venueResolution.source,
    weatherAvailable: weather?.weatherAvailable === true,
    weatherFallbackReason: weather?.fallbackReason ||
      (weather?.weatherAvailable === true ? null : "Weather data unavailable; neutral weather multipliers used"),
    leaguePriors: normalizedLeaguePriors(leaguePriors),
    away: buildTeamKickerModel({
      team: away,
      personnelView: personnelViews?.away,
      season, week, cutoff,
      profiles: artifactValid ? kickerProfiles.profilesByTeam?.[canonicalTeam(away)] : [],
      leaguePriors: normalizedLeaguePriors(leaguePriors),
      artifactValid,
    }),
    home: buildTeamKickerModel({
      team: home,
      personnelView: personnelViews?.home,
      season, week, cutoff,
      profiles: artifactValid ? kickerProfiles.profilesByTeam?.[canonicalTeam(home)] : [],
      leaguePriors: normalizedLeaguePriors(leaguePriors),
      artifactValid,
    }),
  };
}

export function createDefaultSpecialTeamsModel(away, home) {
  const priors = {
    fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, {
      rate: KICKER_LEAGUE_FALLBACK[bucket],
      attemptShare: DEFAULT_FIELD_GOAL_DISTANCE_SHARES[bucket],
      accuracyAttempts: 0,
      attempts: 0,
    }])),
    extraPoints: { rate: KICKER_LEAGUE_FALLBACK.extraPoints, accuracyAttempts: 0, attempts: 0 },
    blockedAttemptTreatment: "Blocked attempts are reported separately and excluded from accuracy denominators.",
    source: "documented-league-rate-fallback",
  };
  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    artifactAvailable: false,
    leaguePriors: priors,
    away: buildFallbackTeam(away, null, "Kicker profiles are not present in the NFLverse artifact"),
    home: buildFallbackTeam(home, null, "Kicker profiles are not present in the NFLverse artifact"),
  };
}

export function leagueOnlySpecialTeams(model) {
  const priors = model?.leaguePriors || createDefaultSpecialTeamsModel("AWAY", "HOME").leaguePriors;
  return {
    ...model,
    away: buildFallbackTeam(model?.away?.team || "AWAY", model?.away?.expectedKicker || null,
      "League-only simulation ablation", priors),
    home: buildFallbackTeam(model?.home?.team || "HOME", model?.home?.expectedKicker || null,
      "League-only simulation ablation", priors),
  };
}

function validateArtifact(artifact, season, week, cutoff) {
  if (artifact?.schemaVersion !== KICKER_METRICS_SCHEMA ||
      artifact?.predictionSeason && artifact.predictionSeason !== season ||
      artifact?.season !== season || artifact?.predictionWeek !== week ||
      Date.parse(artifact?.cutoff || "") !== Date.parse(cutoff || "")) return false;
  if (!Number.isFinite(Date.parse(artifact.sourceAsOf || "")) ||
      !Number.isFinite(Date.parse(artifact.generatedAt || ""))) return false;
  for (const profiles of Object.values(artifact.profilesByTeam || {})) {
    if (!Array.isArray(profiles)) return false;
    for (const profile of profiles) {
      if (profile.predictionSeason !== season || profile.predictionWeek !== week ||
          profile.team !== canonicalTeam(profile.team) || profile.cutoff !== cutoff ||
          !profile.playerId || !profile.fullName || !Number.isFinite(profile.gamesRepresented) ||
          !Array.isArray(profile.gameProvenance) || profile.gamesRepresented !== profile.gameProvenance.length ||
          profile.gameProvenance.some((game) => {
            const kickoff = Date.parse(game.kickoff || "");
            const completed = Date.parse(game.completedAsOf || "");
            return !Number.isFinite(kickoff) || !Number.isFinite(completed) ||
              kickoff >= Date.parse(cutoff) || completed > Date.parse(cutoff) || completed < kickoff;
          })) return false;
    }
  }
  return true;
}

function normalizedLeaguePriors(source) {
  const fieldGoals = {};
  for (const bucket of KICKER_BUCKETS) {
    const rate = number(source?.fieldGoals?.[bucket]?.rate ?? source?.fieldGoals?.[bucket]?.accuracy);
    const share = number(source?.fieldGoals?.[bucket]?.attemptShare);
    fieldGoals[bucket] = {
      rate: rate === null ? KICKER_LEAGUE_FALLBACK[bucket] : clamp(rate, 0, 1),
      attemptShare: share === null ? DEFAULT_FIELD_GOAL_DISTANCE_SHARES[bucket] : Math.max(0, share),
      accuracyAttempts: Math.max(0, number(source?.fieldGoals?.[bucket]?.accuracyAttempts) || 0),
      attempts: Math.max(0, number(source?.fieldGoals?.[bucket]?.attempts) || 0),
    };
  }
  const totalShare = Object.values(fieldGoals).reduce((sum, row) => sum + row.attemptShare, 0);
  for (const bucket of KICKER_BUCKETS) {
    fieldGoals[bucket].attemptShare = totalShare > 0
      ? fieldGoals[bucket].attemptShare / totalShare
      : DEFAULT_FIELD_GOAL_DISTANCE_SHARES[bucket];
  }
  const xpRate = number(source?.extraPoints?.rate ?? source?.extraPoints?.accuracy);
  return {
    fieldGoals,
    extraPoints: {
      rate: xpRate === null ? KICKER_LEAGUE_FALLBACK.extraPoints : clamp(xpRate, 0, 1),
      accuracyAttempts: Math.max(0, number(source?.extraPoints?.accuracyAttempts) || 0),
      attempts: Math.max(0, number(source?.extraPoints?.attempts) || 0),
    },
    blockedAttemptTreatment: source?.blockedAttemptTreatment ||
      "Blocked attempts are reported separately and excluded from accuracy denominators.",
    source: source?.source || "documented-league-rate-fallback",
  };
}

function buildTeamKickerModel({ team, personnelView, profiles, leaguePriors, artifactValid, season, week, cutoff }) {
  const selected = eligiblePersonnelView(personnelView, team, season, week, cutoff)
    ? selectExpectedKicker(team, personnelView)
    : { kicker: null, reason: "No eligible shared point-in-time personnel view for kicker identity" };
  if (!selected.kicker) return buildFallbackTeam(team, null, selected.reason, leaguePriors, selected);
  if (selected.forceFallback) {
    return buildFallbackTeam(team, selected.kicker, selected.reason, leaguePriors, selected);
  }
  const profile = (Array.isArray(profiles) ? profiles : []).find((candidate) =>
    candidate.team === canonicalTeam(team) &&
    String(candidate.playerId) === String(selected.kicker.canonicalId));
  if (!profile || !hasSupportedProfile(profile, team, artifactValid)) {
    return buildFallbackTeam(team, selected.kicker, "No matching point-in-time NFLverse profile for this kicker",
      leaguePriors, selected);
  }
  const availabilityFactor = clamp(number(selected.kicker.opportunityFactor) ?? 1, 0, 1);
  const posterior = Object.fromEntries(KICKER_BUCKETS.map((bucket) => {
    const stats = profile.fieldGoals?.[bucket] || {};
    const attempts = Math.max(0, number(stats.accuracyAttempts) || 0);
    const makes = Math.max(0, number(stats.makes) || 0);
    const priorRate = leaguePriors.fieldGoals[bucket].rate;
    const regressedRate = posteriorRate(makes, attempts, priorRate, KICKER_PRIOR_STRENGTH);
    return [bucket, {
      rate: clamp(priorRate + (regressedRate - priorRate) * availabilityFactor, 0, 1),
      makes,
      attempts: Math.max(0, number(stats.attempts) || 0),
      accuracyAttempts: attempts,
      misses: Math.max(0, number(stats.misses) || 0),
      blocks: Math.max(0, number(stats.blocks) || 0),
      leagueRate: priorRate,
      priorStrength: KICKER_PRIOR_STRENGTH,
    }];
  }));
  const xpStats = profile.extraPoints || {};
  const xpAccuracyAttempts = Math.max(0, number(xpStats.accuracyAttempts) || 0);
  const regressedXp = posteriorRate(
    Math.max(0, number(xpStats.makes) || 0),
    xpAccuracyAttempts,
    leaguePriors.extraPoints.rate,
    XP_PRIOR_STRENGTH,
  );
  const posteriorXp = clamp(leaguePriors.extraPoints.rate +
    (regressedXp - leaguePriors.extraPoints.rate) * availabilityFactor, 0, 1);
  const distanceConfidence = KICKER_BUCKETS.reduce((sum, bucket) =>
    sum + leaguePriors.fieldGoals[bucket].attemptShare *
      posterior[bucket].accuracyAttempts /
      (posterior[bucket].accuracyAttempts + KICKER_PRIOR_STRENGTH), 0);
  const sampleConfidence = clamp(
    0.8 * distanceConfidence +
      0.2 * xpAccuracyAttempts / (xpAccuracyAttempts + XP_PRIOR_STRENGTH), 0, 1);
  return {
    team: canonicalTeam(team),
    expectedKicker: {
      playerId: selected.kicker.canonicalId,
      gsisId: selected.kicker.gsisId || selected.kicker.canonicalId,
      fullName: selected.kicker.name,
      team: canonicalTeam(team),
      availabilityStatus: selected.kicker.status,
      availabilityFactor,
      identityConfidence: selected.kicker.identityConfidence,
      identityProvenance: selected.kicker.provenance,
      selectedFromDepth: selected.kicker.depth,
      replacementFor: selected.kicker.replacementFor || null,
    },
    availabilityStatus: selected.kicker.status,
    availabilityFactor,
    identityConfidence: selected.kicker.identityConfidence,
    identityProvenance: selected.kicker.provenance,
    profileAvailable: true,
    individualizedDataAvailable: true,
    performanceSeason: profile.predictionSeason,
    performanceWeek: profile.predictionWeek,
    performanceCutoff: profile.cutoff,
    fieldGoals: posterior,
    overallFieldGoals: profile.overallFieldGoals,
    extraPoints: {
      attempts: Math.max(0, number(xpStats.attempts) || 0),
      makes: Math.max(0, number(xpStats.makes) || 0),
      misses: Math.max(0, number(xpStats.misses) || 0),
      blocks: Math.max(0, number(xpStats.blocks) || 0),
      accuracyAttempts: xpAccuracyAttempts,
      posteriorRate: posteriorXp,
      leagueRate: leaguePriors.extraPoints.rate,
      priorStrength: XP_PRIOR_STRENGTH,
    },
    gamesRepresented: profile.gamesRepresented,
    latestEligibleGame: profile.latestEligibleGame,
    sampleConfidence,
    leagueRates: leaguePriors,
    blockedAttemptTreatment: leaguePriors.blockedAttemptTreatment,
    provenance: {
      source: profile.source,
      sourceAsOf: profile.sourceAsOf,
      generatedAt: profile.generatedAt,
      latestEligibleGame: profile.latestEligibleGame,
      gamesRepresented: profile.gamesRepresented,
    },
    fallbackActive: false,
    unavailableReason: null,
    selectionReason: selected.reason,
  };
}

function eligiblePersonnelView(view, team, season, week, cutoff) {
  return view?.version === PERSONNEL_VIEW_VERSION &&
    canonicalTeam(view.team) === canonicalTeam(team) &&
    Number(view.season) === Number(season) &&
    Number(view.week) === Number(week) &&
    Number.isFinite(Date.parse(view.cutoff || "")) &&
    Date.parse(view.cutoff) === Date.parse(cutoff || "");
}

function hasSupportedProfile(profile, team, artifactValid) {
  if (!artifactValid || profile.schemaVersion !== KICKER_METRICS_SCHEMA ||
      canonicalTeam(profile.team) !== canonicalTeam(team) || !profile.playerId ||
      !Array.isArray(profile.gameProvenance) || profile.gamesRepresented < 1) return false;
  const attempts = [...KICKER_BUCKETS].reduce((sum, bucket) =>
    sum + (number(profile.fieldGoals?.[bucket]?.accuracyAttempts) || 0), 0);
  return attempts + (number(profile.extraPoints?.accuracyAttempts) || 0) > 0;
}

function selectExpectedKicker(team, personnelView) {
  const code = canonicalTeam(team);
  if (canonicalTeam(personnelView?.team) !== code) {
    return { kicker: null, reason: "No eligible shared point-in-time personnel view for kicker identity" };
  }
  const candidates = (personnelView.players || []).filter((player) =>
    canonicalPosition(player.position) === "K" && canonicalTeam(player.team) === code &&
    player.canonicalId && player.eligibleBeforeCutoff && !player.sourceConflict)
    .map((player) => ({
      ...player,
      depth: number(player.liveRank ?? player.chartRank ?? player.rank),
      identityConfidence: player.confidence === "live-identity" ||
        player.confidence === "matched-by-identity" ? 0.9 : 0.7,
      provenance: player.provenance,
    }))
    .filter((player) => player.depth !== null && player.depth > 0)
    .sort((a, b) => a.depth - b.depth || String(a.canonicalId).localeCompare(String(b.canonicalId)));
  if (!candidates.length) return { kicker: null, reason: "No point-in-time K/PK depth identity is supported" };
  const firstDepth = candidates[0].depth;
  const starters = candidates.filter((candidate) => candidate.depth === firstDepth);
  if (starters.length !== 1 || starters[0].identityConflict) {
    return { kicker: null, reason: "Kicker identity conflict is unresolved" };
  }
  const starter = starters[0];
  if (!starter.statusKnown || starter.status === "Unknown") {
    return {
      kicker: normalizeKickerIdentity(starter),
      forceFallback: true,
      reason: "Expected kicker identity is supported; availability remains Unknown",
    };
  }
  if (!UNAVAILABLE.has(starter.status)) {
    if (!starter.propEligible) {
      return { kicker: normalizeKickerIdentity(starter), reason: `Expected kicker is not eligible: ${starter.status}` };
    }
    return { kicker: normalizeKickerIdentity(starter), reason: "Selected from eligible point-in-time K/PK depth evidence" };
  }
  const possibleReplacements = candidates.filter((candidate) => candidate.depth > firstDepth &&
    candidate.statusKnown && candidate.status !== "Unknown" && !UNAVAILABLE.has(candidate.status) &&
    candidate.propEligible);
  if (possibleReplacements[0]?.identityConflict) {
    return {
      kicker: null,
      unavailableKicker: normalizeKickerIdentity(starter),
      forceFallback: true,
      reason: "Kicker identity conflict is unresolved for the replacement",
    };
  }
  const replacement = possibleReplacements.find((candidate) => !candidate.identityConflict);
  if (!replacement) return {
    kicker: null,
    unavailableKicker: normalizeKickerIdentity(starter),
    forceFallback: true,
    reason: `Unavailable kicker ${starter.name || starter.canonicalId} has no supported available replacement`,
  };
  return {
    kicker: { ...normalizeKickerIdentity(replacement), replacementFor: starter.canonicalId },
    reason: `${replacement.name} is the next eligible point-in-time kicker, replacing unavailable ${starter.name || starter.canonicalId}`,
  };
}

function normalizeKickerIdentity(player) {
  return {
    canonicalId: String(player.canonicalId),
    gsisId: player.gsisId || null,
    name: player.name || null,
    team: canonicalTeam(player.team),
    status: player.status || "Unknown",
    identityConfidence: player.identityConfidence,
    opportunityFactor: player.opportunityFactor,
    provenance: {
      ...(player.provenance || {}),
      source: player.confidence || "point-in-time-personnel",
      observedAt: player.observationTimestamp || player.chartObservationTimestamp || null,
    },
    depth: player.depth,
    replacementFor: player.replacementFor || null,
  };
}

function buildFallbackTeam(team, kicker, reason, leaguePriors, selection = {}) {
  const priors = leaguePriors || normalizedLeaguePriors(null);
  return {
    team: canonicalTeam(team),
    expectedKicker: kicker ? {
      playerId: kicker.canonicalId || kicker.playerId || kicker.gsisId || null,
      gsisId: kicker.gsisId || kicker.canonicalId || kicker.playerId || null,
      fullName: kicker.name || kicker.fullName || null,
      team: canonicalTeam(team),
      availabilityStatus: kicker.status || kicker.availabilityStatus || "Unknown",
      identityConfidence: kicker.identityConfidence,
      identityProvenance: kicker.provenance,
      selectedFromDepth: kicker.depth || kicker.selectedFromDepth || null,
      replacementFor: kicker.replacementFor || null,
    } : null,
    availabilityStatus: kicker?.status || kicker?.availabilityStatus ||
      selection.unavailableKicker?.status || "Unknown",
    availabilityFactor: clamp(number(kicker?.opportunityFactor) ?? 1, 0, 1),
    unavailableKicker: selection.unavailableKicker ? {
      playerId: selection.unavailableKicker.canonicalId,
      gsisId: selection.unavailableKicker.gsisId,
      fullName: selection.unavailableKicker.name,
      team: canonicalTeam(team),
      availabilityStatus: selection.unavailableKicker.status,
      identityConfidence: selection.unavailableKicker.identityConfidence,
      identityProvenance: selection.unavailableKicker.provenance,
    } : null,
    identityConfidence: kicker?.identityConfidence || 0,
    identityProvenance: kicker?.provenance || null,
    profileAvailable: false,
    individualizedDataAvailable: false,
    performanceSeason: null,
    performanceWeek: null,
    performanceCutoff: null,
    fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, {
      rate: priors.fieldGoals[bucket].rate,
      makes: 0,
      attempts: 0,
      accuracyAttempts: 0,
      misses: 0,
      blocks: 0,
      leagueRate: priors.fieldGoals[bucket].rate,
      priorStrength: KICKER_PRIOR_STRENGTH,
    }])),
    overallFieldGoals: null,
    extraPoints: {
      attempts: 0, makes: 0, misses: 0, blocks: 0, accuracyAttempts: 0,
      posteriorRate: priors.extraPoints.rate,
      leagueRate: priors.extraPoints.rate,
      priorStrength: XP_PRIOR_STRENGTH,
    },
    gamesRepresented: 0,
    latestEligibleGame: null,
    sampleConfidence: 0,
    leagueRates: priors,
    blockedAttemptTreatment: priors.blockedAttemptTreatment,
    provenance: null,
    fallbackActive: true,
    unavailableReason: reason,
    selectionReason: selection.reason || reason,
  };
}

function posteriorRate(makes, attempts, priorRate, priorStrength) {
  const result = (makes + priorStrength * priorRate) / (attempts + priorStrength);
  return Number.isFinite(result) ? clamp(result, 0, 1) : priorRate;
}
