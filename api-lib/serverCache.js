// In-memory cache shared by every request a server instance handles. Signed-in responses are
// private (no CDN caching), so without this every page view called the schedule provider,
// whose 5-calls-a-minute allowance is shared with the scheduled jobs.
// - Answers are kept for ttlMs (or ttlMs(answer), so a finished game can be kept longer than a
//   live one); concurrent requests for the same key share one call.
// - Failures are never kept, so the next request tries again.
// - Each access check still runs per request: only the provider's data is shared.
const MAX_ENTRIES = 500;

export function createServerCache({ now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
  const entries = new Map(), inFlight = new Map();
  let calls = 0;
  async function cached(key, ttlMs, load) {
    const hit = entries.get(key);
    const ttl = (value) => (typeof ttlMs === "function" ? ttlMs(value) : ttlMs);
    if (hit && now() - hit.at < ttl(hit.value)) return hit.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const request = (async () => {
      calls += 1;
      const value = await load();
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    })();
    inFlight.set(key, request);
    try { return await request; } finally { inFlight.delete(key); }
  }
  cached.calls = () => calls;
  cached.clear = () => { entries.clear(); inFlight.clear(); calls = 0; };
  return cached;
}

export const providerCache = createServerCache();

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
