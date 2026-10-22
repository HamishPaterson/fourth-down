import { COMPLETENESS } from "./contracts.js";

export function assessCompleteness(headers = {}) {
  const values = normalizeHeaders(headers);
  const hasMore = parseBoolean(values["x-result-has-more"]);
  const truncated = parseBoolean(values["x-result-truncated"]);
  const degraded = parseBoolean(values["x-result-degraded"]);

  if (degraded === true) return { status: COMPLETENESS.SOURCE_DEGRADED, hasMore, truncated, degraded };
  if (truncated === true) return { status: COMPLETENESS.SOURCE_TRUNCATED, hasMore, truncated, degraded };
  if (hasMore === true) return { status: COMPLETENESS.MORE_PAGES_AVAILABLE, hasMore, truncated, degraded };
  if (hasMore === false && truncated === false && degraded === false) {
    return { status: COMPLETENESS.COMPLETE, hasMore, truncated, degraded };
  }
  return { status: COMPLETENESS.UNKNOWN, hasMore, truncated, degraded };
}

export function isCompleteResponse(completeness) {
  return completeness?.status === COMPLETENESS.COMPLETE &&
    completeness.hasMore === false &&
    completeness.truncated === false &&
    completeness.degraded === false;
}

function normalizeHeaders(headers) {
  if (headers && typeof headers.entries === "function") {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
}

function parseBoolean(value) {
  if (value === true || String(value).toLowerCase() === "true") return true;
  if (value === false || String(value).toLowerCase() === "false") return false;
  return null;
}
