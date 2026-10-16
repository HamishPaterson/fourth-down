import {
  PERSONNEL_VIEW_VERSION,
} from "./personnelView.js";
import {
  MATCHUP_INTELLIGENCE_SCHEMA_VERSION,
  PREDICTION_FEATURE_VERSION,
} from "../src/services/predictionFeatures.js";

export function activePersonnelRecord(canonicalId, team, overrides = {}) {
  return {
    canonicalId: String(canonicalId),
    team,
    status: "Active",
    statusKnown: true,
    projectedAvailable: true,
    propEligible: true,
    eligibleBeforeCutoff: true,
    identityConflict: false,
    sourceConflict: false,
    ...overrides,
  };
}

export function personnelViewFixture(team, season, week, cutoff, players = []) {
  return {
    version: PERSONNEL_VIEW_VERSION,
    team,
    season: Number(season),
    week: Number(week),
    cutoff,
    chart: { available: true, observedAt: new Date(Date.parse(cutoff) - 86400000).toISOString() },
    live: { available: false, observedAt: null },
    players,
    quarterback: { resolved: true, conflict: false, player: null },
    units: {
      front: { available: false },
      LB: { available: false },
      DB: { available: false },
    },
  };
}

export function predictionFeatureFixture(away, home, season, week, cutoff, players = { away: [], home: [] }) {
  const signals = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup",
    "pressureMatchup", "thirdDownMatchup", "redZoneMatchup"].map((layer) => ({
    layer,
    available: true,
    matchups: { away: { confidence: 0.6 }, home: { confidence: 0.6 } },
  }));
  const situationalSignals = ["thirdDown", "redZone"].map((key) => ({ key, available: true }));
  const opponentNetwork = { available: true, confidence: 0.6, homePoints: 0, awayPoints: 0 };
  return {
    predictionFeatureVersion: PREDICTION_FEATURE_VERSION,
    opponentNetworkStatus: "available",
    personnelVersion: PERSONNEL_VIEW_VERSION,
    personnelViews: {
      away: personnelViewFixture(away, season, week, cutoff, players.away),
      home: personnelViewFixture(home, season, week, cutoff, players.home),
    },
    predictionPayloadFeatures: {
      schemaVersion: MATCHUP_INTELLIGENCE_SCHEMA_VERSION,
      signals,
      situational: { available: true, signals: situationalSignals },
      opponentNetwork,
    },
  };
}
