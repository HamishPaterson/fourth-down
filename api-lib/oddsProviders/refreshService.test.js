import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryOddsRepository } from "./inMemoryRepository.js";
import { COMPLETENESS } from "./contracts.js";
import { createOddsRefreshService } from "./refreshService.js";

const NOW = new Date("2026-10-22T01:00:00.000Z");
const COMPLETE = {
  status: COMPLETENESS.COMPLETE,
  hasMore: false,
  truncated: false,
  degraded: false,
};

function normalizedQuote(overrides = {}) {
  return {
    provider: "parlay",
    providerEventId: "event-123",
    season: 2026,
    week: 7,
    matchup: { identity: "nfl:2026:7:ne@chi", kickoff: "2026-10-23T00:15:00.000Z" },
    canonicalMatchupIdentity: "nfl:2026:7:ne@chi",
    bookmaker: "book-a",
    market: "receptions",
    rawProviderMarket: "player_receptions",
    playerId: "00-0039918",
    playerName: "Caleb Williams",
    playerIdentityStatus: "MATCHED_EXACT_NAME_EVENT",
    eligibleForBetting: true,
    team: "CHI",
    selection: "over",
    side: "over",
    line: 4.5,
    americanOdds: -110,
    decimalOdds: 1.90909,
    impliedProbability: 0.52381,
    providerTimestamp: "2026-10-22T00:59:00.000Z",
    fetchedAt: NOW.toISOString(),
    ageSeconds: 60,
    freshnessStatus: "fresh",
    rawPrice: { field: "over_price", value: -110 },
    ...overrides,
  };
}

function normalizedResult(overrides = {}) {
  return {
    events: [{
      provider: "parlay",
      providerEventId: "event-123",
      season: 2026,
      week: 7,
      kickoff: "2026-10-23T00:15:00.000Z",
      homeTeam: "Chicago Bears",
      awayTeam: "New England Patriots",
      canonicalMatchupIdentity: "nfl:2026:7:ne@chi",
      fetchedAt: NOW.toISOString(),
    }],
    quotes: [normalizedQuote()],
    ...overrides,
  };
}

function makeFakeProvider(fetchMethod, normalizeResult = normalizedResult()) {
  return {
    id: "parlay",
    fetchPlayerProps: fetchMethod,
    normalizePlayerProps: () => normalizeResult,
  };
}

function createService({ repository = new InMemoryOddsRepository(), provider } = {}) {
  const service = createOddsRefreshService({
    repository,
    providers: [provider],
    now: () => new Date(NOW),
  });
  return { service, repository };
}

test("explicit refresh validates normalized provenance then stores only a complete valid snapshot", async () => {
  let calls = 0;
  const provider = makeFakeProvider(async () => {
    calls += 1;
    return { fetchedAt: NOW.toISOString(), completeness: COMPLETE, rows: [{}], pageCount: 1 };
  });
  const { service, repository } = createService({ provider });
  const result = await service.refresh({
    provider: "parlay", season: 2026, week: 7, resource: "props", automatic: true,
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "refreshed");
  assert.equal(result.cache.completeness.status, "COMPLETE");
  assert.equal(result.cache.quotes[0].provider, "parlay");
  assert.equal(result.cache.quotes[0].rawProviderMarket, "player_receptions");
  assert.equal((await repository.readSnapshot({
    provider: "parlay", season: 2026, week: 7, resource: "props",
  })).quotes.length, 1);
});

test("truncated, degraded, paged, and unknown refreshes preserve the last complete snapshot", async (t) => {
  for (const completeness of [
    { status: COMPLETENESS.SOURCE_TRUNCATED, hasMore: false, truncated: true, degraded: false },
    { status: COMPLETENESS.SOURCE_DEGRADED, hasMore: false, truncated: false, degraded: true },
    { status: COMPLETENESS.MORE_PAGES_AVAILABLE, hasMore: true, truncated: false, degraded: false },
    { status: COMPLETENESS.UNKNOWN },
  ]) {
    await t.test(completeness.status, async () => {
      const repository = new InMemoryOddsRepository();
      let responseIndex = 0;
      const provider = makeFakeProvider(async () => {
        responseIndex += 1;
        return {
          fetchedAt: new Date(NOW.getTime() + responseIndex * 1000).toISOString(),
          completeness: responseIndex === 1 ? COMPLETE : completeness,
          rows: [{}],
        };
      });
      const { service } = createService({ repository, provider });
      const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
      const good = await service.refresh(key);
      const incomplete = await service.refresh(key);
      assert.equal(good.status, "refreshed");
      assert.equal(incomplete.status, "incomplete");
      assert.equal(incomplete.cache.quotes[0].americanOdds, -110);
      assert.equal(incomplete.cache.fetchedAt, good.cache.fetchedAt);
      assert.equal((await repository.readDiagnostic(key)).status, completeness.status);
    });
  }
});

test("provider failure preserves valid cache and exposes server-side failure diagnostic", async () => {
  const repository = new InMemoryOddsRepository();
  let fail = false;
  const provider = makeFakeProvider(async () => {
    if (fail) throw new Error("provider unavailable");
    return { fetchedAt: NOW.toISOString(), completeness: COMPLETE, rows: [{}] };
  });
  const { service } = createService({ repository, provider });
  const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  await service.refresh(key);
  fail = true;
  const result = await service.refresh(key);
  assert.equal(result.status, "failed");
  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.stale, true);
  assert.equal(result.error, "provider unavailable");
  assert.equal((await repository.readSnapshot(key)).quotes.length, 1);
  assert.equal((await repository.readDiagnostic(key)).error, "provider unavailable");
});

test("a paid-page failure marks the retained cache stale while preserving its complete quotes", async () => {
  let call = 0;
  const provider = makeFakeProvider(async () => {
    call += 1;
    return call === 1
      ? { fetchedAt: NOW.toISOString(), completeness: COMPLETE, rows: [{}] }
      : {
        fetchedAt: NOW.toISOString(),
        completeness: {
          status: COMPLETENESS.MORE_PAGES_AVAILABLE,
          hasMore: true,
          truncated: false,
          degraded: false,
        },
        rows: [{}],
        pageCount: 1,
        pages: [{ pageNumber: 1, offset: 0, rowCount: 1 }],
        error: "Parlay props request failed (HTTP 429)",
      };
  });
  const { service } = createService({ provider });
  const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  const good = await service.refresh(key);
  const failed = await service.refresh(key);
  assert.equal(good.status, "refreshed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.cacheStatus, "stale");
  assert.equal(failed.stale, true);
  assert.equal(failed.cache.quotes[0].americanOdds, -110);
  assert.equal(failed.diagnostic.pageCount, 1);
  assert.equal(failed.diagnostic.pageMetadata[0].offset, 0);
});

test("failed refresh with no cache returns explicit missing state and never writes empty success data", async () => {
  const provider = makeFakeProvider(async () => {
    throw new Error("connection failed");
  });
  const { service, repository } = createService({ provider });
  const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  const result = await service.refresh(key);
  assert.equal(result.status, "failed");
  assert.equal(result.cacheStatus, "missing");
  assert.equal(result.cache, null);
  assert.equal(await repository.readSnapshot(key), null);
});

test("cache-only reads never invoke a provider", async () => {
  let calls = 0;
  const provider = makeFakeProvider(async () => {
    calls += 1;
    throw new Error("must not run from a cache read");
  });
  const { service } = createService({ provider });
  const cache = await service.readCacheOnly({
    provider: "parlay", season: 2026, week: 7, resource: "props",
  });
  assert.equal(cache.snapshot, null);
  assert.equal(cache.status, "missing");
  assert.equal(calls, 0);
});

test("concurrent same-scope refreshes share one provider request and lock is cleaned up", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const provider = makeFakeProvider(async () => {
    calls += 1;
    await pending;
    return { fetchedAt: NOW.toISOString(), completeness: COMPLETE, rows: [{}] };
  });
  const { service } = createService({ provider });
  const args = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  const first = service.refresh(args);
  const second = service.refresh(args);
  assert.equal(service.inFlightCount(), 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.status, "refreshed");
  assert.strictEqual(a, b);
  assert.equal(service.inFlightCount(), 0);
});

test("refresh lock is cleaned up after failure and a later request can retry", async () => {
  let calls = 0;
  const provider = makeFakeProvider(async () => {
    calls += 1;
    if (calls === 1) throw new Error("first failure");
    return { fetchedAt: NOW.toISOString(), completeness: COMPLETE, rows: [{}] };
  });
  const { service } = createService({ provider });
  const args = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  assert.equal((await service.refresh(args)).status, "failed");
  assert.equal(service.inFlightCount(), 0);
  assert.equal((await service.refresh(args)).status, "refreshed");
  assert.equal(calls, 2);
});

test("invalid normalized data is diagnosed and never replaces a complete snapshot", async () => {
  const repository = new InMemoryOddsRepository();
  let invalid = false;
  const provider = makeFakeProvider(async () => ({
    fetchedAt: NOW.toISOString(),
    completeness: COMPLETE,
    rows: [{}],
  }), normalizedResult());
  const originalNormalize = provider.normalizePlayerProps;
  provider.normalizePlayerProps = () => invalid
    ? { events: [], quotes: [] }
    : originalNormalize();
  const { service } = createService({ repository, provider });
  const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  await service.refresh(key);
  invalid = true;
  const result = await service.refresh(key);
  assert.equal(result.status, "incomplete");
  assert.equal(result.cache.quotes.length, 1);
  assert.equal(result.diagnostic.error, "Normalized odds payload failed validation");
});

test("repository rejects a nominal COMPLETE write whose pagination flags contradict completeness", async () => {
  const repository = new InMemoryOddsRepository();
  const key = { provider: "parlay", season: 2026, week: 7, resource: "props" };
  const goodSnapshot = {
    provider: "parlay",
    season: 2026,
    week: 7,
    resource: "props",
    events: normalizedResult().events,
    quotes: normalizedResult().quotes,
    fetchedAt: NOW.toISOString(),
  };
  await repository.writeRefreshResult(key, {
    snapshot: goodSnapshot,
    completeness: COMPLETE,
    validated: true,
    attemptedAt: NOW.toISOString(),
  });
  await repository.writeRefreshResult(key, {
    snapshot: { ...goodSnapshot, fetchedAt: new Date(NOW.getTime() + 1000).toISOString() },
    completeness: { ...COMPLETE, hasMore: true },
    validated: true,
    attemptedAt: new Date(NOW.getTime() + 1000).toISOString(),
  });
  assert.equal((await repository.readSnapshot(key)).fetchedAt, NOW.toISOString());
  assert.equal((await repository.readDiagnostic(key)).status, "UNKNOWN");
});
