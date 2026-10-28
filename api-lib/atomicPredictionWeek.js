import { randomUUID } from "node:crypto";
import { normaliseSnapshot, snapshotToDatabase } from "../api/nfl/game-stats.js";
import { validatePredictionRefreshBatch } from "./predictionRefresh.js";
import { savedGameIdentity } from "../src/services/savedGameIdentity.js";

const fail = () => { throw new Error("ATOMIC_WEEK_BATCH_INVALID"); };
const finite = (value) => typeof value === "number" ? Number.isFinite(value)
  : value === null || typeof value !== "object" || Object.values(value).every(finite);

export function prepareAtomicPredictionWeek({ context, snapshots, operationId }, now = new Date()) {
  if (context?.season !== 2026 || context?.week !== 8 || context.games?.length !== 14 ||
      snapshots?.length !== 14 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId || "")) fail();
  validatePredictionRefreshBatch(snapshots, context, now);
  const ids = new Set(), predictions = new Set(), matchups = new Set(), teams = new Set();
  const rows = snapshots.map((snapshot, index) => {
    const game = savedGameIdentity(snapshot), expected = context.games[index];
    if (!game || game.id !== String(expected.id) || !finite(snapshot) ||
        typeof snapshot.id !== "string" || !snapshot.id || snapshot.source !== "shared-full-model" ||
        ids.has(game.id) || predictions.has(snapshot.id) || matchups.has(`${game.away}:${game.home}`) ||
        teams.has(game.away) || teams.has(game.home) ||
        !snapshot.predictionPayload.inputEvidence?.espn || !snapshot.predictionPayload.inputEvidence?.nflverse ||
        !snapshot.predictionPayload.inputEvidence?.opponentNetwork || !snapshot.predictionPayload.inputEvidence?.personnel ||
        !snapshot.dataQuality?.sources?.playByPlay?.available || !snapshot.dataQuality?.sources?.playerMetrics?.available ||
        !Array.isArray(snapshot.bestBets?.recommendations) || !Array.isArray(snapshot.bestBets?.candidates) ||
        !snapshot.bestBets?.anytimeTdModelPick) fail();
    ids.add(game.id); predictions.add(snapshot.id); matchups.add(`${game.away}:${game.home}`);
    teams.add(game.away); teams.add(game.home);
    return snapshotToDatabase(normaliseSnapshot({ ...snapshot, authoritative: true,
      batchProvenance: { version: 1, source: "server-week-replacement", operationId } }));
  });
  // Detect unsupported/cyclic JSON before crossing the RPC boundary.
  JSON.stringify(rows);
  return {
    season: 2026, week: 8, operationId,
    manifest: context.games.map(({ id, away, home, sourceDate }) => ({
      id: String(id), away, home, kickoff: new Date(sourceDate).toISOString(),
    })),
    rows,
  };
}

export async function readAtomicPredictionWeekState(client) {
  const { data, error } = await client.rpc("prediction_week_state");
  if (error || !data || data.count !== 14 || !/^[0-9a-f]{32}$/.test(data.fingerprint || "")) {
    throw new Error("ATOMIC_WEEK_PREFLIGHT_FAILED");
  }
  return data;
}

// Trusted server callers only; intentionally not exposed through a browser route.
export async function replaceAuthoritativePredictionWeek(client, {
  context, snapshots, expectedFingerprint, operationId = randomUUID(),
}, now = new Date()) {
  const batch = prepareAtomicPredictionWeek({ context, snapshots, operationId }, now);
  if (!/^[0-9a-f]{32}$/.test(expectedFingerprint || "")) fail();
  const { data, error, status } = await client.rpc("replace_prediction_week", {
    p: { ...batch, expectedFingerprint },
  });
  if (error) throw new Error("ATOMIC_WEEK_RPC_FAILED", { cause: {
    code: /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(error.code || "") ? error.code : null,
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  } });
  if (data?.result !== "committed" || data.writtenCount !== 14 || data.operationId !== operationId) {
    const codes = ["BATCH_INVALID", "STALE_STATE", "SCOPE_BUSY", "WRITE_FAILED", "FINAL_VERIFICATION_FAILED"];
    throw new Error(`ATOMIC_WEEK_${codes.includes(data?.failureCode) ? data.failureCode : "FAILED"}`);
  }
  return data;
}
