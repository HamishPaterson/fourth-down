import { BEST_BETS_CANDIDATE_VERSION } from "./bestBetsService.js";
import { PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";

export const PREDICTION_FEATURE_VERSION = 2;
export const MATCHUP_INTELLIGENCE_SCHEMA_VERSION = 2;
const PHASE1 = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup"];
const SITUATIONAL = ["thirdDownMatchup", "redZoneMatchup"];

export function predictionFeatureStatus(snapshot) {
  const payload = snapshot?.predictionPayload;
  const intelligence = payload?.matchupIntelligence;
  const signals = intelligence?.signals || [];
  const network = payload?.modelLayers?.opponentNetwork;
  const networkSource = snapshot?.dataQuality?.sources?.opponentNetwork;
  const checks = {
    version: snapshot?.predictionFeatureVersion === PREDICTION_FEATURE_VERSION &&
      intelligence?.schemaVersion === MATCHUP_INTELLIGENCE_SCHEMA_VERSION,
    phase1: PHASE1.every((layer) => signals.filter((s) => s.layer === layer).length === 1),
    phase2a: intelligence?.situational?.available === true &&
      SITUATIONAL.every((layer) => signals.filter((s) => s.layer === layer && s.available && s.matchups?.away && s.matchups?.home).length === 1),
    network: network?.available === true && network.confidence > 0 &&
      [network.homePoints, network.awayPoints, network.confidence].every(Number.isFinite) &&
      networkSource?.available === true && snapshot?.opponentNetworkStatus === "available",
    candidates: snapshot?.bestBets?.candidateVersion === BEST_BETS_CANDIDATE_VERSION &&
      Array.isArray(snapshot.bestBets.candidates),
    personnel: snapshot?.personnelVersion === PERSONNEL_VIEW_VERSION &&
      ["away", "home"].every((side) => {
        const view = snapshot?.personnelViews?.[side];
        return view?.version === PERSONNEL_VIEW_VERSION &&
          view.team === snapshot[`${side}Code`] &&
          view.season === Number(snapshot.season) && view.week === Number(snapshot.week) &&
          view.cutoff === snapshot.dataQuality?.personnelTiming?.cutoff &&
          Number.isFinite(Date.parse(view.cutoff)) &&
          (!view.chart.available || (Number.isFinite(Date.parse(view.chart.observedAt)) &&
            Date.parse(view.chart.observedAt) <= Date.parse(view.cutoff))) &&
          (!view.live.available || (Number.isFinite(Date.parse(view.live.observedAt)) &&
            Date.parse(view.live.observedAt) <= Date.parse(view.cutoff))) &&
          Array.isArray(view.players) && view.quarterback &&
          ["front", "LB", "DB"].every((unit) => view.units?.[unit]);
      }),
  };
  return { ...checks, complete: Object.values(checks).every(Boolean) };
}
