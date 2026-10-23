import { createHash, randomUUID } from "node:crypto";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import { validLockPlan } from "./weeklyMultiReadiness.js";
import { completePrediction } from "./predictionEligibility.js";
import { candidateIdentity } from "./weeklyMulti.js";

const label = (value) => String(value || "").replace(/[^a-zA-Z0-9 ._+@:/-]/g, "").slice(0, 120);
const iso = (value) => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function buildWeeklyLockPlan(context, now) {
  const plan = {
    id: randomUUID(), season: context.season, week: context.week, lock_at: context.lockAt,
    prepared_at: now.toISOString(), source: "server-prepared",
    expected_game_count: context.games.length,
    games: context.games.map((game) => ({ away: game.visitor_team?.abbreviation || game.away,
      home: game.home_team?.abbreviation || game.home, kickoff: game.date || game.sourceDate })),
  };
  if (!validLockPlan(plan, now)) throw new Error("INVALID_PRE_LOCK_PLAN");
  return plan;
}

export async function saveWeeklyLockPlan(client, context, now) {
  const plan = buildWeeklyLockPlan(context, now);
  const { data: existing, error: readError } = await client.from("weekly_multi_lock_plans").select("*")
    .eq("lock_at", plan.lock_at).maybeSingle();
  if (readError) throw new Error("LOCK_PLAN_READ_FAILED");
  if (existing) {
    if (!validLockPlan(existing, now) || existing.season !== plan.season || existing.week !== plan.week ||
        JSON.stringify(existing.games) !== JSON.stringify(plan.games)) throw new Error("IMMUTABLE_LOCK_PLAN_CONFLICT");
    return existing;
  }
  const { data, error } = await client.from("weekly_multi_lock_plans").insert(plan).select("*").single();
  if (error) throw new Error("LOCK_PLAN_PERSISTENCE_FAILED");
  return data;
}

export function buildLockManifest({ operationId, plan, predictions = [], odds, readiness, now, result, parentId = null }) {
  const candidates = readiness?.selection?.eligibleCandidates || [];
  const payload = {
    version: 1, operationId, parentId,
    season: plan?.season || null, week: plan?.week || null,
    scheduledLockAt: iso(plan?.lock_at), preparedAt: now.toISOString(),
    planId: plan?.id || null, preparationResult: result,
    predictions: predictions.map((row) => ({
      id: label(row.id), season: row.season, week: row.week,
      away: label(row.awayCode), home: label(row.homeCode),
      modelName: label(row.modelKey), modelVersion: number(Number(row.modelVersion)),
      generatedAt: iso(row.generatedAt), authoritative: row.authoritative === true,
      complete: completePrediction(row), databaseId: label(row.databaseId),
      modelScores: { away: number(row.fourthDownAwayScore), home: number(row.fourthDownHomeScore) },
      generationCutoff: iso(row.lockProvenance?.generationCutoff),
      inputs: (row.lockProvenance?.inputs || []).map((input) => ({
        source: label(input.source), observedAt: iso(input.observedAt), available: input.available === true,
      })),
      playerProjections: row.playerProjections?.available === true,
      personnelContext: Boolean(row.personnelViews?.away && row.personnelViews?.home),
      playerDiagnostics: (row.bestBets?.marketDiagnostics?.playerDiagnostics || []).map((diagnostic) =>
        Object.fromEntries(["providerPlayerName", "projectionPlayerName", "normalizedProviderName",
          "normalizedProjectionName", "providerTeam", "projectionTeam", "market", "identityState",
          "availabilityState", "rejectionCode"].map((key) => [key, label(diagnostic[key])]))),
      modelMarketDependencies: (row.lockProvenance?.marketDependencies || []).map((input) => ({
        market: label(input.market), quoteId: label(input.quoteId), timestamp: iso(input.timestamp),
      })),
      personnel: ["away", "home"].flatMap((side) => (row.personnelViews?.[side]?.players || []).map((player) => ({
        id: label(player.canonicalId), team: label(player.team), position: label(player.position),
        status: label(player.status), availabilityState: label(player.availabilityState),
        statusKnown: player.statusKnown === true, propEligible: player.propEligible === true,
        eligibleBeforeCutoff: player.eligibleBeforeCutoff === true,
        identityConflict: player.identityConflict === true, sourceConflict: player.sourceConflict === true,
        observedAt: iso(player.observationTimestamp), cutoff: iso(player.cutoff),
      }))),
      rejections: readiness?.predictionRejections.find((item) => item.predictionId === row.id)?.reasons || [],
    })),
    consideredCandidates: predictions.flatMap((prediction) => [
      ...(prediction.bestBets?.candidates || prediction.bestBets?.recommendations || []),
      prediction.bestBets?.anytimeTdScorer,
    ].filter(Boolean).map((candidate) => ({
      candidateId: label(candidateIdentity({ ...candidate,
        matchupKey: `${prediction.season}:${prediction.week}:${prediction.awayCode}:${prediction.homeCode}` })),
      predictionId: label(prediction.id), quoteId: label(candidate.quoteId),
      market: label(candidate.market), selection: label(candidate.selection), bookmaker: label(candidate.sportsbook),
      price: number(candidate.price), line: number(candidate.line), decimalOdds: number(candidate.decimalOdds),
      modelProbability: number(candidate.modelProbability), edge: number(candidate.edge),
      expectedValue: number(candidate.expectedValue), quoteAt: iso(candidate.updatedAt),
      personnelId: label(candidate.personnelId), playerId: label(candidate.playerId),
      playerTeam: label(candidate.playerTeam), roleConfidence: number(candidate.roleConfidence),
    }))),
    quotes: (odds?.events || []).flatMap((event) => (event.bookmakers || []).flatMap((book) =>
      (book.markets || []).flatMap((market) => (market.outcomes || []).map((outcome) => ({
        snapshotId: label(outcome.quoteSource?.snapshotId ||
          `nfl:${plan?.season}:${plan?.week}:${market.key}:${outcome.quoteSource?.fetchedAt || ""}`),
        snapshotAt: iso(outcome.quoteSource?.fetchedAt), quoteId: label(outcome.quoteSource?.id),
        provider: label(outcome.quoteSource?.provider || "SharpAPI"),
        eventId: label(event.id), away: label(event.away_team_code || event.away_team),
        home: label(event.home_team_code || event.home_team), market: label(market.key),
        bookmaker: label(book.key || book.title), selection: label(outcome.name),
        playerName: label(outcome.playerName), price: number(outcome.price), line: number(outcome.point),
        quoteAt: iso(outcome.quoteSource?.timestamp || outcome.updatedAt || market.last_update || book.last_update),
      }))))),
    candidates: (readiness?.selection?.candidateDiagnostics || []).map((row) => ({
      candidateId: label(row.candidateId), predictionId: label(row.predictionId),
      quoteId: label(row.quoteId), market: row.market,
      identityResult: row.identityState, availabilityResult: row.availabilityState,
      finalEligibility: row.eligible, rejectionCodes: row.reasons,
    })),
    rankingInputs: candidates.map((row) => ({
      predictionId: label(row.predictionId), quoteId: label(row.quoteId),
      market: label(row.market), bookmaker: label(row.sportsbook), selection: label(row.selection),
      provider: label(row.provider), decimalOdds: number(row.decimalOdds), line: number(row.line),
      modelProbability: number(row.modelProbability), edge: number(row.edge), expectedValue: number(row.expectedValue),
      quoteAt: iso(row.updatedAt),
    })),
    selected: (readiness?.selection?.legs || []).map((row) => ({
      predictionId: label(row.predictionId), quoteId: label(row.quoteId), market: label(row.market),
      bookmaker: label(row.sportsbook), selection: label(row.selection), price: number(row.price), line: number(row.line),
      decimalOdds: number(row.decimalOdds), quoteAt: iso(row.updatedAt), provider: label(row.provider),
    })),
    readiness: readiness ? {
      status: readiness.status, blockingReasons: readiness.blockingReasons, markets: readiness.markets,
      expectedGameCount: readiness.expectedGameCount, eligibleBestBetCount: readiness.eligibleBestBetCount,
      validUniqueMatchupCount: readiness.validUniqueMatchupCount,
    } : null,
    requiredModel: { name: CURRENT_MODEL_KEY, version: CURRENT_MODEL_VERSION },
  };
  return { id: randomUUID(), operation_id: operationId, season: plan?.season || null, week: plan?.week || null,
    lock_at: iso(plan?.lock_at), payload, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

export async function persistLockManifest(client, manifest) {
  const { error } = await client.from("weekly_multi_lock_manifests").insert(manifest);
  if (error) throw new Error("AUDIT_STORAGE_UNAVAILABLE");
  return manifest.id;
}

export async function recordLockExecution(client, record) {
  console.info("Weekly Multi execution", JSON.stringify(record));
  const { error } = await client.from("weekly_multi_lock_executions").insert(record);
  if (error) throw new Error("AUDIT_STORAGE_UNAVAILABLE");
}

export function summarizeLockExecution(records, scheduledAt) {
  const events = (records || []).filter((row) => row.scheduled_at === scheduledAt);
  if (!events.length) return { status: "UNKNOWN", reason: "NO_INVOCATION_RECORDED" };
  const last = events.at(-1);
  if (last.authorization_result === "DENIED") return { status: "AUTHORIZATION_FAILED" };
  if (last.stage === "STARTED" || last.stage === "EVALUATED") {
    return { status: "UNKNOWN", reason: "HANDLER_INCOMPLETE", operationId: last.operation_id };
  }
  if (last.result === "PIPELINE_FAILED") return {
    status: last.lock_result === "SUCCEEDED" ? "LOCK_SUCCEEDED_AUDIT_FAILED" : "HANDLER_FAILED",
    code: last.failure_code,
  };
  if (last.result === "READINESS_FAILED") return { status: "READINESS_FAILED" };
  return { status: last.result, operationId: last.operation_id };
}
