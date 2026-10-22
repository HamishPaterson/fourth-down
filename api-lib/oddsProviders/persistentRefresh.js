import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCompleteResponse } from "./completeness.js";
import { canonicalTeamIdentity, normalizeEventIdentity, quoteSnapshotKey, requireRefreshReason } from "./contracts.js";
import { isEligibleBettingQuote } from "./playerResolver.js";
import { normalizeAmericanPrice, DEFAULT_CORE_MARKETS, PARLAY_MARKET_MAP } from "./parlay.js";

export function planProviderRefresh({ resource, maxPages = 1 }) {
  if (!["core", "props"].includes(resource)) throw new Error("Refresh resource must be core or props");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) {
    throw new Error("Refresh maxPages must be between 1 and 10");
  }
  return {
    resource, maxPages: resource === "core" ? 1 : maxPages,
    minimumCredits: 3, maximumCredits: resource === "core" ? 3 : 3 * maxPages,
    markets: resource === "core" ? [...DEFAULT_CORE_MARKETS] : Object.values(PARLAY_MARKET_MAP),
  };
}

export function validateGeneration(snapshot, { expectedEvents, requiredMarkets }) {
  if (!isCompleteResponse(snapshot.completeness)) throw new Error("Refresh is not COMPLETE");
  if (!Array.isArray(expectedEvents) || !expectedEvents.length || !requiredMarkets?.length) {
    throw new Error("Authoritative event and market coverage is required");
  }
  const expected = new Map(expectedEvents.map((event) => [String(event.providerEventId), event]));
  if (expected.size !== expectedEvents.length ||
    new Set(expectedEvents.map(normalizeEventIdentity)).size !== expectedEvents.length) {
    throw new Error("Authoritative event context contains duplicate identities");
  }
  const events = new Map();
  for (const event of snapshot.events || []) {
    const trusted = expected.get(event.providerEventId);
    if (!trusted || event.provider !== snapshot.provider ||
      event.season !== snapshot.season || event.week !== snapshot.week ||
      normalizeEventIdentity(event) !== normalizeEventIdentity(trusted) ||
      event.canonicalMatchupIdentity !== normalizeEventIdentity(event)) {
      throw new Error("Event identity or authoritative context mismatch");
    }
    events.set(event.providerEventId, event);
  }
  const unique = new Map();
  const coverage = new Set();
  for (const quote of snapshot.quotes || []) {
    const event = events.get(quote.providerEventId);
    const price = normalizeAmericanPrice(quote.americanOdds);
    const age = quote.ageSeconds;
    if (!event || quote.provider !== snapshot.provider || quote.season !== snapshot.season ||
      quote.week !== snapshot.week || quote.canonicalMatchupIdentity !== event.canonicalMatchupIdentity ||
      !quote.bookmaker || !requiredMarkets.includes(quote.market) || !quote.rawProviderMarket ||
      !quote.selection || !quote.side || !price ||
      Math.abs(price.decimalOdds - quote.decimalOdds) > 1e-10 ||
      Math.abs(price.impliedProbability - quote.impliedProbability) > 1e-10 ||
      !Number.isFinite(quote.decimalOdds) || !Number.isFinite(quote.impliedProbability) ||
      !Number.isFinite(Date.parse(quote.fetchedAt)) ||
      (quote.providerTimestamp !== null && !Number.isFinite(Date.parse(quote.providerTimestamp))) ||
      !["fresh", "stale", "unknown"].includes(quote.freshnessStatus) ||
      (age !== null && (!Number.isFinite(age) || age < 0)) ||
      (quote.market !== "h2h" && !Number.isFinite(quote.line)) ||
      (quote.line !== null && !Number.isFinite(quote.line)) ||
      !quote.rawPrice || quote.rawPrice.dfsNormalized === true ||
      normalizeAmericanPrice(quote.rawPrice.value)?.americanOdds !== quote.americanOdds ||
      (quote.playerName && (!quote.playerId || !isEligibleBettingQuote(quote) ||
        ![event.homeTeam, event.awayTeam].map(canonicalTeamIdentity).includes(canonicalTeamIdentity(quote.team))))) {
      throw new Error("Malformed quote, price, or player event identity");
    }
    const key = quoteSnapshotKey(quote);
    const enriched = { ...quote, quoteKey: key, refreshId: snapshot.refreshId };
    if (unique.has(key) && !isDeepStrictEqual(unique.get(key), enriched)) {
      throw new Error("Conflicting duplicate quote");
    }
    unique.set(key, enriched);
    coverage.add(`${event.providerEventId}:${quote.market}`);
  }
  for (const eventId of expected.keys()) {
    for (const market of requiredMarkets) {
      if (!coverage.has(`${eventId}:${market}`)) throw new Error(`Partial event/market coverage: ${eventId}:${market}`);
    }
  }
  const diagnostics = snapshot.diagnostics;
  if (diagnostics?.unmappedEventRows || diagnostics?.unmappedEvents?.length ||
    diagnostics?.unmappedMarkets?.length ||
    diagnostics?.rejectedRows?.some(({ reason }) => !reason.startsWith("invalid_or_missing_under_price") &&
      !reason.startsWith("invalid_or_missing_over_price"))) {
    throw new Error("Provider normalization rejected source identities or rows");
  }
  return {
    ...snapshot,
    events: [...events.values()].map((event) => ({
      ...event, homeTeamCode: canonicalTeamIdentity(event.homeTeam), awayTeamCode: canonicalTeamIdentity(event.awayTeam),
    })),
    quotes: [...unique.values()],
  };
}

export function createPersistentRefreshService({ repository, providerFactory, now = () => new Date() }) {
  const inFlight = new Map();

  async function perform({ key, events, players, maxPages = 1, automatic = true, reason, fixture, dryRun = false }) {
    requireRefreshReason(reason);
    const plan = planProviderRefresh({ resource: key.resource, maxPages });
    if (key.provider !== "parlay") throw new Error("Only the validated Parlay adapter can refresh in Phase 2");
    if (!Number.isInteger(key.season) || !Number.isInteger(key.week) || key.week < 1 || key.week > 18 ||
      !events?.length || !reason) throw new Error("Explicit refresh scope, authoritative context, and reason required");
    const refreshId = randomUUID();
    let scope;
    let started = false;
    let completeness = "UNKNOWN";
    let failureCode = "PERSISTENCE_FAILED";
    if (dryRun && !fixture) throw new Error("Dry run requires a fixture; live paid dry runs are disabled");
    if (!dryRun && fixture) throw new Error("Fixtures may only be supplied to a no-write dry run");
    try {
      if (!dryRun) {
        const lease = await repository.acquireLease(key);
        if (!lease.acquired) return { status: "locked", cache: await repository.readCache(key) };
        scope = { ...key, ...lease };
        await repository.startRefresh(scope, {
          refreshId, expectedEventIds: events.map((event) => event.providerEventId), requiredMarkets: plan.markets,
        });
        started = true;
      }
      const provider = providerFactory({ repository: dryRun ? null : repository.bindRefresh(scope, refreshId) });
      const options = { ...key, maxPages: plan.maxPages, automatic, reason };
      failureCode = "PROVIDER_REQUEST_FAILED";
      const fetched = fixture || await (key.resource === "core"
        ? provider.fetchCoreOdds({ ...options, markets: [...DEFAULT_CORE_MARKETS], regions: ["us"] })
        : provider.fetchPlayerProps(options));
      completeness = fetched.completeness?.status || "UNKNOWN";
      if (fetched.budgetBlocked) failureCode = "CREDIT_BUDGET_BLOCKED";
      if (fetched.error || fetched.budgetBlocked) throw new Error(failureCode);
      failureCode = "REFRESH_VALIDATION_FAILED";
      const normalized = key.resource === "core"
        ? provider.normalizeCoreOdds(fetched, { events, ...key })
        : provider.normalizePlayerProps(fetched, { events, players, ...key });
      const snapshot = validateGeneration({
        ...key, ...normalized, refreshId, fetchedAt: fetched.fetchedAt || now().toISOString(),
        completeness: fetched.completeness,
      }, { expectedEvents: events, requiredMarkets: plan.markets });
      if (dryRun) return { status: "dry_run", snapshot, plan, writes: 0 };
      failureCode = "PERSISTENCE_FAILED";
      await repository.renewLease(scope);
      await repository.writeCandidate(scope, refreshId, snapshot);
      const persisted = await repository.readGeneration(refreshId);
      if (!isDeepStrictEqual(persisted?.snapshot, snapshot)) throw new Error("Persisted generation differs from candidate");
      validateGeneration(persisted.snapshot, { expectedEvents: events, requiredMarkets: plan.markets });
      await repository.promote(scope, refreshId, snapshot);
      return { status: "promoted", refreshId, plan, cache: await repository.readCache(key) };
    } catch {
      if (started) await repository.failRefresh(scope, refreshId, failureCode, completeness);
      if (dryRun) throw new Error(failureCode);
      return { status: "failed", refreshId, error: failureCode, cache: await repository.readCache(key) };
    } finally {
      if (scope) await repository.releaseLease(scope);
    }
  }

  return {
    refresh(input) {
      const id = JSON.stringify(input.key);
      if (inFlight.has(id)) return inFlight.get(id);
      const result = perform(input).finally(() => inFlight.delete(id));
      inFlight.set(id, result);
      return result;
    },
  };
}
