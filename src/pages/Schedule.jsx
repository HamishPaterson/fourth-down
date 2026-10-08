import { useEffect, useRef, useState } from "react";
import { MapPin, RefreshCw } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import { findOddsForGame, getNflOdds } from "../services/oddsApi.js";
import TeamLogo from "../components/TeamLogo.jsx";

const SEASON = 2026;
const SCHEDULE_CACHE_PREFIX = "fourth-down:schedule";
const SCHEDULE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const pendingScheduleRequests = new Map();

export default function Schedule({ onOpen, favoriteTeam, initialMode = "all" }) {
  const [week, setWeek] = useState(getCurrentWeek());
  const [games, setGames] = useState([]);
  const [viewMode, setViewMode] = useState(initialMode);
  const [oddsEvents, setOddsEvents] = useState([]);
  const [status, setStatus] = useState("Loading schedule...");
  const [oddsStatus, setOddsStatus] = useState("Loading odds...");
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);
  const gameDetailsRef = useRef(new Map());

  useEffect(() => {
    setViewMode(initialMode);
  }, [initialMode]);

  async function hydrateScores(scheduleGames, requestId) {
    const now = Date.now();

    const hydrated = await Promise.all(
      scheduleGames.map(async (scheduledGame) => {
        const cachedDetail = gameDetailsRef.current.get(scheduledGame.id);

        if (cachedDetail?.final) {
          return { ...scheduledGame, ...cachedDetail.game };
        }

        const kickoff = new Date(scheduledGame.sourceDate).getTime();
        const shouldCheckGame =
          Number.isFinite(kickoff) &&
          kickoff <= now + 15 * 60 * 1000;

        if (!shouldCheckGame) {
          return scheduledGame;
        }

        try {
          const response = await fetch(
            `/api/nfl/game?id=${encodeURIComponent(scheduledGame.id)}`,
            { headers: { Accept: "application/json" } }
          );
          const body = await response.json();

          if (!response.ok || !body?.game) {
            return cachedDetail?.game
              ? { ...scheduledGame, ...cachedDetail.game }
              : scheduledGame;
          }

          const detailedGame = mapGame(body.game);
          const final = getGameState(detailedGame) === "final";
          gameDetailsRef.current.set(scheduledGame.id, {
            game: detailedGame,
            final,
          });

          return { ...scheduledGame, ...detailedGame };
        } catch {
          return cachedDetail?.game
            ? { ...scheduledGame, ...cachedDetail.game }
            : scheduledGame;
        }
      })
    );

    if (requestId === requestIdRef.current) {
      setGames(hydrated);
    }
  }

  async function loadSchedule({ refreshOddsOnly = false, forceSchedule = false } = {}) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const previousGames = games;

    setLoading(true);
    setOddsStatus("Loading odds...");

    if (!refreshOddsOnly) {
      setStatus(`Loading Week ${week}...`);
    }

    try {
      const cachedSchedule = forceSchedule ? null : readScheduleCache(SEASON, week);
      const shouldFetchSchedule = !refreshOddsOnly && (forceSchedule || !cachedSchedule);

      if (cachedSchedule && !refreshOddsOnly) {
        const mappedGames = mapCompatibleGames(cachedSchedule.games);
        setGames(mappedGames);
        hydrateScores(mappedGames, requestId);
        setStatus(`${mappedGames.length} games loaded for Week ${week}`);
      }

      const schedulePromise = shouldFetchSchedule
        ? getSchedule(SEASON, week, forceSchedule)
        : Promise.resolve(cachedSchedule);

      const [scheduleResult, oddsResult] = await Promise.allSettled([
        schedulePromise,
        getNflOdds(),
      ]);

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (shouldFetchSchedule) {
        if (scheduleResult.status === "rejected") {
          throw scheduleResult.reason;
        }

        writeScheduleCache(SEASON, week, scheduleResult.value);
        const mappedGames = mapCompatibleGames(scheduleResult.value?.games);
        setGames(mappedGames);
        setStatus(
          mappedGames.length > 0
            ? `${mappedGames.length} games loaded for Week ${week}`
            : `No games returned for Week ${week}`
        );
      }

      if (oddsResult.status === "fulfilled") {
        const loadedOdds = Array.isArray(oddsResult.value)
          ? oddsResult.value
          : [];
        setOddsEvents(loadedOdds);
        setOddsStatus(
          loadedOdds.length > 0
            ? `${loadedOdds.length} odds events loaded`
            : "No betting odds available"
        );
      } else {
        console.error("Odds loading failed", oddsResult.reason);
        setOddsStatus(
          oddsResult.reason instanceof Error
            ? oddsResult.reason.message
            : "Odds could not be loaded"
        );
      }
    } catch (error) {
      console.error("Schedule loading failed", error);

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (previousGames.length === 0) {
        setGames([]);
      }

      const message =
        error instanceof Error
          ? error.message
          : "The schedule could not be loaded";

      setStatus(
        previousGames.length > 0
          ? `Refresh failed: ${message}. Showing the last loaded schedule.`
          : message
      );
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadSchedule();
  }, [week]);

  useEffect(() => {
    const liveRefresh = window.setInterval(() => {
      loadSchedule({ forceSchedule: true });
    }, 30000);

    return () => window.clearInterval(liveRefresh);
  }, [week]);

  const normalizedFavoriteTeam = normalizeTeamCode(favoriteTeam);
  const visibleGames = viewMode === "favorite"
    ? games.filter((game) => game.away === normalizedFavoriteTeam || game.home === normalizedFavoriteTeam)
    : games;

  return (
    <section className="schedule-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{SEASON} REGULAR SEASON</span>
          <h1>Week {week} schedule</h1>
        </div>

        <span className="count-pill">{visibleGames.length} games</span>
      </div>

      <div className="schedule-controls">
        <div className="schedule-view-toggle" role="group" aria-label="Schedule view">
          <button type="button" className={viewMode === "favorite" ? "active" : ""} onClick={() => setViewMode("favorite")}>My team</button>
          <button type="button" className={viewMode === "all" ? "active" : ""} onClick={() => setViewMode("all")}>All games</button>
        </div>
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
          onClick={() => loadSchedule({ forceSchedule: true })}
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
        {status} · {oddsStatus}
      </div>

      {loading && visibleGames.length === 0 ? (
        <div className="card empty">
          <h2>Loading Week {week}</h2>
          <p>Retrieving the latest schedule and odds.</p>
        </div>
      ) : visibleGames.length === 0 ? (
        <div className="card empty">
          <h2>No games available</h2>
          <p>{viewMode === "favorite" ? `${TEAM_NAMES[normalizedFavoriteTeam] || normalizedFavoriteTeam} does not play in Week ${week}.` : `No compatible games were returned for Week ${week}.`}</p>
          <button type="button" className="primary" onClick={loadSchedule}>
            Try again
          </button>
        </div>
      ) : (
        <div className="game-grid">
          {visibleGames.map((game) => {
            const oddsEvent = findOddsForGame(oddsEvents, game);

            return (
              <GameCard
                key={game.id}
                game={{ ...game, oddsEvent }}
                onOpen={onOpen}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}


function getCurrentWeek() {
  // NFL weeks roll forward after the previous week's Monday night game.
  // Tuesday 8 September 2026 is the start of the Week 1 display window.
  const weekOneWindowStart = Date.UTC(2026, 8, 8, 0, 0, 0);
  const elapsed = Date.now() - weekOneWindowStart;
  const week = Math.floor(elapsed / (7 * 24 * 60 * 60 * 1000)) + 1;
  return Math.min(18, Math.max(1, week));
}

function getScheduleCacheKey(season, week) {
  return `${SCHEDULE_CACHE_PREFIX}:${season}:${week}`;
}

function readScheduleCache(season, week) {
  try {
    const raw = sessionStorage.getItem(getScheduleCacheKey(season, week));
    if (!raw) return null;

    const cached = JSON.parse(raw);
    if (
      !cached ||
      !Array.isArray(cached.games) ||
      Date.now() - Number(cached.savedAt || 0) > SCHEDULE_CACHE_TTL_MS
    ) {
      sessionStorage.removeItem(getScheduleCacheKey(season, week));
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

function writeScheduleCache(season, week, payload) {
  try {
    sessionStorage.setItem(
      getScheduleCacheKey(season, week),
      JSON.stringify({
        games: Array.isArray(payload?.games) ? payload.games : [],
        savedAt: Date.now(),
      })
    );
  } catch {
    // Session storage is optional. The schedule still works without it.
  }
}

function getSchedule(season, week, force = false) {
  const key = `${season}:${week}:${force ? "refresh" : "cached"}`;

  if (pendingScheduleRequests.has(key)) {
    return pendingScheduleRequests.get(key);
  }

  const request = fetch(
    `/api/nfl/schedule?season=${season}&week=${week}${force ? `&refresh=${Date.now()}` : ""}`,
    {
      cache: force ? "no-store" : "default",
      headers: {
        Accept: "application/json",
      },
    }
  )
    .then(async (response) => {
      const text = await response.text();
      let body = {};

      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          response.ok
            ? "The schedule endpoint returned invalid JSON"
            : text.slice(0, 200) ||
                `Schedule request failed (${response.status})`
        );
      }

      if (!response.ok) {
        throw new Error(extractErrorMessage(body, response.status));
      }

      return body;
    })
    .finally(() => {
      pendingScheduleRequests.delete(key);
    });

  pendingScheduleRequests.set(key, request);
  return request;
}

function extractErrorMessage(body, status) {
  const candidate =
    body?.error?.message ||
    body?.details ||
    body?.message ||
    body?.error;

  if (typeof candidate === "string" && candidate.trim()) {
    return candidate;
  }

  if (candidate && typeof candidate === "object") {
    try {
      return JSON.stringify(candidate);
    } catch {
      // Fall through to the status-based message.
    }
  }

  return `Schedule request failed (${status})`;
}

function mapCompatibleGames(apiGames) {
  return (Array.isArray(apiGames) ? apiGames : [])
    .map(mapGame)
    .filter(
      (game) =>
        game.away &&
        game.home &&
        TEAM_NAMES[game.away] &&
        TEAM_NAMES[game.home]
    );
}

function GameCard({ game, onOpen }) {
  const awayTheme = getTeamTheme(game.away);
  const homeTheme = getTeamTheme(game.home);
  const spreadInfo = getSpreadInfo(game.oddsEvent);
  const gameState = getGameState(game);
  const showScores = gameState !== "scheduled";

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
        <Team
          code={game.away}
          side="away"
          spread={spreadInfo.away}
          score={game.awayScore}
          showScore={showScores}
        />

        <div className="versus matchup-versus">
          <small>{getGameStatusLabel(game, gameState)}</small>
          <strong>{showScores ? "-" : "VS"}</strong>
        </div>

        <Team
          code={game.home}
          side="home"
          spread={spreadInfo.home}
          score={game.homeScore}
          showScore={showScores}
        />
      </div>

      <div className="venue matchup-venue">
        <MapPin size={15} />
        <span>{game.venue}</span>
        <strong>{gameState === "scheduled" ? "View matchup" : "View game"}</strong>
      </div>
    </button>
  );
}

function Team({ code, side, spread, score, showScore }) {
  return (
    <div className={`team matchup-team matchup-team-${side}`}>
      <span className="matchup-logo-stage">
        <TeamLogo team={code} size={95} />
      </span>

      <strong>{TEAM_NAMES[code] || code}</strong>

      <small className="team-spread" style={showScore ? { fontSize: "2.5rem", fontWeight: 800, lineHeight: 1 } : undefined}>{showScore ? score ?? 0 : spread}</small>
    </div>
  );
}

function getGameState(game) {
  const status = String(game.status || "").trim().toLowerCase();

  if (
    status.includes("final") ||
    status.includes("completed") ||
    status === "complete" ||
    status === "closed"
  ) {
    return "final";
  }

  if (
    status.includes("progress") ||
    status.includes("live") ||
    status.includes("quarter") ||
    status.includes("halftime") ||
    status === "1st" ||
    status === "2nd" ||
    status === "3rd" ||
    status === "4th" ||
    status === "ot"
  ) {
    return "live";
  }

  const hasScores =
    game.awayScore !== null &&
    game.awayScore !== undefined &&
    game.homeScore !== null &&
    game.homeScore !== undefined;
  const kickoff = new Date(game.sourceDate);
  const kickoffTime = kickoff.getTime();
  const now = Date.now();

  // Some upstream game records keep returning "Scheduled" after the game has
  // finished. Scores shortly after kickoff mean the game is live. Scores more
  // than six hours after kickoff mean the game is final, regardless of the
  // stale status string.
  if (hasScores && Number.isFinite(kickoffTime) && kickoffTime <= now) {
    return now >= kickoffTime + 6 * 60 * 60 * 1000 ? "final" : "live";
  }

  return "scheduled";
}

function getGameStatusLabel(game, gameState) {
  if (gameState === "final") return "FINAL";
  if (gameState === "live") return String(game.status || "LIVE").toUpperCase();
  return game.time;
}

function getSpreadInfo(event) {
  const emptySpread = {
    away: "-",
    home: "-",
    favourite: null,
  };

  if (!event?.bookmakers?.length) {
    return emptySpread;
  }

  const bookmaker = selectBookmaker(event);
  const spreadMarket = bookmaker?.markets?.find(
    (market) => market.key === "spreads"
  );

  if (!spreadMarket?.outcomes?.length) {
    return emptySpread;
  }

  const awayOutcome = findOutcome(spreadMarket, event.away_team);
  const homeOutcome = findOutcome(spreadMarket, event.home_team);
  const awayPoint = toNumberOrNull(awayOutcome?.point);
  const homePoint = toNumberOrNull(homeOutcome?.point);

  return {
    away: formatSpread(awayPoint),
    home: formatSpread(homePoint),
    favourite:
      awayPoint !== null && homePoint !== null
        ? awayPoint < homePoint
          ? "away"
          : homePoint < awayPoint
            ? "home"
            : null
        : null,
  };
}

function selectBookmaker(event) {
  const preferredBookmakers = [
    "draftkings",
    "fanduel",
    "caesars",
    "betmgm",
  ];

  for (const key of preferredBookmakers) {
    const bookmaker = event.bookmakers.find((item) => item.key === key);

    if (bookmaker) {
      return bookmaker;
    }
  }

  return event.bookmakers[0];
}

function findOutcome(market, teamName) {
  return market.outcomes.find(
    (outcome) => normalizeName(outcome.name) === normalizeName(teamName)
  );
}

function formatSpread(value) {
  if (value === null) {
    return "-";
  }

  return value > 0 ? `+${value}` : `${value}`;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
    awayName: TEAM_NAMES[away] || apiGame.visitor_team?.full_name || away,
    homeName: TEAM_NAMES[home] || apiGame.home_team?.full_name || home,
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
    venue: getGameVenue(apiGame),
    status: apiGame.status || apiGame.status_state || "Scheduled",
    awayScore: apiGame.visitor_team_score ?? null,
    homeScore: apiGame.home_team_score ?? null,
  };
}

function getGameVenue(apiGame) {
  const candidates = [
    apiGame?.venue,
    apiGame?.venue_name,
    apiGame?.stadium,
    apiGame?.stadium_name,
    apiGame?.location,
    apiGame?.competition?.venue?.fullName,
    apiGame?.competition?.venue?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const name = candidate.full_name || candidate.fullName || candidate.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return "Venue unavailable";
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
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
