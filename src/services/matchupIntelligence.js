import { TEAM_NAMES } from "../data.js";
import { validatePlayerMetrics } from "../../api-lib/playerMetrics.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 10000) / 10000;
const name = (code) => TEAM_NAMES[code] || code;
const DEFINITIONS = [
  { category: "Rushing", layer: "rushMatchup", offense: "rushingEpaPerPlay", defense: "rushingEpaAllowedPerPlay", adjusted: "rushingEpaPerPlay", gain: 1.2, cap: .2, mix: "rushRate", unit: "EPA/play" },
  { category: "Passing", layer: "passMatchup", offense: "passingEpaPerPlay", defense: "passingEpaAllowedPerPlay", adjusted: "passingEpaPerPlay", gain: 1.2, cap: .2, mix: "passRate", unit: "EPA/play" },
  { category: "Success/Efficiency", layer: "successMatchup", offense: "successRate", defense: "defensiveSuccessRate", adjusted: "successRate", gain: 1, cap: .06, unit: "rate" },
  { category: "Explosive-play matchup", layer: "explosiveMatchup", offense: "explosivePlayRate", defense: "explosivePlayRateAllowed", adjusted: "explosivePlayRate", gain: 1.5, cap: .06, unit: "rate" },
];

function sampleConfidence(away, home) {
  const values = [away?.games, home?.games, away?.offensivePlays, home?.offensivePlays,
    away?.defensivePlays, home?.defensivePlays];
  if (!values.every((value) => finite(value) && value > 0)) return 0;
  return Math.min(.8, away.games / 6, home.games / 6,
    away.offensivePlays / 360, home.offensivePlays / 360,
    away.defensivePlays / 360, home.defensivePlays / 360);
}

function metric(value, key, unit) {
  return { field: key, value, unit };
}

function sideSignal(own, other, definition, mix) {
  const { offense, defense, adjusted, unit } = definition;
  const offensive = own?.[offense], defensive = other?.[defense];
  const supported = finite(offensive) && finite(defensive) &&
    (unit !== "rate" || [offensive, defensive].every((v) => v >= 0 && v <= 1));
  const adjustment = own?.opponentAdjusted?.[adjusted];
  const adjustedAvailable = finite(adjustment) &&
    Array.isArray(own?.opponentAdjusted?.opponents) && own.opponentAdjusted.opponents.length > 0;
  // Adjusted success/explosives are residuals, so add their bounded residual to the raw rate.
  const adjustedOffense = unit === "rate" ? offensive + adjustment : adjustment;
  const effective = supported && adjustedAvailable ? offensive * .75 + adjustedOffense * .25 : offensive;
  const exposure = definition.mix ? mix?.available ? mix[definition.mix] : .5 : 1;
  return {
    supported, offensiveMetric: metric(finite(offensive) ? offensive : null, offense, unit),
    defensiveMetric: metric(finite(defensive) ? defensive : null, defense, unit),
    opponentAdjustedMetric: adjustedAvailable ? metric(adjustment, `opponentAdjusted.${adjusted}`, unit) : null,
    exposure, exposureSource: definition.mix ? mix?.available ? "eligible expected play mix" : "fixed conservative category weight; observed mix unavailable" : "all plays",
    rawInteraction: supported ? (offensive + defensive) * exposure : 0,
    interaction: supported ? (effective + defensive) * exposure : 0,
  };
}

export function buildExpectedPlayMix({ away, home, teamMetrics, playerMetrics, prediction, season, week }) {
  const result = {};
  for (const [side, code, otherSide] of [["away", away, "home"], ["home", home, "away"]]) {
    const cutoff = teamMetrics?.[side]?.expectedLineup?.cutoff;
    const isolated = { ...playerMetrics, [otherSide]: null };
    const reason = validatePlayerMetrics(isolated, { season, week, cutoff });
    const totals = playerMetrics?.[side]?.teamTotals;
    const own = teamMetrics?.[side], other = teamMetrics?.[otherSide];
    const opportunities = totals ? totals.passAttempts + totals.sacksAllowed + totals.rushingAttempts : 0;
    const sourceMatches = playerMetrics?.[side]?.team === code;
    const teamVolumeUnavailable = own?.availability?.teamMetricsAvailable === false;
    if (reason || teamVolumeUnavailable || !sourceMatches || !(opportunities > 0) ||
        !finite(prediction?.[side]?.expectedPossessions) || !finite(own?.playsPerGame)) {
      result[side] = { team: code, available: false,
        reason: reason || "Eligible team play-volume context unavailable" };
      continue;
    }
    const basePassRate = (totals.passAttempts + totals.sacksAllowed) / opportunities;
    const pass = [own.passingEpaPerPlay, other?.passingEpaAllowedPerPlay];
    const rush = [own.rushingEpaPerPlay, other?.rushingEpaAllowedPerPlay];
    const matchupShift = [...pass, ...rush].every(finite)
      ? clamp(((pass[0] + pass[1]) - (rush[0] + rush[1])) * .025, -.015, .015) : 0;
    const scoreEdge = prediction[side].expectedPoints - prediction[otherSide].expectedPoints;
    const scriptShift = finite(scoreEdge) ? clamp(-scoreEdge * .0025, -.035, .035) : 0;
    const weatherShift = finite(prediction.weather?.passRatioShift) ? -prediction.weather.passRatioShift : 0;
    const passRate = round(clamp(basePassRate + matchupShift + scriptShift + weatherShift, .3, .8));
    const possessions = prediction[side].expectedPossessions;
    const expectedPlays = round(clamp(own.playsPerGame * .5 + possessions * 6.05 * .5, 48, 82));
    result[side] = {
      team: code, teamName: name(code), available: true, basePassRate: round(basePassRate),
      passRate, rushRate: round(1 - passRate), expectedPlays, expectedPossessions: possessions,
      expectedDropbacks: round(expectedPlays * passRate), expectedRushes: round(expectedPlays * (1 - passRate)),
      matchupShift: round(matchupShift), scriptShift: round(scriptShift), weatherShift: round(weatherShift),
      script: scriptShift > .005 ? `${name(code)} trails in the baseline projection; a small passing increase is applied.`
        : scriptShift < -.005 ? `${name(code)} leads in the baseline projection; a small rushing increase is applied.`
          : `${name(code)} retains its observed play tendency in a close baseline projection.`,
      source: "Eligible pass attempts + sacks and rushing attempts; not neutral-situation tendency",
    };
  }
  return result;
}

export function buildMatchupIntelligence({ away, home, teamMetrics, playMix }) {
  const phase1Available = [teamMetrics?.away, teamMetrics?.home].every((team) =>
    !team?.availability || team.availability.phase1Available === true);
  const confidence = phase1Available ? sampleConfidence(teamMetrics?.away, teamMetrics?.home) : 0;
  const signals = DEFINITIONS.map((definition) => {
    const awaySignal = sideSignal(teamMetrics?.away, teamMetrics?.home, definition, playMix?.away);
    const homeSignal = sideSignal(teamMetrics?.home, teamMetrics?.away, definition, playMix?.home);
    const available = confidence > 0 && awaySignal.supported && homeSignal.supported;
    const points = available ? clamp((homeSignal.interaction - awaySignal.interaction) *
      definition.gain * confidence / 2, -definition.cap, definition.cap) : 0;
    const rawPoints = available ? clamp((homeSignal.rawInteraction - awaySignal.rawInteraction) *
      definition.gain * confidence / 2, -definition.cap, definition.cap) : 0;
    return {
      category: definition.category, layer: definition.layer, available,
      reason: available ? null : `Required ${definition.offense}/${definition.defense} sample unavailable`,
      awayTeam: away, homeTeam: home, matchups: { away: awaySignal, home: homeSignal },
      confidence: available ? round(confidence) : 0, homePoints: points, rawHomePoints: rawPoints,
    };
  });
  const magnitude = signals.reduce((sum, signal) => sum + Math.abs(signal.homePoints), 0);
  // Leave room for the engine's three-decimal layer rounding inside the one-point margin budget.
  const scale = magnitude > .498 ? .498 / magnitude : 1;
  const layers = {};
  for (const signal of signals) {
    signal.homePoints = round(signal.homePoints * scale);
    signal.awayPoints = -signal.homePoints;
    signal.metricAdjustmentHomePoints = round(signal.homePoints - signal.rawHomePoints * scale);
    signal.correlationScale = round(scale);
    layers[signal.layer] = {
      active: Math.abs(signal.homePoints) >= .0001, available: signal.available,
      homePoints: signal.homePoints, awayPoints: signal.awayPoints, confidence: signal.confidence,
      reasons: [signal.reason || `${name(away)} and ${name(home)}: measured ${signal.category.toLowerCase()} interaction; correlated-signal budget applied`],
    };
  }
  return { signals, layers, playMix };
}

export function pressureSignal({ away, home, teamMetrics, layer }) {
  const supported = [teamMetrics?.away?.pressureAllowedRate, teamMetrics?.home?.pressureGeneratedRate,
    teamMetrics?.home?.pressureAllowedRate, teamMetrics?.away?.pressureGeneratedRate]
    .every((value) => finite(value) && value >= 0 && value <= 1);
  const available = supported && layer?.available !== false && layer?.confidence > 0;
  return {
    category: "Pressure", layer: "pressureMatchup", available,
    awayTeam: away, homeTeam: home, confidence: layer?.confidence || 0,
    homePoints: layer?.homePoints || 0, awayPoints: layer?.awayPoints || 0,
    matchups: Object.fromEntries([["away", "home"], ["home", "away"]].map(([side, other]) => [side, {
      offensiveMetric: metric(teamMetrics?.[side]?.pressureAllowedRate ?? null, "pressureAllowedRate", "rate"),
      defensiveMetric: metric(teamMetrics?.[other]?.pressureGeneratedRate ?? null, "pressureGeneratedRate", "rate"),
      opponentAdjustedMetric: null,
    }])),
    reason: available ? null : "Hit/sack pressure-proxy inputs or the existing pressure layer unavailable",
    reusedExistingLayer: true,
  };
}

export function explainMatchupSignal(signal, actualHomeMarginEffect) {
  const advantagedSide = actualHomeMarginEffect > 0 ? "home" : "away";
  const advantagedTeam = signal[`${advantagedSide}Team`];
  const disadvantagedTeam = signal[`${advantagedSide === "home" ? "away" : "home"}Team`];
  const safe = signal.available && Math.abs(signal.homePoints) >= .0001 &&
    finite(actualHomeMarginEffect) && Math.abs(actualHomeMarginEffect) >= .01 &&
    actualHomeMarginEffect * signal.homePoints > 0;
  const describe = (side) => {
    const code = signal[`${side}Team`], other = signal[`${side === "home" ? "away" : "home"}Team`];
    const matchup = signal.matchups[side];
    const format = (m) => m.unit === "rate" ? `${(m.value * 100).toFixed(1)}%` : `${m.value.toFixed(3)} ${m.unit}`;
    if (signal.category === "Pressure") {
      return `${name(code)} allow a ${format(matchup.offensiveMetric)} hit/sack proxy rate; ${name(other)} generate ${format(matchup.defensiveMetric)}.`;
    }
    return `${name(code)} record ${format(matchup.offensiveMetric)}; ${name(other)} allow ${format(matchup.defensiveMetric)}.`;
  };
  const adjustedUsed = signal.matchups.away.opponentAdjustedMetric || signal.matchups.home.opponentAdjustedMetric;
  const adjustment = signal.metricAdjustmentHomePoints || 0;
  const adjustedText = adjustedUsed ? Math.abs(adjustment) < .0001
    ? "NFLverse metric-specific opponent adjustment leaves the capped signal essentially unchanged."
    : `NFLverse metric-specific opponent adjustment ${adjustment * signal.homePoints > 0 ? "strengthens" : "weakens"} the net ${name(signal.homePoints > 0 ? signal.homeTeam : signal.awayTeam)} advantage.`
    : "No metric-specific opponent adjustment is applied.";
  return {
    ...signal, advantagedTeam: safe ? advantagedTeam : null, disadvantagedTeam: safe ? disadvantagedTeam : null,
    effectDirection: safe ? `toward ${name(advantagedTeam)}` : "neutral",
    preSimulationMarginContribution: round(signal.homePoints - signal.awayPoints),
    modelMarginContribution: round(actualHomeMarginEffect), explanationSafe: Boolean(safe),
    explanation: safe ? `${describe(advantagedSide)} ${describe(advantagedSide === "home" ? "away" : "home")} ${adjustedText} Removing only this layer changes the final expected margin by ${Math.abs(actualHomeMarginEffect).toFixed(2)} points toward ${name(disadvantagedTeam)}.`
      : null,
  };
}
