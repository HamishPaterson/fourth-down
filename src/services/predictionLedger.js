import {
  fetchSharedPredictionLedger,
  gradeSharedPredictions,
  saveSharedPredictionSnapshots,
} from "./sharedPredictionLedger.js";

const LEDGER_KEY = "fourth-down:prediction-ledger:v3-shared-only";
export const CURRENT_MODEL_VERSION = 12;
export const CURRENT_MODEL_KEY = "full-v12-data-only-predictions";
const WEEK_ONE_BACKFILL = [
  result("2026-W1-SEA-NE", "SEA", "NE", 13, 10, "SEA"),
  result("2026-W1-LAR-SF", "LAR", "SF", 7, 27, "LAR"),
  result("2026-W1-DET-NO", "DET", "NO", 31, 30, "DET"),
  result("2026-W1-CIN-TB", "CIN", "TB", 33, 27, "CIN"),
  result("2026-W1-IND-BAL", "IND", "BAL", 23, 41, "BAL"),
  result("2026-W1-JAX-CLE", "JAX", "CLE", 34, 10, "JAX"),
  result("2026-W1-TEN-NYJ", "TEN", "NYJ", 10, 23, "TEN"),
  result("2026-W1-HOU-BUF", "HOU", "BUF", 31, 36, "BUF"),
  result("2026-W1-PIT-ATL", "PIT", "ATL", 20, 13, "PIT"),
  result("2026-W1-CAR-CHI", "CAR", "CHI", 37, 59, "CHI"),
  result("2026-W1-MIN-GB", "MIN", "GB", 39, 22, "MIN"),
  result("2026-W1-LV-MIA", "LV", "MIA", 27, 13, "LV"),
  result("2026-W1-LAC-ARI", "LAC", "ARI", 14, 26, "LAC"),
  result("2026-W1-PHI-WSH", "PHI", "WSH", 24, 22, "PHI"),
  result("2026-W1-NYG-DAL", "NYG", "DAL", 28, 20, "DAL"),
  result("2026-W1-DEN-KC", "DEN", "KC", 17, 23, "KC"),
];

const VERIFIED_WEEK_TWO_FINALS = [
  { id: "2026-W2-NO-BAL", season: 2026, week: 2, kickoff: "2026-09-20T17:00:00.000Z", awayCode: "NO", homeCode: "BAL", actualAwayScore: 24, actualHomeScore: 17, actualWinner: "NO", savedBeforeKickoff: true, gradedAt: "2026-09-20T20:00:00.000Z", resultSource: "verified-final-backfill" },
  { id: "2026-W2-NYG-LAR", season: 2026, week: 2, kickoff: "2026-09-22T00:15:00.000Z", awayCode: "NYG", homeCode: "LAR", actualAwayScore: 6, actualHomeScore: 28, actualWinner: "LAR", savedBeforeKickoff: true, gradedAt: "2026-09-22T03:31:00.000Z", resultSource: "verified-final-backfill" },
];

export async function refreshPredictionLedger(options = {}) {
  if (typeof window === "undefined") return [];
  const sharedRows = dedupeRows(
    (await fetchSharedPredictionLedger(options)).map((row) => ({ ...row, shared: true }))
  );
  if (!sharedRows.length) return readPredictionLedger();
  writeStoredRows(sharedRows, { dispatch: false });
  window.dispatchEvent(new Event("fourth-down-ledger-updated"));
  return sharedRows;
}

export async function migrateLocalPredictionLedger() {
  if (typeof window === "undefined") return [];

  const localRows = readPredictionLedger();
  if (!localRows.length) return [];

  const saved = await saveSharedPredictionSnapshots(localRows);
  const merged = mergeLedgerCollections(localRows, saved);
  writeStoredRows(merged, { dispatch: false });
  window.localStorage.setItem(
    "fourth-down:shared-ledger-migrated:v1",
    new Date().toISOString()
  );
  window.dispatchEvent(new Event("fourth-down-ledger-updated"));
  return saved;
}

export function hasMigratedSharedLedger() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.localStorage.getItem("fourth-down:shared-ledger-migrated:v1")
  );
}

export function readPredictionLedger() {
  const merged = new Map();

  for (const row of readStoredRows()) {
    mergeRow(merged, row);
  }

  for (const row of WEEK_ONE_BACKFILL) mergeRow(merged, row);
  for (const row of VERIFIED_WEEK_TWO_FINALS) mergeVerifiedFinal(merged, row);


  return [...merged.values()].sort((first, second) => {
    const weekDifference = (Number(first.week) || 0) - (Number(second.week) || 0);
    if (weekDifference !== 0) return weekDifference;
    return new Date(first.kickoff || 0) - new Date(second.kickoff || 0);
  });
}

export function isCurrentCompletePrediction(row) {
  const modelVersion = row?.modelVersion ?? row?.dataQuality?.modelVersion;
  const modelKey = row?.modelKey ?? row?.dataQuality?.modelKey;
  const predictionPayload = row?.predictionPayload ?? row?.dataQuality?.predictionPayload;

  // Prediction identity must not depend on odds or Best Bets availability.
  // Otherwise two devices can recalculate the same matchup from different
  // market responses and overwrite the shared team scores.
  return Boolean(
    row &&
    Number(modelVersion) === CURRENT_MODEL_VERSION &&
    modelKey === CURRENT_MODEL_KEY &&
    row.fourthDownPick &&
    hasNumber(row.fourthDownAwayScore) &&
    hasNumber(row.fourthDownHomeScore) &&
    hasNumber(row.fourthDownAwayWinProbability) &&
    hasNumber(row.fourthDownHomeWinProbability) &&
    predictionPayload &&
    row.dataQuality
  );
}

export function getPredictionPayload(row) {
  return row?.predictionPayload ?? row?.dataQuality?.predictionPayload ?? null;
}

export function findPredictionSnapshot(rows, week, awayCode, homeCode) {
  const requestedAway = normaliseTeam(awayCode);
  const requestedHome = normaliseTeam(homeCode);
  const key = ledgerMatchupKey({ season: 2026, week, awayCode: requestedAway, homeCode: requestedHome });
  const snapshot = (rows || []).find((row) => ledgerMatchupKey(row) === key) || null;
  return snapshot ? orientSnapshotToMatchup(snapshot, requestedAway, requestedHome) : null;
}

function orientSnapshotToMatchup(snapshot, requestedAway, requestedHome) {
  const storedAway = normaliseTeam(snapshot?.awayCode);
  const storedHome = normaliseTeam(snapshot?.homeCode);

  if (storedAway === requestedAway && storedHome === requestedHome) {
    return snapshot;
  }

  if (storedAway !== requestedHome || storedHome !== requestedAway) {
    return snapshot;
  }

  const predictionPayload = swapPredictionPayload(snapshot.predictionPayload ?? snapshot?.dataQuality?.predictionPayload);
  const dataQuality = snapshot?.dataQuality
    ? {
        ...snapshot.dataQuality,
        predictionPayload: snapshot.dataQuality.predictionPayload
          ? swapPredictionPayload(snapshot.dataQuality.predictionPayload)
          : snapshot.dataQuality.predictionPayload,
      }
    : snapshot?.dataQuality;

  return {
    ...snapshot,
    awayCode: requestedAway,
    homeCode: requestedHome,
    fourthDownAwayScore: snapshot.fourthDownHomeScore,
    fourthDownHomeScore: snapshot.fourthDownAwayScore,
    fourthDownAwayWinProbability: snapshot.fourthDownHomeWinProbability,
    fourthDownHomeWinProbability: snapshot.fourthDownAwayWinProbability,
    actualAwayScore: snapshot.actualHomeScore,
    actualHomeScore: snapshot.actualAwayScore,
    predictionPayload,
    dataQuality,
  };
}

function swapPredictionPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...payload,
    away: payload.home,
    home: payload.away,
    awayCode: payload.homeCode ?? payload.home?.code,
    homeCode: payload.awayCode ?? payload.away?.code,
    awayWinProbability: payload.homeWinProbability,
    homeWinProbability: payload.awayWinProbability,
  };
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function dedupeRows(rows) {
  const merged = new Map();
  for (const row of rows || []) mergeRow(merged, row);
  return [...merged.values()];
}

export function savePredictionSnapshot(snapshot) {
  if (!snapshot || typeof window === "undefined") return;

  const normalised = normaliseSnapshot(snapshot);
  if (!normalised.id || !normalised.awayCode || !normalised.homeCode) return;

  const rows = readStoredRows();

  const snapshotKey = ledgerMatchupKey(normalised);
  const index = rows.findIndex(
    (row) =>
      String(row.id || "") === String(normalised.id) ||
      ledgerMatchupKey(row) === snapshotKey
  );

  const existing = index >= 0 ? rows[index] : null;
  const existingIsFinal = hasFinalResult(existing);

  const existingHasPrediction = Boolean(
    existing &&
    hasNumber(existing.fourthDownAwayScore) &&
    hasNumber(existing.fourthDownHomeScore) &&
    hasNumber(existing.fourthDownAwayWinProbability) &&
    hasNumber(existing.fourthDownHomeWinProbability) &&
    existing.fourthDownPick
  );

  const next = existingIsFinal
    ? { ...normalised, ...existing }
    : {
        ...existing,
        ...normalised,
        ...(existingHasPrediction
          ? {
              fourthDownPick: existing.fourthDownPick,
              fourthDownAwayScore: existing.fourthDownAwayScore,
              fourthDownHomeScore: existing.fourthDownHomeScore,
              fourthDownAwayWinProbability: existing.fourthDownAwayWinProbability,
              fourthDownHomeWinProbability: existing.fourthDownHomeWinProbability,
              fourthDownWinnerProbability: existing.fourthDownWinnerProbability,
              projectedTie: existing.projectedTie,
              continuousMargin: existing.continuousMargin,
              confidenceScore: existing.confidenceScore,
              confidenceLabel: existing.confidenceLabel,
              predictionPayload: existing.predictionPayload,
              modelVersion: existing.modelVersion,
              modelKey: existing.modelKey,
              snapshotAt: existing.snapshotAt,
            }
          : {}),
        actualAwayScore: existing?.actualAwayScore ?? null,
        actualHomeScore: existing?.actualHomeScore ?? null,
        actualWinner: existing?.actualWinner ?? null,
        fourthDownCorrect: existing?.fourthDownCorrect ?? null,
        oddsCorrect: existing?.oddsCorrect ?? null,
        gradedAt: existing?.gradedAt ?? null,
        snapshotAt: existing?.snapshotAt || normalised.snapshotAt || new Date().toISOString(),
      };

  if (index >= 0) rows[index] = next;
  else rows.push(next);

  writeStoredRows(rows);
  persistSnapshots([next]);
}

export async function saveAuthoritativePredictionSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof window === "undefined") return snapshot || null;

  const normalised = normaliseSnapshot(snapshot);
  await saveSharedPredictionSnapshots([normalised], options);

  const sharedRows = dedupeRows(
    (await fetchSharedPredictionLedger({
      season: normalised.season,
      week: normalised.week,
      signal: options.signal,
    })).map((row) => ({ ...row, shared: true }))
  );

  if (sharedRows.length) {
    writeStoredRows(sharedRows, { dispatch: false });
    window.dispatchEvent(new Event("fourth-down-ledger-updated"));
  }

  return findPredictionSnapshot(
    sharedRows,
    normalised.week,
    normalised.awayCode,
    normalised.homeCode
  ) || normalised;
}

export function saveGradedPrediction(row) {
  if (!row || typeof window === "undefined") return;

  const rows = readStoredRows();
  const key = ledgerMatchupKey(row);
  const index = rows.findIndex(
    (existing) =>
      String(existing.id || "") === String(row.id || "") ||
      ledgerMatchupKey(existing) === key
  );

  const next = {
    ...(index >= 0 ? rows[index] : {}),
    ...row,
    awayCode: normaliseTeam(row.awayCode),
    homeCode: normaliseTeam(row.homeCode),
    gradedAt: row.gradedAt || new Date().toISOString(),
  };

  if (index >= 0) rows[index] = next;
  else rows.push(next);

  writeStoredRows(rows);
}

export function saveGradedPredictions(rows) {
  if (!Array.isArray(rows) || typeof window === "undefined") return;

  const stored = readStoredRows();
  const merged = new Map();
  for (const row of stored) mergeRow(merged, row);
  for (const row of rows) mergeRow(merged, row);

  writeStoredRows([...merged.values()]);
}

function mergeLedgerCollections(firstRows, secondRows) {
  const merged = new Map();
  for (const row of firstRows || []) mergeRow(merged, row);
  for (const row of secondRows || []) mergeRow(merged, row);
  return [...merged.values()];
}

function persistSnapshots(rows) {
  if (typeof window === "undefined" || !rows?.length) return;
  saveSharedPredictionSnapshots(rows)
    .then((saved) => {
      if (!saved.length) return;
      const merged = mergeLedgerCollections(readStoredRows(), saved);
      writeStoredRows(merged, { dispatch: false });
      window.dispatchEvent(new Event("fourth-down-ledger-updated"));
    })
    .catch((error) => {
      console.warn("Shared prediction save failed; local ledger retained", error);
    });
}

function persistGradedRows(rows) {
  if (typeof window === "undefined" || !rows?.length) return;
  const graded = rows.filter((row) => hasFinalResult(row));
  if (!graded.length) return;

  Promise.allSettled([
    saveSharedPredictionSnapshots(graded),
    gradeSharedPredictions(graded),
  ]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      console.warn("Shared grading partially failed; local results retained", failed.reason);
    }
  });
}

function mergeVerifiedFinal(map, finalResult) {
  const teams = new Set([normaliseTeam(finalResult.awayCode), normaliseTeam(finalResult.homeCode)]);
  const found = [...map.entries()].find(([, row]) => Number(row.week) === 2 && teams.has(normaliseTeam(row.awayCode)) && teams.has(normaliseTeam(row.homeCode)));
  const existing = found?.[1] || null;
  const oldKey = found?.[0];
  const awayCode = normaliseTeam(existing?.awayCode || finalResult.awayCode);
  const homeCode = normaliseTeam(existing?.homeCode || finalResult.homeCode);
  const winner = normaliseTeam(finalResult.actualWinner);
  const row = normaliseSnapshot({ ...finalResult, ...existing, id: existing?.id || finalResult.id, awayCode, homeCode, savedBeforeKickoff: true, actualAwayScore: awayCode === normaliseTeam(finalResult.awayCode) ? finalResult.actualAwayScore : finalResult.actualHomeScore, actualHomeScore: homeCode === normaliseTeam(finalResult.homeCode) ? finalResult.actualHomeScore : finalResult.actualAwayScore, actualWinner: winner, fourthDownCorrect: existing?.fourthDownPick ? normaliseTeam(existing.fourthDownPick) === winner : null, oddsCorrect: existing?.oddsPick ? normaliseTeam(existing.oddsPick) === winner : null, gradedAt: finalResult.gradedAt, resultSource: finalResult.resultSource });
  if (oldKey) map.delete(oldKey);
  map.set(ledgerMatchupKey(row), row);
}

function mergeRow(map, incoming) {
  if (!incoming) return;

  const row = normaliseSnapshot(incoming);
  const key = ledgerMatchupKey(row);
  const existing = map.get(key);

  if (!existing) {
    map.set(key, row);
    return;
  }

  const existingFinal = hasFinalResult(existing);
  const incomingFinal = hasFinalResult(row);

  // A Supabase row is the authoritative official prediction. Local device
  // calculations must never replace it, even when the local snapshot has a
  // newer timestamp.
  if (row.shared === true && existing.shared !== true) {
    map.set(key, { ...existing, ...row });
    return;
  }

  if (existing.shared === true && row.shared !== true) {
    map.set(key, { ...row, ...existing });
    return;
  }

  if (incomingFinal && !existingFinal) {
    map.set(key, { ...existing, ...row });
    return;
  }

  if (existingFinal && !incomingFinal) {
    map.set(key, { ...row, ...existing });
    return;
  }

  const existingTime = new Date(existing.snapshotAt || 0).getTime() || 0;
  const incomingTime = new Date(row.snapshotAt || 0).getTime() || 0;
  map.set(key, incomingTime >= existingTime ? { ...existing, ...row } : { ...row, ...existing });
}

function normaliseSnapshot(snapshot) {
  const kickoff = snapshot.kickoff || snapshot.date || snapshot.datetime || null;
  const season = getSeason(snapshot, kickoff);

  return {
    ...snapshot,
    id:
      snapshot.id ||
      `${season}-W${Number(snapshot.week) || 0}-${normaliseTeam(snapshot.awayCode)}-${normaliseTeam(snapshot.homeCode)}`,
    season,
    week: Number(snapshot.week) || 0,
    kickoff,
    awayCode: normaliseTeam(snapshot.awayCode),
    homeCode: normaliseTeam(snapshot.homeCode),
  };
}

function getSeason(row, kickoff) {
  const explicit = Number(row?.season);
  if (Number.isInteger(explicit) && explicit > 2000) return explicit;

  const date = new Date(kickoff || 0);
  return Number.isNaN(date.getTime()) ? 2026 : date.getUTCFullYear();
}

function ledgerMatchupKey(row) {
  const teams = [
    normaliseTeam(row?.awayCode),
    normaliseTeam(row?.homeCode),
  ].sort();

  return [
    getSeason(
      row,
      row?.kickoff
    ),
    Number(row?.week) || 0,
    teams[0],
    teams[1],
  ].join(":");
}

function hasFinalResult(row) {
  return Boolean(
    row?.actualWinner &&
      Number.isFinite(Number(row.actualAwayScore)) &&
      Number.isFinite(Number(row.actualHomeScore))
  );
}

function normaliseTeam(value) {
  const code = String(value || "").trim().toUpperCase();
  return (
    {
      WAS: "WSH",
      LA: "LAR",
      OAK: "LV",
      SD: "LAC",
      STL: "LAR",
    }[code] || code
  );
}

function readStoredRows() {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeStoredRows(rows, options = {}) {
  try {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(rows));
    if (options.dispatch !== false) {
      window.dispatchEvent(new Event("fourth-down-ledger-updated"));
    }
  } catch {
    // Preserve the existing in-memory view when browser storage is unavailable.
  }
}

function result(id, awayCode, homeCode, actualAwayScore, actualHomeScore, pick) {
  const actualWinner = actualAwayScore > actualHomeScore ? awayCode : homeCode;

  return {
    id,
    season: 2026,
    week: 1,
    kickoff: "2026-09-15T00:00:00.000Z",
    awayCode,
    homeCode,
    fourthDownPick: pick,
    oddsPick: pick,
    actualAwayScore,
    actualHomeScore,
    actualWinner,
    fourthDownCorrect: pick === actualWinner,
    oddsCorrect: pick === actualWinner,
    savedBeforeKickoff: true,
    snapshotAt: "2026-09-14T00:00:00.000Z",
    gradedAt: "2026-09-15T00:00:00.000Z",
    backfilled: true,
  };
}
