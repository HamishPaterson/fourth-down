import { useEffect, useState } from "react";
import {
  CalendarDays,
  Clock,
  MapPin,
  RefreshCw,
} from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Matchup({ game, onBack }) {
  const [liveGame, setLiveGame] = useState(null);
  const [gameStatusMessage, setGameStatusMessage] = useState("");
  const [gameLoading, setGameLoading] = useState(false);
  const [teamStats, setTeamStats] = useState(null);
  const [statsStatusMessage, setStatsStatusMessage] = useState("");
  const [statsLoading, setStatsLoading] = useState(false);

  async function loadGame() {
    if (!game?.id) return;

    setGameLoading(true);
    setGameStatusMessage("Loading latest game information...");

    try {
      const response = await fetch(
        `/api/nfl/game?id=${encodeURIComponent(game.id)}`
      );
      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error || `Game request failed (${response.status})`
        );
      }

      setLiveGame(body.game || null);
      setGameStatusMessage(
        body.refreshedAt
          ? `Game updated ${new Date(body.refreshedAt).toLocaleTimeString()}`
          : "Game information updated"
      );
    } catch (error) {
      console.error("Game loading failed", error);
      setLiveGame(null);
      setGameStatusMessage(
        error instanceof Error
          ? error.message
          : "Game information could not be loaded"
      );
    } finally {
      setGameLoading(false);
    }
  }

  async function loadTeamStats() {
    if (!game?.id) return;

    setStatsLoading(true);
    setStatsStatusMessage("Loading live team statistics...");

    try {
      const response = await fetch(
        `/api/nfl/game-stats?id=${encodeURIComponent(game.id)}`
      );
      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error || `Statistics request failed (${response.status})`
        );
      }

      setTeamStats(body.teams || {});
      setStatsStatusMessage(
        body.recordCount > 0
          ? `${body.recordCount} player statistic records loaded`
          : "Team statistics will appear once available."
      );
    } catch (error) {
      console.error("Team statistics loading failed", error);
      setTeamStats(null);
      setStatsStatusMessage(
        error instanceof Error
          ? error.message
          : "Team statistics could not be loaded"
      );
    } finally {
      setStatsLoading(false);
    }
  }

  useEffect(() => {
    loadGame();
    loadTeamStats();
  }, [game?.id]);

  if (!game) {
    return (
      <section className="card empty">
        <h1>No matchup selected</h1>
        <p>Open a game from the Schedule page.</p>
        <button type="button" className="primary" onClick={onBack}>
          Go to Schedule
        </button>
      </section>
    );
  }

  const awayCode = normalizeTeamCode(
    liveGame?.visitor_team?.abbreviation || game.away
  );
  const homeCode = normalizeTeamCode(
    liveGame?.home_team?.abbreviation || game.home
  );

  const kickoff = new Date(
    liveGame?.date || game.sourceDate || game.date
  );
  const validKickoff = !Number.isNaN(kickoff.getTime());

  const dateText = validKickoff
    ? kickoff.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : game.date;

  const timeText = validKickoff
    ? kickoff.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : game.time;

  const status =
    liveGame?.status_state ||
    liveGame?.status ||
    game.status ||
    "Scheduled";

  const awayScore =
    liveGame?.visitor_team_score ?? game.awayScore ?? null;
  const homeScore =
    liveGame?.home_team_score ?? game.homeScore ?? null;
  const hasScore = awayScore !== null || homeScore !== null;

  async function refreshAll() {
    await Promise.all([loadGame(), loadTeamStats()]);
  }

  return (
    <section>
      <div className="matchup-toolbar">
        <button type="button" className="secondary back" onClick={onBack}>
          Back to Schedule
        </button>

        <button
          type="button"
          className="secondary refresh-button"
          onClick={refreshAll}
          disabled={gameLoading || statsLoading}
        >
          <RefreshCw
            size={16}
            className={gameLoading || statsLoading ? "spin" : ""}
          />
          Refresh game
        </button>
      </div>

      <div className="card matchup-card">
        <div className="game-meta">
          <span>Regular season · Week {liveGame?.week || game.week}</span>
          <span className="game-status">{formatStatus(status)}</span>
        </div>

        <div className="matchup-row">
          <LargeTeam
            code={awayCode}
            label="Away"
            score={awayScore}
            showScore={hasScore}
          />

          <div className="versus large">
            <small>MATCHUP</small>
            <strong>VS</strong>
          </div>

          <LargeTeam
            code={homeCode}
            label="Home"
            score={homeScore}
            showScore={hasScore}
          />
        </div>

        <div className="matchup-details-grid">
          <GameDetail
            icon={<CalendarDays size={18} />}
            label="Date"
            value={dateText}
          />
          <GameDetail
            icon={<Clock size={18} />}
            label="Local time"
            value={timeText}
          />
          <GameDetail
            icon={<MapPin size={18} />}
            label="Venue"
            value={liveGame?.venue || game.venue || "Venue unavailable"}
          />
        </div>

        {liveGame ? (
          <QuarterScoreTable
            game={liveGame}
            awayCode={awayCode}
            homeCode={homeCode}
          />
        ) : (
          <div className="quarter-score-empty">
            <strong>Scoring by quarter</strong>
            <span>
              Quarter scores will appear once game information is available.
            </span>
          </div>
        )}

        <TeamStatistics
          awayCode={awayCode}
          homeCode={homeCode}
          stats={teamStats}
          status={statsStatusMessage}
          loading={statsLoading}
          onRefresh={loadTeamStats}
        />
      </div>

      {gameStatusMessage && (
        <div
          className={
            isErrorMessage(gameStatusMessage)
              ? "schedule-status schedule-error"
              : "schedule-status"
          }
        >
          {gameStatusMessage}
        </div>
      )}
    </section>
  );
}

function LargeTeam({ code, label, score, showScore }) {
  return (
    <div className="large-team">
      <TeamLogo team={code} size={140} />
      <h2>{TEAM_NAMES[code] || code}</h2>
      <small>{label}</small>
      {showScore && <div className="live-team-score">{score ?? 0}</div>}
    </div>
  );
}

function GameDetail({ icon, label, value }) {
  return (
    <div className="matchup-detail">
      <span className="matchup-detail-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function QuarterScoreTable({ game, awayCode, homeCode }) {
  const awayScores = [
    game.visitor_team_q1,
    game.visitor_team_q2,
    game.visitor_team_q3,
    game.visitor_team_q4,
    game.visitor_team_ot,
  ];
  const homeScores = [
    game.home_team_q1,
    game.home_team_q2,
    game.home_team_q3,
    game.home_team_q4,
    game.home_team_ot,
  ];

  const hasQuarterData = [...awayScores, ...homeScores].some(
    (score) => score !== null && score !== undefined
  );

  if (!hasQuarterData) {
    return (
      <div className="quarter-score-empty">
        <strong>Scoring by quarter</strong>
        <span>Quarter scores will appear here once the game begins.</span>
      </div>
    );
  }

  return (
    <div className="quarter-score-wrapper">
      <h3>Scoring by quarter</h3>
      <div className="quarter-score-table">
        <div className="quarter-score-row quarter-score-header">
          <span>Team</span>
          <span>Q1</span>
          <span>Q2</span>
          <span>Q3</span>
          <span>Q4</span>
          <span>OT</span>
          <span>Total</span>
        </div>
        <QuarterScoreRow
          code={awayCode}
          scores={awayScores}
          total={game.visitor_team_score}
        />
        <QuarterScoreRow
          code={homeCode}
          scores={homeScores}
          total={game.home_team_score}
        />
      </div>
    </div>
  );
}

function QuarterScoreRow({ code, scores, total }) {
  return (
    <div className="quarter-score-row">
      <strong>{code}</strong>
      {scores.map((score, index) => (
        <span key={index}>{score ?? "-"}</span>
      ))}
      <strong>{total ?? "-"}</strong>
    </div>
  );
}

function TeamStatistics({
  awayCode,
  homeCode,
  stats,
  status,
  loading,
  onRefresh,
}) {
  const awayStats = stats?.[awayCode];
  const homeStats = stats?.[homeCode];

  const rows = [
    ["Total offence", awayStats?.totalOffense, homeStats?.totalOffense, " yds"],
    ["Passing yards", awayStats?.passingYards, homeStats?.passingYards, " yds"],
    ["Rushing yards", awayStats?.rushingYards, homeStats?.rushingYards, " yds"],
    [
      "Pass completions",
      formatFraction(awayStats?.passingCompletions, awayStats?.passingAttempts),
      formatFraction(homeStats?.passingCompletions, homeStats?.passingAttempts),
      "",
    ],
    ["Completion rate", awayStats?.completionPercentage, homeStats?.completionPercentage, "%"],
    ["Rushing attempts", awayStats?.rushingAttempts, homeStats?.rushingAttempts, ""],
    ["Rush average", awayStats?.yardsPerRush, homeStats?.yardsPerRush, " yds"],
    ["Passing touchdowns", awayStats?.passingTouchdowns, homeStats?.passingTouchdowns, ""],
    ["Rushing touchdowns", awayStats?.rushingTouchdowns, homeStats?.rushingTouchdowns, ""],
    ["Turnovers", awayStats?.turnovers, homeStats?.turnovers, ""],
    ["Sacks", awayStats?.sacks, homeStats?.sacks, ""],
    ["Total tackles", awayStats?.totalTackles, homeStats?.totalTackles, ""],
    [
      "Field goals",
      formatFraction(awayStats?.fieldGoalsMade, awayStats?.fieldGoalsAttempted),
      formatFraction(homeStats?.fieldGoalsMade, homeStats?.fieldGoalsAttempted),
      "",
    ],
    ["Punt average", awayStats?.puntAverage, homeStats?.puntAverage, " yds"],
  ];

  const hasStats = Boolean(awayStats || homeStats);

  return (
    <div className="team-statistics">
      <div className="team-statistics-heading">
        <div>
          <span className="eyebrow">LIVE GAME DATA</span>
          <h3>Team statistics</h3>
        </div>

        <button
          type="button"
          className="secondary refresh-button"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          Refresh stats
        </button>
      </div>

      {!hasStats ? (
        <div className="team-statistics-empty">
          {status || "Team statistics will appear once available."}
        </div>
      ) : (
        <>
          <div className="team-statistics-table">
            <div className="team-statistics-row team-statistics-header">
              <strong>{awayCode}</strong>
              <span>Statistic</span>
              <strong>{homeCode}</strong>
            </div>

            {rows.map(([label, away, home, suffix]) => (
              <StatRow
                key={label}
                label={label}
                away={away}
                home={home}
                suffix={suffix}
              />
            ))}
          </div>

          {status && <div className="team-statistics-status">{status}</div>}
        </>
      )}
    </div>
  );
}

function StatRow({ label, away, home, suffix = "" }) {
  return (
    <div className="team-statistics-row">
      <strong>{formatStatValue(away, suffix)}</strong>
      <span>{label}</span>
      <strong>{formatStatValue(home, suffix)}</strong>
    </div>
  );
}

function formatStatValue(value, suffix = "") {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return `${value}${suffix}`;
}

function formatFraction(first, second) {
  if (
    first === null ||
    first === undefined ||
    second === null ||
    second === undefined
  ) {
    return null;
  }
  return `${first}/${second}`;
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}

function formatStatus(status) {
  const normalized = String(status || "");
  if (!normalized) return "Scheduled";
  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isErrorMessage(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("invalid")
  );
}
