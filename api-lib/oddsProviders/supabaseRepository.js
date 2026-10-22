import { randomUUID } from "node:crypto";
import { createSnapshotClient } from "../oddsSnapshots.js";
import { requireRefreshReason, requireRefreshFailure } from "./contracts.js";

export function createPersistentOddsRepository({ client = createSnapshotClient() } = {}) {
  async function control(action, payload) {
    const { data, error } = await client.rpc("odds_provider_control", { p_action: action, p: payload });
    if (error) throw new Error(`Odds persistence ${action} failed`);
    if (!data) throw new Error(`Odds persistence ${action} returned no result`);
    return data;
  }

  async function readGeneration(refreshId) {
    const { data, error } = await client.from("odds_provider_refreshes").select("*")
      .eq("refresh_id", refreshId).maybeSingle();
    if (error) throw new Error("Reading odds generation failed");
    return data;
  }

  async function readCache(key, { now = new Date(), maxAgeMs = 5400000 } = {}) {
    const { data: scope, error } = await client.from("odds_provider_scopes").select("*")
      .eq("scope_key", scopeKey(key)).maybeSingle();
    if (error) throw new Error("Reading odds current pointer failed");
    const { data: diagnostic, error: diagnosticError } = await client.from("odds_provider_refreshes")
      .select("refresh_id,scope_key,provider,season,week,resource,started_at,completed_at,completeness_state,status,stale,failure_code,row_count,credit_usage")
      .eq("scope_key", scopeKey(key)).order("started_at", { ascending: false })
      .limit(1).maybeSingle();
    if (diagnosticError) throw new Error("Reading odds refresh metadata failed");
    const generation = scope?.current_refresh_id ? await readGeneration(scope.current_refresh_id) : null;
    if (!generation) return { snapshot: null, status: "missing", stale: true, diagnostic };
    if (generation.status !== "promoted" || generation.completeness_state !== "COMPLETE") {
      throw new Error("Current odds pointer references an invalid generation");
    }
    const snapshot = generation.snapshot;
    const ageMs = now.getTime() - Date.parse(snapshot.fetchedAt);
    const failedAttempt = diagnostic?.refresh_id !== generation.refresh_id &&
      diagnostic?.status !== "promoted";
    const stale = failedAttempt || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs;
    return {
      snapshot: structuredClone(snapshot), generation: generation.refresh_id,
      status: stale ? "stale" : "current", stale, ageMs, diagnostic,
    };
  }

  function bindRefresh(scope, refreshId) {
    return {
      paidRequestsRequireReservation: true,
      readCreditLedger,
      readBudgetState,
      appendCreditEntry,
      beforePaidRequest: async (reservationId) => {
        const result = await control("dispatch", { ...scope, refreshId, reservationId });
        if (result.dispatchAllowed !== true) throw new Error("Odds persistence dispatch failed");
        return result;
      },
      reserveCredits: ({ configuration, expectedCredits, automatic, endpoint, reason }) => {
        requireRefreshReason(reason);
        if (!configuration || !Number.isSafeInteger(configuration.monthlyLimit) ||
          !Number.isSafeInteger(configuration.automaticBudget) || configuration.monthlyLimit < 0 ||
          configuration.automaticBudget < 0) throw new Error("INVALID_CREDIT_CONFIGURATION");
        return control("reserve", {
          expectedCredits, automatic, endpoint, reasonCode: reason, ...scope, refreshId, reservationId: randomUUID(),
          monthlyLimit: configuration.monthlyLimit, automaticBudget: configuration.automaticBudget,
        });
      },
      reconcileReservation: ({ reservationId, observedCredits, requestAttempted, success, httpStatus }) =>
        control("reconcile", {
          reservationId, observedCredits, requestAttempted, success, httpStatus,
          provider: scope.provider, refreshId,
        }),
    };
  }

  async function readBudgetState({ provider, period = new Date().toISOString().slice(0, 7) }) {
    const { data, error } = await client.from("odds_provider_budgets").select("*")
      .eq("provider", provider).eq("period", period).maybeSingle();
    if (error) throw new Error("Reading provider budget state failed");
    return data;
  }

  async function readCreditLedger({ provider = "parlay", since = "0000-01" } = {}) {
    const result = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("odds_provider_usage").select("*")
        .eq("provider", provider).gte("period", since).order("timestamp").order("reservation_id")
        .range(offset, offset + 999);
      if (error) throw new Error("Reading provider credit ledger failed");
      result.push(...(data || []).map((entry) => ({
        ...entry, budgetCredits: entry.budget_credits, actualCredits: entry.observed_credits,
        automatic: entry.automatic, timestamp: entry.timestamp, provider: entry.provider,
      })));
      if (!data || data.length < 1000) return result;
      if (offset >= 999000) throw new Error("Provider credit ledger safety page limit reached");
    }
  }

  function appendCreditEntry(entry) {
    requireRefreshReason(entry.reason);
    if (entry.endpoint !== "events" || entry.expectedCredits !== 0) {
      throw new Error("Persistent paid usage requires an atomic reservation");
    }
    return control("free", {
      id: randomUUID(), provider: entry.provider, season: entry.season, week: entry.week,
      success: entry.success,
      reasonCode: entry.reason,
    });
  }

  return {
    paidRequestsRequireReservation: true,
    readCache,
    readGeneration,
    readSnapshot: async (key) => (await readCache(key)).snapshot,
    readCreditLedger,
    readBudgetState,
    appendCreditEntry,
    bindRefresh,
    acquireLease: (key) => control("acquire", { ...key, ownerToken: randomUUID() }),
    renewLease: (scope) => control("renew", scope),
    releaseLease: (scope) => control("release", scope),
    startRefresh: (scope, metadata) => control("start", { ...metadata, ...scope }),
    writeCandidate: (scope, refreshId, snapshot) => control("candidate", { ...scope, refreshId, snapshot }),
    promote: (scope, refreshId, snapshot) => control("promote", { ...scope, refreshId, snapshot }),
    failRefresh: (scope, refreshId, failureCode, completeness = "UNKNOWN") => {
      requireRefreshFailure(failureCode);
      return control("fail", { ...scope, refreshId, failureCode, completeness });
    },
  };
}

export function scopeKey({ provider, season, week, resource }) {
  return [provider, season, week, resource].join(":");
}
