import { TEAM_NAMES } from "../data.js";
import { instant } from "../../api-lib/playerMetrics.js";
import { SITUATIONAL_SCHEMA } from "../../api-lib/situationalMetrics.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value * 10000) / 10000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const SITUATIONAL_RULES = {
  coefficient: 1.5, individualMarginCap: .25, sharedMarginCap: .4,
  displayConfidence: .4, displayMargin: .05,
  thirdDown: { prior: 40, minimumLeague: 100, layer: "thirdDownMatchup", category: "Third down" },
  redZone: { prior: 16, minimumLeague: 40, layer: "redZoneMatchup", category: "Red zone" },
};

function validSample(value) {
  return Number.isInteger(value?.opportunities) && value.opportunities > 0 &&
    Number.isInteger(value.conversions) && value.conversions >= 0 && value.conversions <= value.opportunities &&
    finite(value.rate) && Math.abs(value.rate - value.conversions / value.opportunities) < .00001;
}

function provenanceReason(metrics, code, { season, week, kickoff }) {
  if (metrics?.schemaVersion !== SITUATIONAL_SCHEMA) return "Situational artifact requires regenerated offense/defense counts and completed-drive provenance";
  const cutoff = instant(metrics.cutoff), source = instant(metrics.sourceAsOf);
  if (metrics.team !== code || metrics.season !== season || metrics.predictionWeek !== week || cutoff === null || source === null ||
      source > cutoff || (instant(kickoff) !== null && cutoff > instant(kickoff))) return "Situational season/week/cutoff provenance mismatch";
  if (!Array.isArray(metrics.gameProvenance) || !metrics.gameProvenance.length) return "Completed situational games unavailable";
  const seen = new Set();
  for (const game of metrics.gameProvenance) {
    const completed = instant(game.completedAsOf), start = instant(game.kickoff);
    if (!game.gameId || seen.has(game.gameId) || !Number.isInteger(game.week) || game.week < 1 || game.week >= week ||
        ![game.away, game.home].includes(code) || !TEAM_NAMES[game.away] || !TEAM_NAMES[game.home] ||
        completed === null || start === null || completed < start || start >= cutoff ||
        completed >= cutoff || completed > source) return "Invalid or future situational game provenance";
    seen.add(game.gameId);
  }
  const league = metrics.league;
  if (instant(league?.cutoff) !== cutoff || instant(league?.sourceAsOf) !== source ||
      !Number.isInteger(league?.maxWeek) || league.maxWeek < 1 || league.maxWeek >= week ||
      instant(league.latestCompletion) === null ||
      instant(league.latestCompletion) >= cutoff ||
      instant(league.latestCompletion) > source) return "League situational provenance unavailable or future";
  return null;
}

function interaction(own, other, key, offense, defense, league) {
  const prior = SITUATIONAL_RULES[key].prior;
  const regress = (value) => (value.conversions + prior * league) / (value.opportunities + prior);
  const confidence = Math.min(.85, offense.opportunities / (offense.opportunities + prior),
    defense.opportunities / (defense.opportunities + prior));
  return {
    offense: own, defense: other, offenseName: TEAM_NAMES[own], defenseName: TEAM_NAMES[other],
    offensiveRate: offense.rate, defensiveRateAllowed: defense.rate,
    offensiveOpportunities: offense.opportunities, defensiveOpportunities: defense.opportunities,
    regressedOffense: regress(offense), regressedDefenseAllowed: regress(defense),
    leagueAverage: league, priorOpportunities: prior, confidence,
    interaction: (regress(offense) + regress(defense) - 2 * league) / 2,
    distanceBuckets: key === "thirdDown" ? { offense: offense.buckets, defense: defense.buckets, modelWeight: 0 } : null,
  };
}

export function buildSituationalMatchups({ away, home, teamMetrics, season, week, kickoff }) {
  const awayMetrics = teamMetrics?.away?.situational, homeMetrics = teamMetrics?.home?.situational;
  const componentUnavailable = [teamMetrics?.away, teamMetrics?.home]
    .some((team) => team?.availability?.situationalAvailable === false);
  const reason = componentUnavailable ? "Situational PBP performance unavailable for this cutoff" :
    provenanceReason(awayMetrics, away, { season, week, kickoff }) ||
    provenanceReason(homeMetrics, home, { season, week, kickoff }) ||
    (["away", "home"].some((side) => teamMetrics?.[side]?.expectedLineup?.cutoff &&
      instant(teamMetrics[side].expectedLineup.cutoff) !== instant(teamMetrics[side].situational.cutoff))
      ? "Situational cutoff differs from the weekly depth cutoff" : null) ||
    (awayMetrics.cutoff !== homeMetrics.cutoff || awayMetrics.sourceAsOf !== homeMetrics.sourceAsOf
      ? "Situational team snapshots have different cutoffs or source observations" : null);
  const signals = ["thirdDown", "redZone"].map((key) => {
    const rules = SITUATIONAL_RULES[key];
    const values = [awayMetrics?.[key]?.offense, homeMetrics?.[key]?.defense,
      homeMetrics?.[key]?.offense, awayMetrics?.[key]?.defense];
    const league = awayMetrics?.league?.[key], otherLeague = homeMetrics?.league?.[key];
    const available = !reason && values.every(validSample) && validSample(league) && validSample(otherLeague) &&
      league.opportunities >= rules.minimumLeague && league.opportunities === otherLeague.opportunities &&
      league.conversions === otherLeague.conversions;
    const matchups = available ? {
      away: interaction(away, home, key, values[0], values[1], league.rate),
      home: interaction(home, away, key, values[2], values[3], league.rate),
    } : null;
    const confidence = available ? Math.min(matchups.away.confidence, matchups.home.confidence) : 0;
    const cap = SITUATIONAL_RULES.individualMarginCap / 2;
    const points = available ? clamp((matchups.home.interaction - matchups.away.interaction) *
      SITUATIONAL_RULES.coefficient * confidence / 2, -cap, cap) : 0;
    return { phase: "2A", key, category: rules.category, layer: rules.layer, awayTeam: away, homeTeam: home,
      available, reason: available ? null : reason || "Matched team/league opportunity counts unavailable or insufficient",
      confidence, matchups, homePoints: points, awayPoints: -points };
  });
  // Do not partially introduce a new situational budget when either matched metric is unsupported.
  const available = signals.every((signal) => signal.available);
  const magnitude = signals.reduce((sum, signal) => sum + Math.abs(signal.homePoints), 0);
  const budget = (SITUATIONAL_RULES.sharedMarginCap - .004) / 2;
  const correlationScale = magnitude > budget ? budget / magnitude : 1;
  const layers = {};
  for (const signal of signals) {
    signal.unbudgetedHomePoints = signal.homePoints;
    signal.homePoints = available ? round(signal.homePoints * correlationScale) : 0;
    signal.awayPoints = -signal.homePoints;
    signal.correlationScale = correlationScale;
    if (!available) {
      signal.available = false;
      signal.reason ||= "Both matched situational metrics required";
    }
    layers[signal.layer] = { available, active: available && signal.homePoints !== 0,
      homePoints: signal.homePoints, awayPoints: signal.awayPoints, confidence: signal.confidence,
      reasons: [signal.reason || "Regressed matched situational interaction; shared conservative budget"] };
  }
  return { available, signals, layers, rules: SITUATIONAL_RULES,
    sharedPreSimulationMargin: round(signals.reduce((sum, signal) => sum + Math.abs(signal.homePoints * 2), 0)),
    legacySituationalUnchanged: true };
}

export function explainSituationalSignal(signal, actualHomeMarginEffect) {
  const safe = signal.available && signal.confidence >= SITUATIONAL_RULES.displayConfidence &&
    finite(actualHomeMarginEffect) && Math.abs(actualHomeMarginEffect) >= SITUATIONAL_RULES.displayMargin &&
    actualHomeMarginEffect * signal.homePoints > 0;
  const advantage = actualHomeMarginEffect > 0 ? signal.homeTeam : signal.awayTeam;
  return { ...signal, advantagedTeam: safe ? advantage : null,
    disadvantagedTeam: safe ? advantage === signal.homeTeam ? signal.awayTeam : signal.homeTeam : null,
    modelAdvantagedTeam: signal.available && actualHomeMarginEffect * signal.homePoints > 0 ? advantage : null,
    preSimulationMarginContribution: round(2 * signal.homePoints),
    modelMarginContribution: round(actualHomeMarginEffect), explanationSafe: Boolean(safe),
    explanation: safe ? `${signal.category}: the matched regressed rates favour ${TEAM_NAMES[advantage]}; removing this layer changes the expected margin by ${Math.abs(actualHomeMarginEffect).toFixed(3)} points.` : null };
}

export function situationalFootballExplanation(signal) {
  const advantaged = signal.advantagedTeam === signal.homeTeam ? "home" : "away";
  const own = signal.matchups[advantaged], other = signal.matchups[advantaged === "home" ? "away" : "home"];
  const team = own.offenseName, rival = own.defenseName;
  const offenseStronger = own.regressedOffense >= own.leagueAverage;
  const rivalAllowsMore = own.regressedDefenseAllowed >= own.leagueAverage;
  const teamDefendsWell = other.regressedDefenseAllowed < other.leagueAverage;
  if (signal.key === "thirdDown") {
    if (offenseStronger && rivalAllowsMore) return `${team} have been effective at keeping drives alive on third down, while ${rival} have struggled to get off the field. That gives ${team} an advantage in sustaining possessions.`;
    if (teamDefendsWell) return `${rival} ${other.regressedOffense >= other.leagueAverage ? "have converted third downs efficiently" : "have struggled to convert third downs"}, but ${team} have defended third down well. Fourth Down expects ${team} to make it harder for ${rival} to sustain possessions.`;
    return `${team} ${offenseStronger ? "have converted third downs efficiently" : "have found third downs difficult"}, while ${rival} ${rivalAllowsMore ? "have struggled to get off the field" : "have defended third down well"}. The balance of those results still gives ${team} a slight relative edge in sustaining possessions.`;
  }
  if (offenseStronger && rivalAllowsMore) return `${team} have been efficient at turning red-zone trips into touchdowns, while ${rival} have allowed touchdowns too often near the goal line. That gives ${team} an advantage in finishing drives.`;
  if (teamDefendsWell) return `${rival} ${other.regressedOffense >= other.leagueAverage ? "have finished drives well" : "have struggled to finish drives"}, but ${team} have defended the red zone effectively. Fourth Down expects ${team} to limit touchdowns by ${rival} near the goal line.`;
  return `${team} ${offenseStronger ? "have finished red-zone trips efficiently" : "have struggled to finish red-zone trips"}, while ${rival} ${rivalAllowsMore ? "have allowed touchdowns too often near the goal line" : "have defended the red zone well"}. The balance of those results still gives ${team} a slight relative edge near the goal line.`;
}
