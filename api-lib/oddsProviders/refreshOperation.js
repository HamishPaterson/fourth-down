import process from "node:process";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createPersistentOddsRepository } from "./supabaseRepository.js";
import { createPersistentRefreshService, planProviderRefresh } from "./persistentRefresh.js";
import { createParlayProvider } from "./parlay.js";
import { REFRESH_REASON_CODES } from "./contracts.js";

// Server operation only; intentionally not registered as an API route or cron.
export function createProviderRefreshOperation({
  contextLoader,
  repositoryFactory = createPersistentOddsRepository,
  providerFactory = createParlayProvider,
  secret = () => process.env.CRON_SECRET,
} = {}) {
  return async function refreshOperation({ authorization, method, body }) {
    if (method !== "POST") return { status: 405, error: "Method not allowed" };
    const configured = secret();
    if (!configured) return { status: 503, error: "Refresh authorization is not configured" };
    const expected = Buffer.from(`Bearer ${configured}`);
    const supplied = Buffer.from(String(authorization || ""));
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return { status: 401, error: "Unauthorized" };
    }
    if (!contextLoader) return { status: 503, error: "Authoritative refresh context loader is not configured" };
    const { season, week, resource, mode, maxPages = 1, automatic = true, reason } = body || {};
    if (!Number.isInteger(season) || season < 1900 || !Number.isInteger(week) || week < 1 || week > 18 ||
      !["core", "props"].includes(resource) || !["dry-run", "persist", "plan"].includes(mode) ||
      typeof automatic !== "boolean" || !REFRESH_REASON_CODES.includes(reason) ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) {
      return { status: 400, error: "Invalid explicit provider refresh options" };
    }
    const plan = planProviderRefresh({ resource, maxPages });
    if (mode === "plan") return { status: 200, plan, providerCalls: 0, writes: 0 };
    const key = { provider: "parlay", season, week, resource };
    const context = await contextLoader(key, { dryRun: mode === "dry-run" });
    const service = createPersistentRefreshService({
      repository: mode === "dry-run" ? null : repositoryFactory(),
      providerFactory,
    });
    const result = await service.refresh({
      key, events: context.events, players: context.players, maxPages, automatic, reason,
      dryRun: mode === "dry-run", fixture: mode === "dry-run" ? context.fixture : undefined,
    });
    return { status: result.status === "failed" ? 502 : 200, result };
  };
}
