import { useEffect, useState } from "react";
import { MapPin, RefreshCw } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import TeamLogo from "../components/TeamLogo.jsx";

const SEASON = 2026;

export default function Schedule({ onOpen }) {
  const [week, setWeek] = useState(1);
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState("Loading schedule...");
  const [loading, setLoading] = useState(true);

  async function loadSchedule() {
    setLoading(true);
    setStatus(`Loading Week ${week}...`);

    try {
      const response = await fetch(
        `/api/nfl/schedule?season=${SEASON}&week=${week}`
      );
      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error || `Schedule request failed (${response.status})`
        );
      }

      const mappedGames = (body.games || [])
        .map(mapGame)
        .filter(
          (game) =>
            game.away &&
            game.home &&
            TEAM_NAMES[game.away] &&
            TEAM_NAMES[game.home]
        );

      setGames(mappedGames);
      setStatus(
        mappedGames.length === 0
          ? `No games returned for Week ${week}`
          : `${mappedGames.length} games loaded for Week ${week}`
      );
    } catch (error) {
      console.error("Schedule loading failed", error);
      setGames([]);
      setStatus(
        error instanceof Error
          ? error.message
          : "The schedule could not be loaded"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSchedule();
  }, [week]);

  return (
    <section className="schedule-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{SEASON} REGULAR SEASON</span>
          <h1>Week {week} schedule</h1>
        </div>

        <span className="count-pill">{games.length} games</span>
      </div>

      <div className="schedule-controls">
        <label>
          Week
          <select
            value={week}
            onChange={(event) => setWeek(Number(event.target.value))}
          >
            {Array.from({ length: 18 }, (_, index) => {
              const weekNumber = index + 1;

              return (
                <option key={weekNumber} value={weekNumber}>
                  Week {weekNumber}
                </option>
              );
            })}
          </select>
        </label>

        <button
          type="button"
          className="secondary refresh-button"
          onClick={loadSchedule}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          Refresh
        </button>
      </div>

      <div
        className={
          isErrorMessage(status)
            ? "schedule-status schedule-error"
            : "schedule-status"
        }
      >
        {status}
      </div>

      {loading && games.length === 0 ? (
        <div className="card empty">
          <h2>Loading Week {week}</h2>
          <p>Retrieving the latest schedule.</p>
        </div>
      ) : games.length === 0 ? (
        <div className="card empty">
          <h2>No games available</h2>
          <p>No compatible games were returned for Week {week}.</p>
          <button type="button" className="primary" onClick={loadSchedule}>
            Try again
          </button>
        </div>
      ) : (
        <div className="game-grid">
          {games.map((game) => (
            <GameCard key={game.id} game={game} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

function GameCard({ game, onOpen }) {
  const awayTheme = getTeamTheme(game.away);
  const homeTheme = getTeamTheme(game.home);

  const matchupTheme = {
    "--away-primary": awayTheme["--team-primary"],
    "--away-secondary": awayTheme["--team-secondary"],
    "--away-watermark": awayTheme["--team-watermark"],
    "--home-primary": homeTheme["--team-primary"],
    "--home-secondary": homeTheme["--team-secondary"],
    "--home-watermark": homeTheme["--team-watermark"],
  };

  return (
    <button
      type="button"
      className="game-card card matchup-colour-card"
      style={matchupTheme}
      onClick={() => onOpen(game)}
    >
      <span className="matchup-away-watermark" aria-hidden="true" />
      <span className="matchup-home-watermark" aria-hidden="true" />
      <span className="matchup-centre-line" aria-hidden="true" />

      <div className="game-meta matchup-game-meta">
        <span>Week {game.week}</span>
        <span>{game.date}</span>
      </div>

      <div className="teams-row matchup-teams-row">
        <Team code={game.away} side="away" />

        <div className="versus matchup-versus">
          <small>{game.time}</small>
          <strong>VS</strong>
        </div>

        <Team code={game.home} side="home" />
      </div>

      <div className="venue matchup-venue">
        <MapPin size={15} />
        <span>{game.venue}</span>
        <strong>View matchup</strong>
      </div>
    </button>
  );
}

function Team({ code, side }) {
  return (
    <div className={`team matchup-team matchup-team-${side}`}>
      <span className="matchup-logo-stage">
        <TeamLogo team={code} size={95} />
      </span>
      <strong>{TEAM_NAMES[code] || code}</strong>
    </div>
  );
}

function mapGame(apiGame) {
  const kickoff = new Date(apiGame.date);
  const away = normalizeTeamCode(apiGame.visitor_team?.abbreviation);
  const home = normalizeTeamCode(apiGame.home_team?.abbreviation);

  return {
    id: String(apiGame.id),
    week: apiGame.week,
    away,
    home,
    sourceDate: apiGame.date,
    date: Number.isNaN(kickoff.getTime())
      ? "Date unavailable"
      : kickoff.toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
    time: Number.isNaN(kickoff.getTime())
      ? "Time unavailable"
      : kickoff.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }),
    venue: apiGame.venue || "Venue unavailable",
    status: apiGame.status || "Scheduled",
    awayScore: apiGame.visitor_team_score ?? null,
    homeScore: apiGame.home_team_score ?? null,
  };
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}

function isErrorMessage(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("invalid")
  );
}
