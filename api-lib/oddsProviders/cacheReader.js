export function createOddsCacheReader({ repository, now = () => new Date(), maxAgeMs = 5400000 }) {
  if (!repository || typeof repository.readCache !== "function") {
    throw new Error("Cache reader requires a repository, not a provider");
  }
  return {
    async read({ provider, season, week, resource, eventId, market, playerId, playerName }) {
      const cache = await repository.readCache({ provider, season, week, resource }, { now: now(), maxAgeMs });
      const quotes = (cache.snapshot?.quotes || []).filter((quote) =>
        (!eventId || quote.providerEventId === eventId) &&
        (!market || quote.market === market) &&
        (!playerId || quote.playerId === playerId) &&
        (!playerName || quote.playerName === playerName)
      ).map((quote) => {
        const elapsed = Math.max(0, (now().getTime() - Date.parse(quote.fetchedAt)) / 1000);
        const ageSeconds = quote.ageSeconds === null ? null : quote.ageSeconds + elapsed;
        return {
          ...structuredClone(quote), ageSeconds, snapshotGeneration: cache.generation,
          freshnessStatus: cache.stale || (ageSeconds !== null && ageSeconds * 1000 > maxAgeMs)
            ? "stale" : ageSeconds === null ? "unknown" : "fresh",
          cacheStatus: cache.status, stale: cache.stale, cacheFetchedAt: cache.snapshot.fetchedAt,
        };
      });
      return { ...cache, quotes };
    },
  };
}
