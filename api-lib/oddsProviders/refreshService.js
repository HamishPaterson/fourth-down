import { COMPLETENESS } from "./contracts.js";
import { isCompleteResponse } from "./completeness.js";
import { selectProviderResult } from "./contracts.js";
import { isEligibleBettingQuote } from "./playerResolver.js";

const RESOURCE_METHODS = Object.freeze({
  events: "listEvents",
  core: "fetchCoreOdds",
  props: "fetchPlayerProps",
});

export function createOddsRefreshService({
  repository,
  providers = [],
  now = () => new Date(),
  validate = validateNormalizedResult,
} = {}) {
  if (!repository) throw new Error("Odds refresh service requires a snapshot repository");
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const inFlight = new Map();

  async function readCacheOnly(key, options) {
    return repository.readCache(key, options);
  }

  function refresh({ provider: providerId, season, week, resource, automatic = true, reason, options = {} }) {
    const method = RESOURCE_METHODS[resource];
    if (!method) throw new Error(`Unsupported odds resource: ${resource}`);
    const provider = providerMap.get(providerId);
    if (!provider) throw new Error(`Odds provider is not registered: ${providerId}`);
    if (typeof provider[method] !== "function") {
      throw new Error(`Provider ${providerId} does not support ${resource} refreshes`);
    }
    const lockKey = [providerId, season, week, resource].join(":");
    if (inFlight.has(lockKey)) return inFlight.get(lockKey);
    const request = performRefresh({
      provider,
      providerId,
      season,
      week,
      resource,
      method,
      automatic,
      reason,
      options,
    }).finally(() => inFlight.delete(lockKey));
    inFlight.set(lockKey, request);
    return request;
  }

  async function performRefresh({
    provider,
    providerId,
    season,
    week,
    resource,
    method,
    automatic,
    reason,
    options,
  }) {
    const key = { provider: providerId, season: Number(season), week: Number(week), resource };
    const previous = await repository.readSnapshot(key);
    const attemptedAt = now().toISOString();
    try {
      const fetched = await provider[method]({
        season: Number(season),
        week: Number(week),
        automatic,
        reason: reason || `controlled ${resource} refresh`,
        ...options,
      });
      const normalized = resource === "core"
        ? provider.normalizeCoreOdds(fetched, { season, week, fetchedAt: fetched.fetchedAt, ...options })
        : resource === "props"
          ? provider.normalizePlayerProps(fetched, { season, week, fetchedAt: fetched.fetchedAt, ...options })
          : provider.normalizeEvents?.(fetched, { season, week, fetchedAt: fetched.fetchedAt, ...options }) ||
            { events: fetched.events || [], quotes: [] };
      const completeness = fetched.completeness || { status: COMPLETENESS.UNKNOWN };
      const payloadValid = validate(normalized, { provider: providerId, season, week, resource });
      const complete = isCompleteResponse(completeness) && payloadValid;
      const snapshot = {
        provider: providerId,
        season: Number(season),
        week: Number(week),
        resource,
        events: normalized.events,
        quotes: normalized.quotes,
        diagnostics: normalized.diagnostics || null,
        fetchedAt: fetched.fetchedAt || attemptedAt,
        completeness,
        pageCount: fetched.pageCount ?? null,
        pageMetadata: fetched.pages || null,
        validationStatus: payloadValid ? "valid" : "invalid",
      };
      await repository.writeRefreshResult(key, {
        snapshot,
        completeness: complete ? completeness : {
          ...completeness,
          status: completeness.status === COMPLETENESS.COMPLETE
            ? COMPLETENESS.UNKNOWN
            : completeness.status || COMPLETENESS.UNKNOWN,
        },
        validated: complete,
        attemptedAt,
        error: fetched.error || (payloadValid ? null : "Normalized odds payload failed validation"),
        pageCount: fetched.pageCount ?? null,
        pageMetadata: fetched.pages || null,
        requestId: fetched.requestId || null,
        budgetBlocked: fetched.budgetBlocked === true,
      });
      const cache = await repository.readCache(key, { now: now() });
      const failed = Boolean(fetched.error);
      return {
        status: complete ? "refreshed" : fetched.budgetBlocked ? "budget_blocked" :
          failed ? "failed" : "incomplete",
        completeness,
        cache: cache.snapshot,
        cacheStatus: failed && cache.snapshot ? "stale" : cache.status,
        stale: failed && cache.snapshot ? true : cache.stale,
        error: fetched.error || (!payloadValid ? "Normalized odds payload failed validation" : null),
        diagnostic: await repository.readDiagnostic(key),
      };
    } catch (error) {
      const message = safeMessage(error);
      await repository.writeRefreshResult(key, {
        snapshot: null,
        completeness: { status: COMPLETENESS.UNKNOWN },
        validated: false,
        attemptedAt,
        error: message,
        pageCount: null,
        pageMetadata: null,
        requestId: null,
        budgetBlocked: false,
      });
      return {
        status: "failed",
        completeness: { status: COMPLETENESS.UNKNOWN },
        cache: previous,
        cacheStatus: previous ? "stale" : "missing",
        stale: Boolean(previous),
        error: message,
        diagnostic: await repository.readDiagnostic(key),
      };
    }
  }

  return {
    refresh,
    readCacheOnly,
    selectProviderResult,
    inFlightCount: () => inFlight.size,
  };
}

export function validateNormalizedResult(result, { provider, season, week }) {
  if (!result || !Array.isArray(result.events) || !Array.isArray(result.quotes)) return false;
  if (result.events.length === 0 || result.quotes.length === 0) return false;
  const validEvents = result.events.every((event) =>
    event.provider === provider &&
    event.providerEventId &&
    event.canonicalMatchupIdentity &&
    Number(event.season) === Number(season) &&
    Number(event.week) === Number(week) &&
    event.kickoff && event.homeTeam && event.awayTeam && event.fetchedAt
  );
  const validQuotes = result.quotes.every((quote) =>
    quote.provider === provider &&
    quote.providerEventId &&
    quote.canonicalMatchupIdentity &&
    Number(quote.season) === Number(season) &&
    Number(quote.week) === Number(week) &&
    quote.bookmaker && quote.market && quote.rawProviderMarket &&
    quote.selection && quote.side &&
    Number.isFinite(quote.americanOdds) &&
    Number.isFinite(quote.decimalOdds) && quote.decimalOdds > 1 &&
    Number.isFinite(quote.impliedProbability) && quote.impliedProbability > 0 &&
    quote.impliedProbability < 1 &&
    quote.fetchedAt && Number.isFinite(Date.parse(quote.fetchedAt)) && quote.rawPrice &&
    (quote.playerName ? typeof quote.eligibleForBetting === "boolean" &&
      (!quote.eligibleForBetting || isEligibleBettingQuote(quote)) : true) &&
    (quote.line === null || quote.line === undefined || Number.isFinite(Number(quote.line)))
  );
  return validEvents && validQuotes;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(x-api-key|authorization|parlay_api_key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}
