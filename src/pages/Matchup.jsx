import { useEffect, useState } from "react";
import {
  CalendarDays,
  Clock,
  CloudSun,
  MapPin,
  RefreshCw,
} from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import {
  getStadiumWeather,
  describeWeather,
} from "../services/weatherApi.js";
import {
  findOddsForGame,
  getNflOdds,
} from "../services/oddsApi.js";
import TeamLogo from "../components/TeamLogo.jsx";
import BettingOdds from "../components/BettingOdds.jsx";
import MatchupPrediction from "../components/MatchupPrediction.jsx";
import { refreshPredictionLedger, findPredictionSnapshot } from "../services/predictionLedger.js";

export default function Matchup({ game, onBack }) {
  const [liveGame, setLiveGame] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [oddsEvent, setOddsEvent] = useState(
    game?.oddsEvent || null
  );
  const [oddsStatus, setOddsStatus] = useState("");
  const [oddsLoading, setOddsLoading] = useState(false);
  const [weather, setWeather] = useState(null);
  const [sharedPrediction, setSharedPrediction] = useState(game?.authoritativePrediction || null);

  async function loadGame() {
    if (!game?.id) return;

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

      setLiveGame(body.game || null);
      setStatus(
        body.refreshedAt
          ? `Game updated ${new Date(
              body.refreshedAt
            ).toLocaleTimeString()}`
          : "Game information updated"
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

  async function loadOdds() {
    if (!game) return;

    if (game.oddsEvent) {
      setOddsEvent(game.oddsEvent);
      setOddsStatus("");
      return;
    }

    setOddsLoading(true);
    setOddsStatus("Loading betting odds...");

    try {
      const events = await getNflOdds();
      const match = findOddsForGame(events, game);
      setOddsEvent(match);
      setOddsStatus(
        match
          ? ""
          : "Betting odds are not currently available for this matchup."
      );
    } catch (error) {
      console.error("Odds loading failed", error);
      setOddsEvent(null);
      setOddsStatus(
        error instanceof Error
          ? error.message
          : "Betting odds could not be loaded"
      );
    } finally {
      setOddsLoading(false);
    }
  }

  useEffect(() => {
    setOddsEvent(game?.oddsEvent || null);
    setLiveGame(null);
    loadGame();
    loadOdds();
  }, [game?.id]);
  useEffect(() => {
    setSharedPrediction(game?.authoritativePrediction || null);
    if (!game?.week || !game?.away || !game?.home) return undefined;
    const controller = new AbortController();
    refreshPredictionLedger({ season: 2026, week: Number(game.week), signal: controller.signal })
      .then((rows) => {
        const snapshot = findPredictionSnapshot(rows, Number(game.week), game.away, game.home);
        if (snapshot) setSharedPrediction(snapshot);
      })
      .catch((error) => { if (error?.name !== "AbortError") console.warn("Shared matchup prediction unavailable", error); });
    return () => controller.abort();
  }, [game?.week, game?.away, game?.home, game?.authoritativePrediction]);

  if (!game) {
    return (
      <section className="card empty">
        <h1>No matchup selected</h1>
        <p>Open a game from the Predictions page.</p>
        <button
          type="button"
          className="primary"
          onClick={onBack}
        >
          Go to Predictions
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
  const matchupTheme = createMatchupTheme(
    awayCode,
    homeCode
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
  const gameStatus =
    liveGame?.status_state ||
    liveGame?.status ||
    game.status ||
    "Scheduled";
  const awayScore = scoreOrNull(
    liveGame?.visitor_team_score ?? game.awayScore
  );
  const homeScore = scoreOrNull(
    liveGame?.home_team_score ?? game.homeScore
  );
  const showScore =
    isLiveOrCompletedStatus(gameStatus) &&
    awayScore !== null &&
    homeScore !== null;

  useEffect(() => {
    if (!homeCode || !validKickoff) {
      setWeather(null);
      return undefined;
    }

    const controller = new AbortController();

    getStadiumWeather(
      homeCode,
      kickoff.toISOString(),
      controller.signal
    )
      .then(setWeather)
      .catch(() => setWeather(null));

    return () => controller.abort();
  }, [
    homeCode,
    validKickoff ? kickoff.toISOString() : null,
  ]);

  async function refreshWeather() {
    if (!homeCode || !validKickoff) return;

    const result = await getStadiumWeather(
      homeCode,
      kickoff.toISOString()
    );
    setWeather(result);
  }

  async function refreshAll() {
    await Promise.all([
      loadGame(),
      loadOdds(),
      refreshWeather(),
    ]);
  }

  return (
    <section
      className="matchup-page-themed"
      style={matchupTheme}
    >
      <span
        className="matchup-page-away-watermark"
        aria-hidden="true"
      />
      <span
        className="matchup-page-home-watermark"
        aria-hidden="true"
      />

      <div className="matchup-toolbar">
        <button
          type="button"
          className="secondary matchup-away-action"
          onClick={onBack}
        >
          Back to Predictions
        </button>

        <button
          type="button"
          className="secondary refresh-button matchup-home-action"
          onClick={refreshAll}
          disabled={loading || oddsLoading}
        >
          <RefreshCw
            size={16}
            className={loading || oddsLoading ? "spin" : ""}
          />
          Refresh game
        </button>
      </div>

      <div className="card matchup-card matchup-battle-card">
        <div className="game-meta matchup-battle-meta">
          <span>
            Regular season · Week {liveGame?.week || game.week}
          </span>
          <span className="game-status">
            {formatStatus(gameStatus)}
          </span>
        </div>

        <div className="matchup-row matchup-battle-row">
          <LargeTeam
            code={awayCode}
            label="Away"
            score={awayScore}
            showScore={showScore}
            side="away"
          />

          <div className="versus large matchup-battle-versus">
            <small>MATCHUP</small>
            <strong>VS</strong>
          </div>

          <LargeTeam
            code={homeCode}
            label="Home"
            score={homeScore}
            showScore={showScore}
            side="home"
          />
        </div>

        <div className="matchup-details-grid matchup-colour-details">
          <GameDetail
            className="away-detail"
            icon={<CalendarDays size={18} />}
            label="Date"
            value={dateText}
          />
          <GameDetail
            className="split-detail"
            icon={<Clock size={18} />}
            label="Local time"
            value={timeText}
          />
          <GameDetail
            className="home-detail"
            icon={<MapPin size={18} />}
            label="Venue"
            value={
              liveGame?.venue ||
              game.venue ||
              "Venue unavailable"
            }
          />
          <GameDetail
            className="weather-detail"
            icon={<CloudSun size={18} />}
            label="Weather"
            value={
              describeWeather(weather) ||
              "Forecast unavailable"
            }
          />
        </div>

        <BettingOdds
          event={oddsEvent}
          awayCode={awayCode}
          homeCode={homeCode}
          status={oddsStatus}
          loading={oddsLoading}
          onRefresh={loadOdds}
        />

        {liveGame ? (
          <QuarterScoreTable
            game={liveGame}
            awayCode={awayCode}
            homeCode={homeCode}
          />
        ) : (
          <EmptyPanel
            title="Scoring by quarter"
            text="Quarter scores will appear once game information is available."
          />
        )}

        <MatchupPrediction
          prediction={sharedPrediction}
          awayCode={awayCode}
          homeCode={homeCode}
          kickoff={validKickoff ? kickoff.toISOString() : null}
          weather={weather}
          oddsEvent={oddsEvent}
          week={Number(game.week || liveGame?.week || 1)}
          scheduleContext={game.scheduleContext || null}
          actualAwayScore={isCompletedStatus(gameStatus) ? awayScore : null}
          actualHomeScore={isCompletedStatus(gameStatus) ? homeScore : null}
        />
      </div>

      {status && (
        <div
          className={
            isErrorMessage(status)
              ? "schedule-status schedule-error"
              : "schedule-status matchup-update-status"
          }
        >
          {status}
        </div>
      )}
    </section>
  );
}

function isCompletedStatus(status) {
  const value = String(status || "")
    .trim()
    .toLowerCase();

  return (
    value === "final" ||
    value === "completed" ||
    value === "complete" ||
    value === "closed" ||
    value.includes("final")
  );
}

function isLiveOrCompletedStatus(status) {
  if (isCompletedStatus(status)) return true;

  const value = String(status || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ");

  return (
    value === "live" ||
    value === "in progress" ||
    value === "halftime" ||
    value === "overtime" ||
    value === "ot" ||
    /^(1st|2nd|3rd|4th)( quarter)?$/.test(value) ||
    value.includes("quarter") ||
    value.includes("q1") ||
    value.includes("q2") ||
    value.includes("q3") ||
    value.includes("q4")
  );
}

function scoreOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function LargeTeam({
  code,
  label,
  score,
  showScore,
  side,
}) {
  return (
    <div
      className={`large-team battle-team battle-team-${side}`}
    >
      <span className="battle-logo-stage">
        <TeamLogo team={code} size={150} />
      </span>
      <h2>{TEAM_NAMES[code] || code}</h2>
      <small>{label}</small>
      {showScore && (
        <div className="live-team-score">{score}</div>
      )}
    </div>
  );
}

function GameDetail({
  icon,
  label,
  value,
  className = "",
}) {
  return (
    <div className={`matchup-detail ${className}`}>
      <span className="matchup-detail-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function EmptyPanel({ title, text }) {
  return (
    <div className="quarter-score-empty matchup-split-panel">
      <strong>{title}</strong>
      <span>{text}</span>
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
  ].some(
    (score) =>
      score !== null &&
      score !== undefined
  );

  if (!hasQuarterData) {
    return (
      <EmptyPanel
        title="Scoring by quarter"
        text="Quarter scores will appear here once the game begins."
      />
    );
  }

  return (
    <div className="quarter-score-wrapper">
      <h3>Scoring by quarter</h3>
      <div className="quarter-score-table matchup-quarter-table">
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
          side="away"
        />
        <QuarterScoreRow
          code={homeCode}
          scores={homeScores}
          total={game.home_team_score}
          side="home"
        />
      </div>
    </div>
  );
}

function QuarterScoreRow({
  code,
  scores,
  total,
  side,
}) {
  return (
    <div
      className={`quarter-score-row matchup-quarter-${side}`}
    >
      <strong>{code}</strong>
      {scores.map((score, index) => (
        <span key={index}>{score ?? "-"}</span>
      ))}
      <strong>{total ?? "-"}</strong>
    </div>
  );
}

function createMatchupTheme(
  awayCode,
  homeCode
) {
  const away = getTeamTheme(awayCode);
  const home = getTeamTheme(homeCode);

  return {
    "--away-primary": away["--team-primary"],
    "--away-secondary": away["--team-secondary"],
    "--away-watermark": away["--team-watermark"],
    "--home-primary": home["--team-primary"],
    "--home-secondary": home["--team-secondary"],
    "--home-watermark": home["--team-watermark"],
  };
}

function normalizeTeamCode(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase();

  const aliases = {
    WAS: "WSH",
    LA: "LAR",
    JAC: "JAX",
    OAK: "LV",
    SD: "LAC",
    STL: "LAR",
  };

  return aliases[normalized] || normalized;
}

function formatStatus(status) {
  const normalized = String(status || "");

  return normalized
    ? normalized
        .replaceAll("_", " ")
        .replace(
          /\b\w/g,
          (character) => character.toUpperCase()
        )
    : "Scheduled";
}

function isErrorMessage(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("invalid")
  );
}
