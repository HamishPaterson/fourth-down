import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import TeamLogo from "../components/TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import {
  hasMigratedSharedLedger,
  migrateLocalPredictionLedger,
  readPredictionLedger,
  refreshPredictionLedger,
  saveGradedPredictions,
} from "../services/predictionLedger.js";

const CURRENT_SCORING_MODEL_START_WEEK = 2;

export default function Results() {
  const [rows, setRows] = useState(() => readPredictionLedger());
  const [week, setWeek] = useState("all");
  const [syncStatus, setSyncStatus] = useState("Checking final scores...");

  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();

    const syncResults = async () => {
      controller.abort();
      controller = new AbortController();

      let authoritativeRows = readPredictionLedger();

      try {
        if (!hasMigratedSharedLedger()) {
          await migrateLocalPredictionLedger();
        }

        const sharedRows = await refreshPredictionLedger({
          signal: controller.signal,
        });

        if (sharedRows.length) {
          authoritativeRows = sharedRows;
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
        return;
      }

      try {
        setSyncStatus("Checking final scores...");
        const updatedRows = await hydrateFinalScores(
          authoritativeRows,
          controller.signal
        );

        if (cancelled) return;

        const canonicalRows = mergeResultRows([], updatedRows);
        saveGradedPredictions(
          canonicalRows.filter((row) => row.actualWinner)
        );
        setRows(canonicalRows);

        const count = canonicalRows.filter(isValidCompletedResult).length;
        setSyncStatus(
          `Results updated · ${count} graded game${count === 1 ? "" : "s"}`
        );
      } catch (error) {
        if (!cancelled && error?.name !== "AbortError") {
          console.error("Results sync failed", error);
          setSyncStatus("Could not refresh final scores");
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

  const fourthDown = calculateRecord(filtered, "fourthDownCorrect", "fourthDownPick");
  const odds = calculateRecord(filtered, "oddsCorrect", "oddsPick");
  const calibration = calculateCalibration(filtered);
  const currentModelScoreRows = filtered.filter(
    (row) => Number(row.week) >= CURRENT_SCORING_MODEL_START_WEEK
  );
  const scoring = calculateScoringAccuracy(currentModelScoreRows);
  const marketScoring = calculateMarketScoringAccuracy(currentModelScoreRows);
  const weeklyBreakdown = calculateWeeklyBreakdown(completed);

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
          label="Brier score"
          value={calibration.graded ? calibration.brier.toFixed(3) : "Not graded"}
          detail={`${calibration.graded} of ${filtered.length} games eligible`}
        />
        <CalibrationCard
          label="Average margin error"
          value={scoring.graded ? `${scoring.marginError.toFixed(1)} pts` : "Not graded"}
          detail={`Weeks 2+ · ${scoring.graded} score-graded games`}
        />
        <CalibrationCard
          label="Average total error"
          value={scoring.graded ? `${scoring.totalError.toFixed(1)} pts` : "Not graded"}
          detail={`Weeks 2+ · ${scoring.graded} score-graded games`}
        />
      </div>

      <div className="results-summary-grid">
        <CalibrationCard
          label="Fourth Down total bias"
          value={scoring.graded ? formatSignedMetric(scoring.totalBias) : "Not graded"}
          detail={`Weeks 2+ · ${scoring.graded} score-graded games`}
        />
        <CalibrationCard
          label="Fourth Down margin bias"
          value={scoring.graded ? formatSignedMetric(scoring.marginBias) : "Not graded"}
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
        <div className="results-game-grid">
          {[...filtered].sort(sortResults).map((result) => (
            <ResultGameCard key={result.id} result={result} />
          ))}
        </div>
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

async function hydrateFinalScores(rows, signal) {
  const keys = new Map();

  for (const row of rows) {
    const week = Number(row.week);
    const season = getResultSeason(row);

    if (Number.isInteger(week) && Number.isInteger(season)) {
      keys.set(`${season}:${week}`, { season, week });
    }
  }

  const requests = await Promise.allSettled(
    [...keys.values()].map(async ({ season, week }) => {
      const params = new URLSearchParams({
        season: String(season),
        week: String(week),
        results: "1",
        refresh: String(Date.now()),
      });

      const response = await fetch(
        `/api/nfl/schedule?${params.toString()}`,
        {
          signal,
          cache: "no-store",
        }
      );

      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.error ||
            `Week ${week} schedule request failed (${response.status})`
        );
      }

      return {
        season,
        week,
        games: (Array.isArray(body.games) ? body.games : []).map(
          (game) => ({
            ...game,
            requestedWeek: week,
          })
        ),
      };
    })
  );

  const gamesByWeek = new Map();
  for (const request of requests) {
    if (request.status === "fulfilled") {
      gamesByWeek.set(
        `${request.value.season}:${request.value.week}`,
        request.value.games
      );
    } else if (request.reason?.name !== "AbortError") {
      console.error("Results week refresh failed", request.reason);
    }
  }

  return rows.map((row) => {
    // Never remove a result that was already graded.
    if (row.actualWinner) return row;

    const season = getResultSeason(row);
    const week = Number(row.week);
    const games = gamesByWeek.get(`${season}:${week}`) || [];
    const game = games.find((candidate) => resultMatchesGame(row, candidate));

    if (!game || !isFinalGame(game)) return row;

    const actualAwayScore = getGameScore(game, "away");
    const actualHomeScore = getGameScore(game, "home");
    if (actualAwayScore == null || actualHomeScore == null) return row;

    const actualWinner =
      actualAwayScore === actualHomeScore
        ? "TIE"
        : actualAwayScore > actualHomeScore
          ? normalizeTeamCode(row.awayCode)
          : normalizeTeamCode(row.homeCode);

    return {
      ...row,
      actualAwayScore,
      actualHomeScore,
      actualWinner,
      fourthDownCorrect:
        row.fourthDownPick == null
          ? null
          : normalizeTeamCode(row.fourthDownPick) === actualWinner,
      oddsCorrect:
        row.oddsPick == null
          ? null
          : normalizeTeamCode(row.oddsPick) === actualWinner,
      resultUpdatedAt: new Date().toISOString(),
    };
  });
}

function resultMatchesGame(row, game) {
  return Number(row.week) === Number(game.week ?? game.requestedWeek) &&
    normalizeTeamCode(row.awayCode) === getGameTeamCode(game, "away") &&
    normalizeTeamCode(row.homeCode) === getGameTeamCode(game, "home");
}

function isFinalGame(game) {
  if (game.completed === true) return true;

  const status = String(
    game.status ||
    game.status_state ||
    game.state ||
    ""
  ).toLowerCase();

  return (
    status.includes("final") ||
    status.includes("complete") ||
    status.includes("closed") ||
    status === "post"
  );
}


function getGameTeamCode(game, side) {
  const team = side === "away"
    ? game.visitor_team || game.away_team || game.away || {}
    : game.home_team || game.home || {};
  return normalizeTeamCode(
    team.abbreviation || team.abbr || team.code ||
    game[`${side}_team_abbreviation`] || game[`${side}_team_code`]
  );
}

function getGameScore(game, side) {
  const value = side === "away"
    ? game.visitor_team_score ?? game.away_team_score ?? game.away_score
    : game.home_team_score ?? game.home_score;
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function getResultSeason(row) {
  const explicit = Number(row.season);
  if (Number.isInteger(explicit)) return explicit;
  const kickoff = new Date(row.kickoff);
  return Number.isNaN(kickoff.getTime()) ? new Date().getUTCFullYear() : kickoff.getUTCFullYear();
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" }[normalized] || normalized;
}

function ResultGameCard({ result }) {
  const awayTheme = getTeamTheme(result.awayCode);
  const homeTheme = getTeamTheme(result.homeCode);
  const style = {
    "--away-primary": awayTheme["--team-primary"],
    "--away-secondary": awayTheme["--team-secondary"],
    "--away-watermark": awayTheme["--team-watermark"],
    "--home-primary": homeTheme["--team-primary"],
    "--home-secondary": homeTheme["--team-secondary"],
    "--home-watermark": homeTheme["--team-watermark"],
  };

  return (
    <article className="card results-game-card" style={style}>
      <span className="results-away-watermark" aria-hidden="true" />
      <span className="results-home-watermark" aria-hidden="true" />
      <span className="results-centre-line" aria-hidden="true" />

      <div className="game-meta results-game-meta">
        <span>Regular season · Week {result.week}</span>
        <strong>FINAL</strong>
      </div>

      <div className="results-scoreboard">
        <ResultTeam
          code={result.awayCode}
          score={result.actualAwayScore}
          winner={result.actualWinner === result.awayCode}
          side="away"
        />

        <div className="results-score-divider">
          <small>{formatDate(result.kickoff)}</small>
          <strong>{result.actualAwayScore} - {result.actualHomeScore}</strong>
          <span>FINAL</span>
        </div>

        <ResultTeam
          code={result.homeCode}
          score={result.actualHomeScore}
          winner={result.actualWinner === result.homeCode}
          side="home"
        />
      </div>

      <div className="results-picks-grid">
        <PickResult
          label="Fourth Down"
          pick={result.fourthDownPick}
          correct={result.fourthDownCorrect}
        />
        <PickResult
          label="Odds makers"
          pick={result.oddsPick}
          correct={result.oddsCorrect}
        />
        <div className="results-pick-panel results-actual-panel">
          <small>Actual winner</small>
          <strong>{teamName(result.actualWinner)}</strong>
          <span>{result.actualWinner}</span>
        </div>
      </div>
    </article>
  );
}

function ResultTeam({ code, score, winner, side }) {
  return (
    <div className={`results-team results-team-${side}${winner ? " winner" : ""}`}>
      <span className="results-logo-stage">
        <TeamLogo team={code} size={108} />
      </span>
      <strong>{teamName(code)}</strong>
      <small>{side === "away" ? "Away" : "Home"}</small>
      <span className="results-team-score">{score}</span>
      {winner && <span className="results-winner-pill">WINNER</span>}
    </div>
  );
}

function PickResult({ label, pick, correct }) {
  const Icon = pick == null ? MinusCircle : correct ? CheckCircle2 : XCircle;
  const status = pick == null ? "Not recorded" : correct ? "Correct" : "Incorrect";
  const className = pick == null ? "ungraded" : correct ? "correct" : "incorrect";

  return (
    <div className={`results-pick-panel ${className}`}>
      <small>{label} picked</small>
      <strong>{pick ? teamName(pick) : "Not available"}</strong>
      <span><Icon size={16} /> {status}</span>
    </div>
  );
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

function calculateCalibration(rows) {
  const graded = rows.filter(
    (row) =>
      Number.isFinite(Number(row.fourthDownWinnerProbability)) &&
      row.actualWinner &&
      row.actualWinner !== "TIE" &&
      row.fourthDownPick
  );

  if (!graded.length) return { graded: 0, brier: 0 };

  const brier = graded.reduce((total, row) => {
    const probability = Number(row.fourthDownWinnerProbability);
    const outcome = normalizeTeamCode(row.fourthDownPick) === normalizeTeamCode(row.actualWinner) ? 1 : 0;
    return total + (probability - outcome) ** 2;
  }, 0) / graded.length;

  return { graded: graded.length, brier };
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

function isValidCompletedResult(row) {
  if (!row?.actualWinner) return false;
  const away = Number(row.actualAwayScore);
  const home = Number(row.actualHomeScore);
  return Number.isFinite(away) && Number.isFinite(home) && !(away === 0 && home === 0);
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

function formatSignedMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)} pts`;
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

function teamName(code) {
  return TEAM_NAMES[code] || code || "Not available";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function sortResults(first, second) {
  return Number(second.week) - Number(first.week) || new Date(second.kickoff) - new Date(first.kickoff);
}
