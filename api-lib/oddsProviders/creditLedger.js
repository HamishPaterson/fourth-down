import process from "node:process";

export const PARLAY_PROPS_PAGE_CREDITS = 3;

export function estimateProviderCredits({ provider, endpoint, markets = [], regions = [] }) {
  if (provider === "parlay" && endpoint === "props") return PARLAY_PROPS_PAGE_CREDITS;
  if (provider === "parlay" && endpoint === "odds") {
    return Math.max(1, new Set(markets).size * new Set(regions).size);
  }
  if (provider === "parlay" && endpoint === "events") return 0;
  return null;
}

export function readCreditConfiguration(env = process.env) {
  return {
    monthlyLimit: readNonNegativeInteger(env.PARLAY_MONTHLY_CREDIT_LIMIT),
    automaticBudget: readNonNegativeInteger(env.PARLAY_AUTOMATIC_CREDIT_BUDGET),
  };
}

export function canSpendCredits({
  ledger = [],
  expectedCredits,
  automatic,
  configuration = readCreditConfiguration(),
  now = new Date(),
}) {
  if (!Number.isInteger(expectedCredits) || expectedCredits < 0) {
    return { allowed: false, reason: "invalid_expected_credit_cost" };
  }
  const period = now.toISOString().slice(0, 7);
  const monthlyUsed = ledger
    .filter((entry) => entry.provider === "parlay" &&
      String(entry.timestamp || "").slice(0, 7) === period)
    .reduce((total, entry) => total + Number(entry.budgetCredits ?? entry.actualCredits ?? 0), 0);
  if (monthlyUsed + expectedCredits > configuration.monthlyLimit) {
    return { allowed: false, reason: "monthly_limit_exhausted", monthlyUsed, period };
  }
  if (automatic) {
    const automaticUsed = ledger
      .filter((entry) => entry.provider === "parlay" && entry.automatic === true &&
        String(entry.timestamp || "").slice(0, 7) === period)
      .reduce((total, entry) => total + Number(entry.budgetCredits ?? entry.actualCredits ?? 0), 0);
    if (automaticUsed + expectedCredits > configuration.automaticBudget) {
      return { allowed: false, reason: "automatic_budget_exhausted", automaticUsed, period };
    }
    return { allowed: true, monthlyUsed, automaticUsed, period };
  }
  return { allowed: true, monthlyUsed, period };
}

export function createCreditLedgerEntry({
  provider = "parlay",
  timestamp = new Date().toISOString(),
  endpoint,
  season,
  week,
  reason,
  automatic,
  expectedCredits,
  actualCredits = null,
  budgetCredits = null,
  success,
  monthlyRunningTotal,
}) {
  return {
    provider,
    timestamp: new Date(timestamp).toISOString(),
    endpoint,
    season: Number(season),
    week: Number(week),
    reason: String(reason || "unspecified"),
    automatic: automatic === true,
    expectedCredits,
    actualCredits,
    budgetCredits,
    success: success === true,
    monthlyRunningTotal: Number(monthlyRunningTotal ?? 0),
  };
}

function readNonNegativeInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Parlay credit configuration must be a non-negative integer");
  }
  return parsed;
}
