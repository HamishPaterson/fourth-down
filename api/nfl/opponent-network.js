const GAMES_URL =
  "https://api.balldontlie.io/nfl/v1/games";

const TEAM_ALIASES = {
  WAS: "WSH",
  LA: "LAR",
  JAC: "JAX",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

const RECENT_GAME_LIMIT = 4;
const MAX_ADJUSTMENT = 1;
const ITERATIONS = 30;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey =
    process.env.BALLDONTLIE_API_KEY;

  const season =
    Number(req.query.season);

  const week =
    Number(req.query.week);

  const away =
    normalizeTeam(req.query.away);

  const home =
    normalizeTeam(req.query.home);

  if (!apiKey) {
    return res.status(500).json({
      error:
        "BALLDONTLIE_API_KEY is not configured",
    });
  }

  if (
    !Number.isInteger(season) ||
    !Number.isInteger(week) ||
    !away ||
    !home
  ) {
    return res.status(400).json({
      error:
        "season, week, away and home are required",
    });
  }

  if (week <= 1) {
    return sendNeutral(
      res,
      season,
      week,
      away,
      home,
      "No completed current-season games are available yet"
    );
  }

  try {
    const sourceGames =
      await fetchSeasonGames(
        apiKey,
        season
      );

    const games = sourceGames
      .filter(
        (game) =>
          isCompleted(game) &&
          Number(game.week) < week &&
          game.postseason !== true
      )
      .map(normalizeGame)
      .filter(
        (game) =>
          game.away &&
          game.home &&
          Number.isFinite(
            game.awayScore
          ) &&
          Number.isFinite(
            game.homeScore
          )
      );

    if (!games.length) {
      return sendNeutral(
        res,
        season,
        week,
        away,
        home,
        "No completed games are available for the target week"
      );
    }

    const ratings =
      solveOpponentNetwork(
        games,
        week
      );

    const awayRating =
      ratings[away] ||
      createNeutralRating();

    const homeRating =
      ratings[home] ||
      createNeutralRating();

    const commonOpponents =
      findCommonOpponents(
        games,
        away,
        home,
        ratings,
        week
      );

    const commonOpponentEdge =
      calculateCommonOpponentEdge(
        commonOpponents
      );

    const ratingDifference =
      homeRating.overall -
      awayRating.overall;

    const networkDifference =
      clamp(
        ratingDifference +
          commonOpponentEdge,
        -6,
        6
      );

    const minimumGames =
      Math.min(
        awayRating.games,
        homeRating.games
      );

    const gameConfidence =
      clamp(
        minimumGames /
          RECENT_GAME_LIMIT,
        0,
        1
      );

    const commonOpponentConfidence =
      clamp(
        commonOpponents.length / 3,
        0,
        1
      );

    const confidence =
      clamp(
        gameConfidence * 0.8 +
          commonOpponentConfidence *
            0.2,
        0.15,
        0.9
      );

    const rawHomePoints =
      clamp(
        networkDifference / 2,
        -MAX_ADJUSTMENT,
        MAX_ADJUSTMENT
      );

    const homePoints =
      clamp(
        rawHomePoints *
          confidence,
        -MAX_ADJUSTMENT,
        MAX_ADJUSTMENT
      );

    const awayPoints =
      -homePoints;

    const reasons =
      buildReasons({
        away,
        home,
        homePoints,
        commonOpponents,
        minimumGames,
      });

    res.setHeader(
      "Cache-Control",
      [
        "public",
        "s-maxage=1800",
        "stale-while-revalidate=21600",
        "stale-if-error=21600",
      ].join(", ")
    );

    return res.status(200).json({
      season,
      week,
      away,
      home,

      source:
        "BALLDONTLIE completed games",

      methodology:
        "Iterative opponent-adjusted scoring network",

      ratings,

      commonOpponents,

      modelLayer: {
        active:
          Math.abs(homePoints) >
          0.01,

        available: true,

        awayPoints:
          round(awayPoints),

        homePoints:
          round(homePoints),

        rawAwayPoints:
          round(
            -rawHomePoints
          ),

        rawHomePoints:
          round(rawHomePoints),

        confidence:
          round(confidence),

        gamesUsed:
          games.length,

        commonOpponents:
          commonOpponents.length,

        reasons,
      },

      gamesUsed:
        games.length,

      dataStatus:
        "available",

      refreshedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "Opponent network failed",
      error
    );

    return sendNeutral(
      res,
      season,
      week,
      away,
      home,
      error instanceof Error
        ? error.message
        : "Opponent network request failed"
    );
  }
}

async function fetchSeasonGames(
  apiKey,
  season
) {
  const games = [];

  let cursor = null;
  let requestCount = 0;

  do {
    const url =
      new URL(GAMES_URL);

    url.searchParams.set(
      "seasons[]",
      String(season)
    );

    url.searchParams.set(
      "per_page",
      "100"
    );

    if (cursor !== null) {
      url.searchParams.set(
        "cursor",
        String(cursor)
      );
    }

    const response =
      await fetch(
        url.toString(),
        {
          headers: {
            Authorization:
              apiKey,
          },
        }
      );

    const body =
      await response.json();

    if (!response.ok) {
      throw new Error(
        body?.error ||
          body?.message ||
          `Games request failed (${response.status})`
      );
    }

    const pageGames =
      Array.isArray(body?.data)
        ? body.data
        : [];

    games.push(
      ...pageGames
    );

    cursor =
      body?.meta?.next_cursor ??
      null;

    requestCount += 1;
  } while (
    cursor !== null &&
    requestCount < 20
  );

  return games;
}

function solveOpponentNetwork(
  games,
  targetWeek
) {
  const teams = [
    ...new Set(
      games.flatMap(
        (game) => [
          game.away,
          game.home,
        ]
      )
    ),
  ];

  let offense =
    Object.fromEntries(
      teams.map(
        (team) => [
          team,
          0,
        ]
      )
    );

  let defense =
    Object.fromEntries(
      teams.map(
        (team) => [
          team,
          0,
        ]
      )
    );

  for (
    let iteration = 0;
    iteration < ITERATIONS;
    iteration += 1
  ) {
    const nextOffense = {};
    const nextDefense = {};

    for (const team of teams) {
      const recentGames =
        getRecentTeamGames(
          games,
          team
        );

      const offensiveEntries = [];
      const defensiveEntries = [];

      for (
        const game of
        recentGames
      ) {
        const isHome =
          game.home === team;

        const opponent =
          isHome
            ? game.away
            : game.home;

        const scored =
          isHome
            ? game.homeScore
            : game.awayScore;

        const allowed =
          isHome
            ? game.awayScore
            : game.homeScore;

        const weight =
          recencyWeight(
            game.week,
            targetWeek
          ) *
          volatilityWeight(
            Math.abs(
              game.homeScore -
              game.awayScore
            )
          );

        offensiveEntries.push({
          value:
            scored -
            22 +
            (defense[opponent] ||
              0),

          weight,
        });

        defensiveEntries.push({
          value:
            22 -
            allowed +
            (offense[opponent] ||
              0),

          weight,
        });
      }

      nextOffense[team] =
        weightedAverage(
          offensiveEntries
        );

      nextDefense[team] =
        weightedAverage(
          defensiveEntries
        );
    }

    offense =
      centerRatings(
        nextOffense
      );

    defense =
      centerRatings(
        nextDefense
      );
  }

  return Object.fromEntries(
    teams.map((team) => {
      const teamGames =
        getRecentTeamGames(
          games,
          team
        );

      const scheduleStrength =
        average(
          teamGames.map(
            (game) => {
              const opponent =
                game.home === team
                  ? game.away
                  : game.home;

              return (
                (offense[
                  opponent
                ] || 0) +
                (defense[
                  opponent
                ] || 0)
              );
            }
          )
        );

      return [
        team,
        {
          offense:
            round(
              offense[team]
            ),

          defense:
            round(
              defense[team]
            ),

          overall:
            round(
              offense[team] +
                defense[team]
            ),

          scheduleStrength:
            round(
              scheduleStrength
            ),

          games:
            teamGames.length,
        },
      ];
    })
  );
}

function getRecentTeamGames(
  games,
  team
) {
  return games
    .filter(
      (game) =>
        game.away === team ||
        game.home === team
    )
    .sort(
      (first, second) =>
        second.week -
        first.week
    )
    .slice(
      0,
      RECENT_GAME_LIMIT
    );
}

function findCommonOpponents(
  games,
  away,
  home,
  ratings,
  targetWeek
) {
  const awayOpponents =
    getOpponentSet(
      games,
      away
    );

  const homeOpponents =
    getOpponentSet(
      games,
      home
    );

  return [
    ...awayOpponents,
  ]
    .filter(
      (opponent) =>
        homeOpponents.has(
          opponent
        ) &&
        opponent !== away &&
        opponent !== home
    )
    .map((opponent) => ({
      team:
        opponent,

      awayPerformance:
        round(
          teamPerformanceAgainst(
            games,
            away,
            opponent,
            ratings,
            targetWeek
          )
        ),

      homePerformance:
        round(
          teamPerformanceAgainst(
            games,
            home,
            opponent,
            ratings,
            targetWeek
          )
        ),
    }));
}

function getOpponentSet(
  games,
  team
) {
  return new Set(
    games
      .filter(
        (game) =>
          game.away === team ||
          game.home === team
      )
      .map((game) =>
        game.away === team
          ? game.home
          : game.away
      )
  );
}

function teamPerformanceAgainst(
  games,
  team,
  opponent,
  ratings,
  targetWeek
) {
  const matches =
    games.filter(
      (game) =>
        [
          game.away,
          game.home,
        ].includes