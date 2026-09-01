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
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadGame() {
    if (!game?.id) {
      return;
    }

    setLoading(true);
    setStatus("Loading latest game information...");

    try {
      const response = await fetch(
        `/api/nfl/game?id=${encodeURIComponent(game.id)}`
      );

      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error ||
            `Game request failed (${response.status})`
        );
      }

      setLiveGame(body.game);
      setStatus(
        `Updated ${new Date(
          body.refreshedAt
        ).toLocaleTimeString()}`
      );
    } catch (error) {
      console.error("Game loading failed", error);

      setLiveGame(null);
      setStatus(
        error instanceof Error
          ? error.message
          : "Game information could not be loaded"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadGame();
  }, [game?.id]);

  if (!game) {
    return (
      <section className="card empty">
        <h1>No matchup selected</h1>
        <p>Open a game from the Schedule page.</p>

        <button
          type="button"
          className="primary"
          onClick={onBack}
        >
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

  const dateText = Number.isNaN(kickoff.getTime())
    ? game.date
    : kickoff.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });

  const timeText = Number.isNaN(kickoff.getTime())
    ? game.time
    : kickoff.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });

  const gameStatus =
    liveGame?.status_state ||
    liveGame?.status ||
    game.status ||
    "Scheduled";

  const awayScore =
    liveGame?.visitor_team_score ?? game.awayScore ?? null;

  const homeScore =
    liveGame?.home_team_score ?? game.homeScore ?? null;

  const hasScore =
    awayScore !== null || homeScore !== null;

  return (
    <section>
      <div className="matchup-toolbar">
        <button
          type="button"
          className="secondary back"
          onClick={onBack}
        >
          Back to Schedule
        </button>

        <button
          type="button"
          className="secondary refresh-button"
          onClick={loadGame}
          disabled={loading}
        >
          <RefreshCw
            size={16}
            className={loading ? "spin" : ""}
          />

          Refresh game
        </button>
      </div>

      <div className="card matchup-card">
        <div className="game-meta">
          <span>
            Regular season · Week{" "}
            {liveGame?.week || game.week}
          </span>

          <span className="game-status">
            {formatStatus(gameStatus)}
          </span>
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
            value={
              liveGame?.venue ||
              game.venue ||
              "Venue unavailable"
            }
          />
        </div>

        {liveGame && (
          <QuarterScoreTable
            game={liveGame}
            awayCode={awayCode}
            homeCode={homeCode}
          />
        )}
      </div>

      <div
        className={
          status.toLowerCase().includes("failed") ||
          status.toLowerCase().includes("error")
            ? "schedule-status schedule-error"
            : "schedule-status"
        }
      >
        {status}
      </div>
    </section>
  );
}

function LargeTeam({
  code,
  label,
  score,
  showScore,
}) {
  return (
    <div className="large-team">
      <TeamLogo
        team={code}
        size={140}
      />

      <h2>{TEAM_NAMES[code] || code}</h2>

      <small>{label}</small>

      {showScore && (
        <div className="live-team-score">
          {score ?? 0}
        </div>
      )}
    </div>
  );
}

function GameDetail({ icon, label, value }) {
  return (
    <div className="matchup-detail">
      <span className="matchup-detail-icon">
        {icon}
      </span>

      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function QuarterScoreTable({
  game,
  awayCode,
  homeCode,
}) {
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

  const hasQuarterData = [
    ...awayScores,
    ...homeScores,
  ].some((score) => score !== null && score !== undefined);

  if (!hasQuarterData) {
    return (
      <div className="quarter-score-empty">
        Quarter scoring will appear once the game begins.
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

function QuarterScoreRow({
  code,
  scores,
  total,
}) {
  return (
    <div className="quarter-score-row">
      <strong>{code}</strong>

      {scores.map((score, index) => (
        <span key={index}>
          {score ?? "-"}
        </span>
      ))}

      <strong>{total ?? "-"}</strong>
    </div>
  );
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").toUpperCase();

  const aliases = {
    WAS: "WSH",
    LA: "LAR",
  };

  return aliases[normalized] || normalized;
}

function formatStatus(status) {
  const normalized = String(status || "");

  if (!normalized) {
    return "Scheduled";
  }

  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) =>
      character.toUpperCase()
    );
}