import { quoteSnapshotKey } from "./contracts.js";
import { isCompleteResponse } from "./completeness.js";

export class InMemoryOddsRepository {
  #snapshots = new Map();
  #diagnostics = new Map();
  #ledger = [];

  async readSnapshot(key) {
    return clone(this.#snapshots.get(snapshotKey(key)) || null);
  }

  async writeRefreshResult(key, result) {
    const id = snapshotKey(key);
    const complete = isCompleteResponse(result.completeness);
    if (complete && result.validated === true) {
      this.#snapshots.set(id, clone(result.snapshot));
    }
    this.#diagnostics.set(id, clone({
      provider: key.provider,
      season: key.season,
      week: key.week,
      resource: key.resource,
      status: complete ? "COMPLETE" :
        result.completeness?.status === "COMPLETE" ? "UNKNOWN" :
          result.completeness?.status || "UNKNOWN",
      error: result.error || null,
      attemptedAt: result.attemptedAt,
      pageCount: result.pageCount ?? null,
      pageMetadata: clone(result.pageMetadata || null),
      requestId: result.requestId || null,
      budgetBlocked: result.budgetBlocked === true,
    }));
    return this.readSnapshot(key);
  }

  async readDiagnostic(key) {
    return clone(this.#diagnostics.get(snapshotKey(key)) || null);
  }

  async readCache(key, { now = new Date(), maxAgeMs = Infinity } = {}) {
    const snapshot = await this.readSnapshot(key);
    if (!snapshot) return { snapshot: null, status: "missing", stale: true };
    const ageMs = now.getTime() - Date.parse(snapshot.fetchedAt);
    const validAge = Number.isFinite(ageMs) && ageMs >= 0;
    return {
      snapshot,
      status: validAge && ageMs <= maxAgeMs ? "fresh" : "stale",
      stale: !validAge || ageMs > maxAgeMs,
      ageMs: validAge ? ageMs : null,
      diagnostic: await this.readDiagnostic(key),
    };
  }

  async appendCreditEntry(entry) {
    this.#ledger.push(clone(entry));
  }

  async readCreditLedger({ provider = "parlay", since = "0000-01" } = {}) {
    return clone(this.#ledger.filter((entry) =>
      entry.provider === provider && entry.timestamp.slice(0, 7) >= since
    ));
  }

  async readQuotes(key, options) {
    const cache = await this.readCache(key, options);
    return { ...cache, quotes: cache.snapshot?.quotes || [] };
  }
}

export function deduplicateQuotes(quotes) {
  const unique = new Map();
  for (const quote of quotes || []) {
    unique.set(quoteSnapshotKey(quote), quote);
  }
  return [...unique.values()];
}

function snapshotKey(key) {
  return [key.provider, key.season, key.week, key.resource]
    .map((part) => encodeURIComponent(String(part))).join("|");
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}
