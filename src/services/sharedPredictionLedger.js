const ENDPOINT = "/api/nfl/game-stats?action=predictions";
const GRADE_ENDPOINT = "/api/nfl/game-stats?action=predictions&mode=grade";

export async function fetchSharedPredictionLedger(options = {}) {
  const params = new URLSearchParams();
  if (options.season) params.set("season", String(options.season));
  if (options.week) params.set("week", String(options.week));

  const response = await fetch(
    params.size ? `${ENDPOINT}?${params.toString()}` : ENDPOINT,
    {
      signal: options.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    }
  );
  const body = await readJson(response);

  if (!response.ok) {
    throw new Error(body?.error || `Shared ledger request failed (${response.status})`);
  }

  return Array.isArray(body?.snapshots) ? body.snapshots : [];
}

export async function saveSharedPredictionSnapshots(snapshots, options = {}) {
  const rows = Array.isArray(snapshots) ? snapshots : [snapshots];
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal: options.signal,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ snapshots: rows }),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw new Error(body?.error || `Shared ledger save failed (${response.status})`);
  }

  return Array.isArray(body?.saved) ? body.saved : [];
}

export async function gradeSharedPredictions(results, options = {}) {
  const rows = Array.isArray(results) ? results : [results];
  const response = await fetch(GRADE_ENDPOINT, {
    method: "POST",
    signal: options.signal,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ results: rows }),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw new Error(body?.error || `Shared grading failed (${response.status})`);
  }

  return body;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Shared ledger returned invalid JSON");
  }
}
