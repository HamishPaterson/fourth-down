import { useEffect, useMemo, useState } from "react";
import { isValidCompletedResult, normalizeResultTeam as normalizeTeamCode } from "../services/gameResults.js";
import {
  hasMigratedSharedLedger,
  migrateLocalPredictionLedger,
  readPredictionLedger,
  refreshPredictionLedger,
} from "../services/predictionLedger.js";
import FourthDownLoader from "../components/FourthDownLoader.jsx";
import { PickRow, groupByDay } from "./Predictions.jsx";
import { shouldShowBlockingLoader } from "../components/fourthDownLoader.js";

const CURRENT_SCORING_MODEL_START_WEEK = 2;

export default function Results() {
  const [rows, setRows] = useState(() => readPredictionLedger());
  const [week, setWeek] = useState("all");
  const [expandedResult, setExpandedResult] = useState(null);
  const [syncStatus, setSyncStatus] = useState("Loading results...");
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();

    const syncResults = async () => {
      controller.abort();
      controller = new AbortController();

      let authoritativeRows = readPredictionLedger();
      let authoritativeLoaded = false;
      setSyncStatus("Loading results...");

      try {
        if (!hasMigratedSharedLedger()) {
          await migrateLocalPredictionLedger();
        }

        const sharedRows = await refreshPredictionLedger({
          signal: controller.signal,
          resultsView: true,
        });

        if (sharedRows.length) {
          authoritativeRows = sharedRows;
          authoritativeLoaded = true;
        }
      } catch (sharedError) {
        if (sharedError?.name === "AbortError" || cancelled) return;
        console.warn(
          "Shared ledger unavailable; using the offline browser cache",
          sharedError
        );
      }

      if (cancelled) return;

      // Supabase replaces the local ledger. It is never merged with legacy rows.
      setRows(authoritativeRows);

      if (!authoritativeRows.length) {
        setSyncStatus("No saved predictions to grade");
        setInitialLoading(false);
        return;
      }

      try {
        const canonicalRows = mergeResultRows([], authoritativeRows);
        setRows(canonicalRows);

        const count = canonicalRows.filter(isValidCompletedResult).length;
        setSyncStatus(
          `Results updated · ${count} graded game${count === 1 ? "" : "s"}`
        );
        setInitialLoading(false);
      } catch (error) {
        if (!cancelled && error?.name !== "AbortError") {
          console.error("Results sync failed", error);
          setSyncStatus("Could not refresh final scores");
          setInitialLoading(false);
        }
      }
    };

    const refresh = () => syncResults();
    syncResults();
    const interval = window.setInterval(syncResults, 60000);
    window.addEventListener("focus", refresh);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const completed = useMemo(
    () => rows.filter(isValidCompletedResult),
    [rows]
  );

  const weeks = useMemo(
    () => [...new Set(completed.map((row) => Number(row.week)).filter(Number.isFinite))].sort((a, b) => a - b),
    [completed]
  );

  const filtered = week === "all"
    ? completed
    : completed.filter((row) => Number(row.week) === Number(week));

  const weekOneHistorical = Number(week) === 1;

  const fourthDown = calculateRecord(filtered, "fourthDownCorrect", "fourthDownPick");
  const odds = calculateRecord(filtered, "oddsCorrect", "oddsPick");
  const currentModelScoreRows = filtered.filter(
    (row) => Number(row.week) >= CURRENT_SCORING_MODEL_START_WEEK
  );
  const scoring = calculateScoringAccuracy(currentModelScoreRows);
  const marketScoring = calculateMarketScoringAccuracy(currentModelScoreRows);
  const weeklyBreakdown = calculateWeeklyBreakdown(completed);

  if (shouldShowBlockingLoader({
    loading: initialLoading,
    hasContent: completed.length > 0,
    error: syncStatus.startsWith("Could not"),
  })) {
    return <FourthDownLoader />;
  }

  return (
    <section className="results-page">
      <div className="section-heading results-heading">
        <div>
          <span className="eyebrow">PREDICTION TRACKER</span>
          <h1>Results</h1>
          <p>See how Fourth Down performed against the market.</p>
          <small className="results-sync-status">{syncStatus}</small>
        </div>

        <label className="results-week-filter">
          Week
          <select value={week} onChange={(event) => setWeek(event.target.value)}>
            <option value="all">All graded games</option>
            {weeks.map((value) => (
              <option key={value} value={value}>Week {value}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="results-summary-grid">
        <SummaryCard title="Fourth Down win rate" record={fourthDown} tone="fourth-down" />
        <SummaryCard title="Odds makers win rate" record={odds} tone="market" />
        <div className="card results-summary-card results-summary-lead">
          <small>Accuracy difference</small>
          <strong>{formatLead(fourthDown.percentage, odds.percentage)}</strong>
          <span>{filtered.length} graded game{filtered.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="results-summary-grid">
        <CalibrationCard
          label="Average margin error"
          value={weekOneHistorical ? "Unavailable" : scoring.graded ? `${scoring.marginError.toFixed(1)} pts` : "Not graded"}
          detail={`Weeks 2+ · ${scoring.graded} score-graded games`}
        />
        <CalibrationCard
          label="Average total error"
          value={weekOneHistorical ? "Unavailable" : scoring.graded ? `${scoring.totalError.toFixed(1)} pts` : "Not graded"}
          detail={`Weeks 2+ · ${scoring.graded} score-graded games`}
        />
        <CalibrationCard
          label="Market total error"
          value={marketScoring.totalGraded ? `${marketScoring.totalError.toFixed(1)} pts` : "Unavailable"}
          detail={`Weeks 2+ · ${marketScoring.totalGraded} market-total games`}
        />
      </div>

      {week === "all" && weeklyBreakdown.length > 0 && (
        <div className="card results-weekly-breakdown">
          <div className="team-statistics-heading">
            <div>
              <span className="eyebrow">WEEK BY WEEK</span>
              <h3>Accuracy trend</h3>
            </div>
          </div>
          <div className="team-statistics-table prediction-table">
            <div className="team-statistics-row team-statistics-header">
              <strong>Week</strong><span>Fourth Down</span><strong>Score MAE</strong>
            </div>
            {weeklyBreakdown.map((entry) => (
              <div className="team-statistics-row matchup-stat-row" key={entry.week}>
                <strong>Week {entry.week}</strong>
                <span>{entry.record.total ? `${entry.record.percentage.toFixed(1)}% (${entry.record.correct}-${entry.record.total - entry.record.correct})` : "No picks"}</span>
                <strong>{entry.scoring.graded ? `${entry.scoring.teamScoreError.toFixed(1)} pts` : "-"}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card empty">
          <h2>No graded predictions yet</h2>
          <p>Games appear here after a pre-game prediction has been saved and the final score is available.</p>
        </div>
      ) : (
        resultGroups(filtered, week).map(([label, games]) => (
          <section key={label} className="picks-day results-day">
            <h2>{label}</h2>
            <div className="picks-list">
              {games.map((result) => (
                <PickRow
                  key={result.id}
                  prediction={result}
                  expanded={expandedResult === result.id}
                  onToggle={() => setExpandedResult((current) => (current === result.id ? null : result.id))}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <p className="prediction-note results-storage-note">
        Only picks saved before kickoff are graded. Official predictions and results are shared through Supabase, with this browser retained as an offline cache.
      </p>
    </section>
  );
}

function mergeResultRows(currentRows, incomingRows) {
  const merged = new Map();

  for (const row of [...currentRows, ...incomingRows]) {
    if (!row?.awayCode || !row?.homeCode) continue;

    const teams = [
      normalizeTeamCode(row.awayCode),
      normalizeTeamCode(row.homeCode),
    ].sort();

    const key = [
      getResultSeason(row),
      Number(row.week) || 0,
      teams[0],
      teams[1],
    ].join(":");

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }

    const preferred =
      isValidCompletedResult(row) && !isValidCompletedResult(existing)
        ? row
        : row.shared === true && existing.shared !== true
          ? row
          : existing;

    const fallback = preferred === row ? existing : row;
    merged.set(key, mergeNonEmpty(fallback, preferred));
  }

  return [...merged.values()];
}

function mergeNonEmpty(base, preferred) {
  const merged = { ...base };
  for (const [field, value] of Object.entries(preferred || {})) {
    if (value !== null && value !== undefined && value !== "") {
      merged[field] = value;
    }
  }
  return merged;
}

function getResultSeason(row) {
  const explicit = Number(row.season);
  if (Number.isInteger(explicit)) return explicit;
  const kickoff = new Date(row.kickoff);
  return Number.isNaN(kickoff.getTime()) ? new Date().getUTCFullYear() : kickoff.getUTCFullYear();
}

function SummaryCard({ title, record, tone }) {
  return (
    <div className={`card results-summary-card results-summary-${tone}`}>
      <small>{title}</small>
      <strong>{record.total ? `${record.percentage.toFixed(1)}%` : "Not graded"}</strong>
      <span>{record.total ? `${record.correct}-${record.total - record.correct}` : "0 games"}</span>
    </div>
  );
}

function CalibrationCard({ label, value, detail }) {
  return <div className="card results-summary-card"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function calculateScoringAccuracy(rows) {
  const graded = rows.filter(hasFourthDownScores);
  if (!graded.length) {
    return {
      graded: 0,
      marginError: 0,
      totalError: 0,
      teamScoreError: 0,
      totalBias: 0,
      marginBias: 0,
    };
  }

  let marginError = 0;
  let totalError = 0;
  let teamScoreError = 0;
  let totalBias = 0;
  let marginBias = 0;

  for (const row of graded) {
    const predictedAway = Number(row.fourthDownAwayScore);
    const predictedHome = Number(row.fourthDownHomeScore);
    const actualAway = Number(row.actualAwayScore);
    const actualHome = Number(row.actualHomeScore);
    const predictedMargin = Math.abs(predictedHome - predictedAway);
    const actualMargin = Math.abs(actualHome - actualAway);
    const predictedTotal = predictedHome + predictedAway;
    const actualTotal = actualHome + actualAway;

    marginError += Math.abs(predictedMargin - actualMargin);
    totalError += Math.abs(predictedTotal - actualTotal);
    teamScoreError +=
      (Math.abs(predictedAway - actualAway) + Math.abs(predictedHome - actualHome)) / 2;
    totalBias += predictedTotal - actualTotal;
    marginBias += predictedMargin - actualMargin;
  }

  return {
    graded: graded.length,
    marginError: marginError / graded.length,
    totalError: totalError / graded.length,
    teamScoreError: teamScoreError / graded.length,
    totalBias: totalBias / graded.length,
    marginBias: marginBias / graded.length,
  };
}

function calculateMarketScoringAccuracy(rows) {
  const totalRows = rows.filter(
    (row) =>
      !isMissingScore(row.marketGameTotal) &&
      Number.isFinite(Number(row.marketGameTotal)) &&
      hasActualScores(row)
  );

  const totalError = totalRows.length
    ? totalRows.reduce((sum, row) => {
        const actualTotal = Number(row.actualAwayScore) + Number(row.actualHomeScore);
        return sum + Math.abs(Number(row.marketGameTotal) - actualTotal);
      }, 0) / totalRows.length
    : 0;

  return { totalGraded: totalRows.length, totalError };
}

function calculateWeeklyBreakdown(rows) {
  const weeks = [...new Set(rows.map((row) => Number(row.week)).filter(Number.isFinite))].sort((a, b) => a - b);
  return weeks.map((week) => {
    const weekRows = rows.filter((row) => Number(row.week) === week);
    return {
      week,
      record: calculateRecord(weekRows, "fourthDownCorrect", "fourthDownPick"),
      scoring: week >= CURRENT_SCORING_MODEL_START_WEEK
        ? calculateScoringAccuracy(weekRows)
        : { graded: 0, teamScoreError: 0 },
    };
  });
}

function hasActualScores(row) {
  if (isMissingScore(row?.actualAwayScore) || isMissingScore(row?.actualHomeScore)) return false;
  const away = Number(row.actualAwayScore);
  const home = Number(row.actualHomeScore);
  return Number.isFinite(away) && Number.isFinite(home) && !(away === 0 && home === 0);
}

function hasFourthDownScores(row) {
  return (
    hasActualScores(row) &&
    !isMissingScore(row?.fourthDownAwayScore) &&
    !isMissingScore(row?.fourthDownHomeScore) &&
    Number.isFinite(Number(row.fourthDownAwayScore)) &&
    Number.isFinite(Number(row.fourthDownHomeScore))
  );
}

function isMissingScore(value) {
  return value === null || value === undefined || value === "";
}

function calculateRecord(rows, correctKey, pickKey) {
  const graded = rows.filter((row) => row[pickKey]);
  const correct = graded.filter((row) => row[correctKey] === true).length;
  return {
    correct,
    total: graded.length,
    percentage: graded.length ? (correct / graded.length) * 100 : 0,
  };
}

function formatLead(fourthDown, odds) {
  const difference = fourthDown - odds;
  if (!fourthDown && !odds) return "Not graded";
  if (Math.abs(difference) < 0.05) return "Level";
  return `${difference > 0 ? "+" : ""}${difference.toFixed(1)} pts`;
}

// Same layout as Picks: newest week first under week headings, or by day for a single week.
function resultGroups(rows, week) {
  const byKickoff = (a, b) => new Date(a.kickoff) - new Date(b.kickoff);
  if (week !== "all") return groupByDay([...rows].sort(byKickoff));
  const weeks = [...new Set(rows.map((row) => Number(row.week)))].sort((a, b) => b - a);
  return weeks.map((value) => [`Week ${value}`, rows.filter((row) => Number(row.week) === value).sort(byKickoff)]);
}
