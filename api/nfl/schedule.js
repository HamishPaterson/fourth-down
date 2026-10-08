const API_URL =
  "https://api.balldontlie.io/nfl/v1/games";

const REQUEST_TIMEOUT_MS = 10000;
const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const TEAM_ALIASES = {
  WAS: "WSH",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

const NFL_DIVISIONS = {
  "AFC East": ["BUF", "MIA", "NE", "NYJ"],
  "AFC North": ["BAL", "CIN", "CLE", "PIT"],
  "AFC South": ["HOU", "IND", "JAX", "TEN"],
  "AFC West": ["DEN", "KC", "LV", "LAC"],
  "NFC East": ["DAL", "NYG", "PHI", "WSH"],
  "NFC North": ["CHI", "DET", "GB", "MIN"],
  "NFC South": ["ATL", "CAR", "NO", "TB"],
  "NFC West": ["ARI", "LAR", "SF", "SEA"],
};

const TEAM_DIVISION = Object.fromEntries(
  Object.entries(NFL_DIVISIONS).flatMap(
    ([division, teams]) =>
      teams.map((team) => [team, division])
  )
);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey =
    process.env.BALLDONTLIE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error:
        "BALLDONTLIE_API_KEY is not configured",
    });
  }

  const season = Number(
    req.query.season || 2026
  );

  const week = Number(
    req.query.week || 1
  );

  if (
    !Number.isInteger(season) ||
    season < 2002
  ) {
    return res.status(400).json({
      error: "Invalid season",
    });
  }

  if (
    !Number.isInteger(week) ||
    week < 1 ||
    week > 22
  ) {
    return res.status(400).json({
      error: "Invalid week",
    });
  }

  try {
    const resultsMode = String(req.query.results || "") === "1";
    const games = resultsMode
      ? await fetchResultsGames(apiKey, season, week)
      : await fetchScheduleGames(apiKey, season, week);

    if (resultsMode) {
      res.setHeader(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate, max-age=0"
      );
      res.setHeader("CDN-Cache-Control", "private, no-store");
      res.setHeader("Vercel-CDN-Cache-Control", "private, no-store");
    } else {
      res.setHeader(
        "Cache-Control",
        "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=3600"
      );
      res.setHeader("CDN-Cache-Control", "public, s-maxage=60");
      res.setHeader(
        "Vercel-CDN-Cache-Control",
        "public, s-maxage=60, stale-while-revalidate=300"
      );
    }

    return res.status(200).json({
      season,
      week,
      count: games.length,
      games,
      refreshedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "Schedule request failed:",
      error
    );

    return res
      .status(Number(error?.status) || 502)
      .json({
        error:
          "Failed to retrieve the NFL schedule",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      });
  }
}

async function fetchScheduleGames(apiKey, season, week) {
  const [primaryResult, fallbackResult] = await Promise.allSettled([
    fetchWeekGames(apiKey, season, week, false),
    fetchEspnWeekGames(season, week),
  ]);

  const primary =
    primaryResult.status === "fulfilled"
      ? primaryResult.value
      : [];
  const fallback =
    fallbackResult.status === "fulfilled"
      ? fallbackResult.value
      : [];

  if (!primary.length && !fallback.length) {
    const error =
      primaryResult.status === "rejected"
        ? primaryResult.reason
        : fallbackResult.status === "rejected"
          ? fallbackResult.reason
          : new Error("No schedule data returned");
    throw error;
  }

  return mergeResultGames(primary, fallback);
}

async function fetchResultsGames(apiKey, season, week) {
  const [primaryResult, fallbackResult] = await Promise.allSettled([
    fetchWeekGames(apiKey, season, week, true),
    fetchEspnWeekGames(season, week),
  ]);

  const primary = primaryResult.status === "fulfilled" ? primaryResult.value : [];
  const fallback = fallbackResult.status === "fulfilled" ? fallbackResult.value : [];

  if (!primary.length && !fallback.length) {
    const error = primaryResult.status === "rejected"
      ? primaryResult.reason
      : fallbackResult.status === "rejected"
        ? fallbackResult.reason
        : new Error("No result data returned");
    throw error;
  }

  return mergeResultGames(primary, fallback);
}

async function fetchEspnWeekGames(season, week) {
  const params = new URLSearchParams({
    limit: "100",
    dates: String(season),
    seasontype: "2",
    week: String(week),
    refresh: String(Date.now()),
  });

  const response = await fetchWithTimeout(
    `${ESPN_SCOREBOARD_URL}?${params.toString()}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }
  );

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(`ESPN returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return (Array.isArray(body.events) ? body.events : [])
    .map((event) => normalizeEspnEvent(event, week))
    .filter(Boolean);
}

function normalizeEspnEvent(event, week) {
  const competition = event.competitions?.[0];
  const competitors = Array.isArray(competition?.competitors)
    ? competition.competitors
    : [];
  const away = competitors.find((item) => item.homeAway === "away");
  const home = competitors.find((item) => item.homeAway === "home");

  if (!away || !home) return null;

  return {
    id: `espn-${event.id}`,
    date: event.date,
    week,
    postseason: false,
    status: event.status?.type?.description || event.status?.type?.name || "",
    status_state: event.status?.type?.state || "",
    visitor_team: {
      abbreviation: normalizeTeamCode(away.team?.abbreviation),
      name: away.team?.displayName || away.team?.name || "",
    },
    home_team: {
      abbreviation: normalizeTeamCode(home.team?.abbreviation),
      name: home.team?.displayName || home.team?.name || "",
    },
    visitor_team_score: scoreOrNull(away.score),
    home_team_score: scoreOrNull(home.score),
    completed: Boolean(event.status?.type?.completed),
    venue:
      competition?.venue?.fullName ||
      competition?.venue?.name ||
      event?.venue?.fullName ||
      event?.venue?.name ||
      null,
    source: "espn-fallback",
    scheduleContext: buildNeutralScheduleContext({
      visitor_team: { abbreviation: normalizeTeamCode(away.team?.abbreviation) },
      home_team: { abbreviation: normalizeTeamCode(home.team?.abbreviation) },
    }),
  };
}

function mergeResultGames(primary, fallback) {
  const merged = new Map();

  for (const game of [...primary, ...fallback]) {
    const key = getGameMergeKey(game);
    if (!key) continue;

    const normalized = normalizeMergedGame(game);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeGameRecords(existing, normalized) : normalized);
  }

  return [...merged.values()].sort(
    (first, second) => new Date(first.date) - new Date(second.date)
  );
}

function getGameMergeKey(game) {
  const away = getTeamCode(game, "away");
  const home = getTeamCode(game, "home");
  const week = Number(game.week);
  if (!away || !home || !Number.isInteger(week)) return null;
  return `${away}:${home}:${week}`;
}

function normalizeMergedGame(game) {
  return {
    ...game,
    venue: getVenue(game),
    completed: isCompletedGame(game),
  };
}

function mergeGameRecords(first, second) {
  const preferred = resultCompleteness(second) > resultCompleteness(first)
    ? second
    : first;
  const other = preferred === first ? second : first;

  const merged = {
    ...other,
    ...preferred,
    id: String(first.id || second.id),
    date: preferred.date || other.date,
    week: Number(preferred.week || other.week),
    visitor_team: mergeTeam(
      first.visitor_team || first.away_team,
      second.visitor_team || second.away_team
    ),
    home_team: mergeTeam(first.home_team, second.home_team),
    visitor_team_score:
      getGameScore(preferred, "away") ?? getGameScore(other, "away"),
    home_team_score:
      getGameScore(preferred, "home") ?? getGameScore(other, "home"),
    venue: getVenue(preferred) || getVenue(other),
    completed: isCompletedGame(first) || isCompletedGame(second),
    source:
      first.source && second.source && first.source !== second.source
        ? `${first.source}+${second.source}`
        : first.source || second.source,
  };

  merged.scheduleContext =
    preferred.scheduleContext ||
    other.scheduleContext ||
    buildNeutralScheduleContext(merged);

  return merged;
}

function mergeTeam(first = {}, second = {}) {
  return {
    ...first,
    ...second,
    abbreviation: normalizeTeamCode(
      second.abbreviation || second.abbr || second.code ||
      first.abbreviation || first.abbr || first.code
    ),
    name:
      second.name || second.display_name || second.displayName ||
      first.name || first.display_name || first.displayName || "",
    full_name:
      second.full_name || second.fullName ||
      first.full_name || first.fullName || "",
  };
}

function getVenue(game) {
  const candidates = [
    game?.venue,
    game?.venue_name,
    game?.stadium,
    game?.stadium_name,
    game?.location,
    game?.competition?.venue?.fullName,
    game?.competition?.venue?.name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      const name =
        candidate.full_name || candidate.fullName || candidate.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }

  return null;
}

function isCompletedGame(game) {
  if (game?.completed === true) return true;
  const status = String(
    game?.status || game?.status_state || game?.state || ""
  ).toLowerCase();
  return (
    status.includes("final") ||
    status.includes("complete") ||
    status.includes("closed") ||
    status === "post"
  );
}

function getGameScore(game, side) {
  return scoreOrNull(
    side === "away"
      ? game?.visitor_team_score ?? game?.away_team_score ?? game?.away_score
      : game?.home_team_score ?? game?.home_score
  );
}

function resultCompleteness(game) {
  let value = 0;
  if (isCompletedGame(game)) value += 20;
  if (getGameScore(game, "home") != null) value += 4;
  if (getGameScore(game, "away") != null) value += 4;
  if (getVenue(game)) value += 2;
  if (hasValidDate(game?.date)) value += 1;
  return value;
}

function scoreOrNull(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}


async function fetchWeekGames(
  apiKey,
  season,
  week,
  noStore = false
) {
  const games = [];
  let cursor = null;

  do {
    const params =
      new URLSearchParams();

    params.append(
      "seasons[]",
      String(season)
    );

    params.append(
      "weeks[]",
      String(week)
    );

    params.set(
      "per_page",
      "100"
    );

    if (cursor !== null) {
      params.set(
        "cursor",
        String(cursor)
      );
    }

    const response =
      await fetchWithTimeout(
        `${API_URL}?${params.toString()}${noStore ? `&refresh=${Date.now()}` : ""}`,
        {
          cache: noStore ? "no-store" : "default",
          headers: {
            Authorization: apiKey,
            Accept: "application/json",
          },
        }
      );

    const body =
      await readJsonResponse(response);

    if (!response.ok) {
      const error = new Error(
        getErrorMessage(
          body,
          response.status
        )
      );

      error.status =
        response.status;

      throw error;
    }

    games.push(
      ...(Array.isArray(body.data)
        ? body.data
        : [])
    );

    cursor =
      body.meta?.next_cursor ?? null;
  } while (cursor !== null);

  return games
    .filter(
      (game) =>
        game.postseason !== true
    )
    .filter(
      (game) =>
        Number(game.week) === week
    )
    .filter(
      (game) =>
        hasValidDate(game.date)
    )
    .sort(
      (first, second) =>
        new Date(first.date) -
        new Date(second.date)
    )
    .map((game) => ({
      ...game,
      scheduleContext:
        buildNeutralScheduleContext(game),
    }));
}

async function fetchWithTimeout(
  url,
  options
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      const timeoutError =
        new Error(
          "BALLDONTLIE schedule request timed out"
        );

      timeoutError.status = 504;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildNeutralScheduleContext(
  game
) {
  const awayCode =
    getTeamCode(game, "away");

  const homeCode =
    getTeamCode(game, "home");

  const awayDivision =
    TEAM_DIVISION[awayCode] || null;

  const homeDivision =
    TEAM_DIVISION[homeCode] || null;

  const isDivisional = Boolean(
    awayDivision &&
      homeDivision &&
      awayDivision === homeDivision
  );

  return {
    away: createTeamContext(
      awayCode,
      true
    ),

    home: createTeamContext(
      homeCode,
      false
    ),

    restDifferential: null,

    isDivisional,

    division: isDivisional
      ? awayDivision
      : null,

    meetingNumber: isDivisional
      ? 1
      : 0,

    previousMeeting: null,

    previousMeetingMargin: null,
  };
}

function createTeamContext(
  team,
  currentGameIsAway
) {
  return {
    team,

    previousGame: null,

    nextGame: null,

    daysRest: null,

    shortWeek: false,

    normalRest: false,

    extendedRest: false,

    likelyByeWeek: false,

    currentGameIsAway,

    consecutiveRoadGamesEntering: 0,

    consecutiveRoadGamesIncludingCurrent:
      currentGameIsAway ? 1 : 0,
  };
}

function getTeamCode(
  game,
  side
) {
  const team =
    side === "away"
      ? game?.visitor_team ||
        game?.away_team ||
        game?.away ||
        {}
      : game?.home_team ||
        game?.home ||
        {};

  const rawCode =
    team.abbreviation ||
    team.abbr ||
    team.code ||
    game?.[
      `${side}_team_abbreviation`
    ] ||
    game?.[
      `${side}_team_code`
    ] ||
    "";

  return normalizeTeamCode(rawCode);
}

function normalizeTeamCode(code) {
  const normalized =
    String(code || "")
      .trim()
      .toUpperCase();

  return (
    TEAM_ALIASES[normalized] ||
    normalized
  );
}

function hasValidDate(value) {
  return !Number.isNaN(
    new Date(value).getTime()
  );
}

function getErrorMessage(
  body,
  status
) {
  const candidate =
    body?.error?.message ||
    body?.details ||
    body?.message ||
    body?.error;

  if (typeof candidate === "string") {
    return candidate;
  }

  if (
    candidate &&
    typeof candidate === "object"
  ) {
    try {
      return JSON.stringify(candidate);
    } catch {
      return `BALLDONTLIE returned HTTP ${status}`;
    }
  }

  return `BALLDONTLIE returned HTTP ${status}`;
}

async function readJsonResponse(
  response
) {
  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      error:
        text.slice(0, 300) ||
        "Invalid upstream response",
    };
  }
}