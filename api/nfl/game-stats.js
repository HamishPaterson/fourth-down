import { createClient } from "@supabase/supabase-js";
import NFLVERSE_PLAYER_METRICS from "../../data/nflverse-player-metrics.js";

const STATS_URL =
  "https://api.balldontlie.io/nfl/v1/stats";

const GAMES_URL =
  "https://api.balldontlie.io/nfl/v1/games";

const LEAGUE_PRIOR = 22;
const PRIOR_GAMES = 4;

const RECENCY_WEIGHTS = [0.75, 0.85, 0.95, 1];

const TEAM_ALIASES = {
  WAS: "WSH",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

export default async function handler(req, res) {
  if (String(req.query?.action || "").toLowerCase() === "player-metrics") {
    return handlePlayerMetrics(req, res);
  }
  if (String(req.query?.action || "").toLowerCase() === "predictions") {
    return handlePredictionLedger(req, res);
  }

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

  try {
    const gameId = Number(req.query.id);

    if (
      Number.isInteger(gameId) &&
      gameId > 0
    ) {
      const records = await fetchStats(
        apiKey,
        [gameId]
      );

      return res.status(200).json({
        gameId,
        recordCount: records.length,
        teams: aggregateTeamStats(records),
        refreshedAt:
          new Date().toISOString(),
      });
    }

    const away = normalizeTeamCode(
      req.query.away
    );

    const home = normalizeTeamCode(
      req.query.home
    );

    const season = Number(
      req.query.season
    );

    const week = Number(
      req.query.week
    );

    if (
      !away ||
      !home ||
      !Number.isInteger(season) ||
      !Number.isInteger(week)
    ) {
      return res.status(400).json({
        error:
          "Provide either a valid game id or season, week, away and home",
      });
    }

    if (week <= 1) {
      return sendNeutralResponse(
        res,
        season,
        week,
        away,
        home
      );
    }

    const seasonGames =
      await fetchSeasonGames(
        apiKey,
        season
      );

    const completedGames =
      seasonGames.filter(
        (game) =>
          isCompletedGame(game) &&
          Number(game.week) < week &&
          game.postseason !== true
      );

    const awayGames = getTeamGames(
      completedGames,
      away
    );

    const homeGames = getTeamGames(
      completedGames,
      home
    );

    if (
      !awayGames.length ||
      !homeGames.length
    ) {
      return sendNeutralResponse(
        res,
        season,
        week,
        away,
        home
      );
    }

    const recentGames =
      getUniqueGames([
        ...awayGames.slice(-4),
        ...homeGames.slice(-4),
      ]);

    const records = await fetchStats(
      apiKey,
      recentGames.map(
        (game) => game.id
      )
    );

    const recordsByGame =
      groupRecordsByGame(records);

    const awayForm = buildTeamForm(
      away,
      awayGames.slice(-4),
      recordsByGame
    );

    const homeForm = buildTeamForm(
      home,
      homeGames.slice(-4),
      recordsByGame
    );

    const leagueAverage =
      getDynamicLeagueAverage(
        completedGames
      );

    const scoringBaseline =
      buildScoringBaseline(
        away,
        home,
        awayGames,
        homeGames,
        completedGames,
        leagueAverage
      );

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=900, stale-while-revalidate=3600"
    );

    return res.status(200).json({
      season,
      week,
      leagueAverage,
      away: awayForm,
      home: homeForm,

      modelLayers: {
        scoringBaseline,

        ...compareForms(
          awayForm,
          homeForm
        ),
      },

      sampleGames:
        recentGames.length,

      refreshedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    const requestedGameId = Number(req.query.id);
    if (Number.isInteger(requestedGameId) && requestedGameId > 0) {
      return res.status(200).json({
        gameId: requestedGameId,
        recordCount: 0,
        teams: {},
        available: false,
        message: "Live player statistics are not available from the current data plan.",
        refreshedAt: new Date().toISOString(),
      });
    }

    const fallbackAway = normalizeTeamCode(req.query.away);
    const fallbackHome = normalizeTeamCode(req.query.home);
    const fallbackSeason = Number(req.query.season);
    const fallbackWeek = Number(req.query.week);
    if (fallbackAway && fallbackHome && Number.isInteger(fallbackSeason) && Number.isInteger(fallbackWeek)) {
      res.setHeader("X-Fourth-Down-Data-Status", "neutral-fallback");
      return sendNeutralResponse(res, fallbackSeason, fallbackWeek, fallbackAway, fallbackHome);
    }
    return res.status(Number(error?.status) || 500).json({
      error: error instanceof Error ? error.message : String(error),
      details: "NFL statistics request failed",
    });
  }
}

function handlePlayerMetrics(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const season = Number(req.query.season || NFLVERSE_PLAYER_METRICS.season);
  const requestedWeek = Number(req.query.week);
  const away = normalizeTeamCode(req.query.away);
  const home = normalizeTeamCode(req.query.home);
  if (!away || !home || !Number.isInteger(requestedWeek)) {
    return res.status(400).json({ error: "Provide season, week, away and home" });
  }
  const availableWeeks = Object.keys(NFLVERSE_PLAYER_METRICS.playerMetricsByWeek || {})
    .map(Number)
    .filter((week) => Number.isInteger(week) && week <= requestedWeek)
    .sort((first, second) => second - first);
  const selectedWeek = availableWeeks[0] || null;
  const weekMetrics = selectedWeek
    ? NFLVERSE_PLAYER_METRICS.playerMetricsByWeek?.[selectedWeek] || {}
    : {};
  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
  return res.status(200).json({
    available: Boolean(selectedWeek && weekMetrics[away] && weekMetrics[home]),
    season,
    requestedWeek,
    metricsWeek: selectedWeek,
    generatedAt: NFLVERSE_PLAYER_METRICS.generatedAt,
    source: NFLVERSE_PLAYER_METRICS.source,
    away: weekMetrics[away] || null,
    home: weekMetrics[home] || null,
  });
}

function sendNeutralResponse(
  res,
  season,
  week,
  away,
  home
) {
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=900, stale-while-revalidate=3600"
  );

  return res.status(200).json({
    season,
    week,
    leagueAverage:
      LEAGUE_PRIOR,

    away:
      createNeutralForm(away),

    home:
      createNeutralForm(home),

    modelLayers:
      createNeutralLayers(),

    sampleGames: 0,

    refreshedAt:
      new Date().toISOString(),
  });
}

async function fetchSeasonGames(
  apiKey,
  season
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

    const body = await getJson(
      `${GAMES_URL}?${params.toString()}`,
      apiKey
    );

    games.push(
      ...(body.data || [])
    );

    cursor =
      body.meta?.next_cursor ??
      null;
  } while (cursor !== null);

  return games;
}

async function fetchStats(
  apiKey,
  gameIds
) {
  if (!gameIds.length) {
    return [];
  }

  const records = [];
  let cursor = null;

  do {
    const params =
      new URLSearchParams();

    for (const gameId of gameIds) {
      params.append(
        "game_ids[]",
        String(gameId)
      );
    }

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

    const body = await getJson(
      `${STATS_URL}?${params.toString()}`,
      apiKey
    );

    records.push(
      ...(body.data || [])
    );

    cursor =
      body.meta?.next_cursor ??
      null;
  } while (cursor !== null);

  return records;
}

async function getJson(
  url,
  apiKey
) {
  const response = await fetch(
    url,
    {
      headers: {
        Authorization: apiKey,
        Accept: "application/json",
      },
    }
  );

  const responseText =
    await response.text();

  let body;

  try {
    body = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    body = {
      error:
        responseText ||
        "Invalid upstream response",
    };
  }

  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : `BALLDONTLIE returned HTTP ${response.status}`;

    const error =
      new Error(message);

    error.status =
      response.status;

    throw error;
  }

  return body;
}

function buildScoringBaseline(
  away,
  home,
  awayGames,
  homeGames,
  leagueGames,
  leagueAverage
) {
  const leagueScores =
    leagueGames.flatMap(
      (game) => [
        getGameScore(
          game,
          "away"
        ),

        getGameScore(
          game,
          "home"
        ),
      ]
    );

  const lowerBoundary =
    calculatePercentile(
      leagueScores,
      0.1,
      7
    );

  const upperBoundary =
    calculatePercentile(
      leagueScores,
      0.9,
      38
    );

  const awayOffensiveAverage =
    regressAverage(
      calculateWeightedAverage(
        awayGames,
        away,
        true,
        lowerBoundary,
        upperBoundary
      ),
      awayGames.length,
      leagueAverage
    );

  const homeOffensiveAverage =
    regressAverage(
      calculateWeightedAverage(
        homeGames,
        home,
        true,
        lowerBoundary,
        upperBoundary
      ),
      homeGames.length,
      leagueAverage
    );

  const awayDefensiveAverage =
    regressAverage(
      calculateWeightedAverage(
        awayGames,
        away,
        false,
        lowerBoundary,
        upperBoundary
      ),
      awayGames.length,
      leagueAverage
    );

  const homeDefensiveAverage =
    regressAverage(
      calculateWeightedAverage(
        homeGames,
        home,
        false,
        lowerBoundary,
        upperBoundary
      ),
      homeGames.length,
      leagueAverage
    );

  const awayMatchupBaseline =
    awayOffensiveAverage *
      0.55 +
    homeDefensiveAverage *
      0.45;

  const homeMatchupBaseline =
    homeOffensiveAverage *
      0.55 +
    awayDefensiveAverage *
      0.45;

  const minimumSample =
    Math.min(
      awayGames.length,
      homeGames.length
    );

  return {
    active: true,

    awayPoints: 0,
    homePoints: 0,

    awayExpected:
      roundThree(
        awayMatchupBaseline
      ),

    homeExpected:
      roundThree(
        homeMatchupBaseline
      ),

    leagueAverage:
      roundThree(
        leagueAverage
      ),

    gamesUsed: {
      away: awayGames.length,
      home: homeGames.length,
    },

    confidence: clamp(
      minimumSample / 8,
      0.2,
      0.8
    ),

    reasons: [
      "Winsorised, recency-weighted current-season scoring against opponent points allowed",
    ],
  };
}

function getDynamicLeagueAverage(
  games
) {
  const scores =
    games.flatMap(
      (game) => [
        getGameScore(
          game,
          "away"
        ),

        getGameScore(
          game,
          "home"
        ),
      ]
    );

  const rawLeagueAverage =
    scores.length > 0
      ? scores.reduce(
          (
            total,
            score
          ) =>
            total + score,
          0
        ) /
        scores.length
      : LEAGUE_PRIOR;

  const currentSeasonWeight =
    Math.min(
      games.length / 32,
      1
    );

  return roundThree(
    LEAGUE_PRIOR *
      (
        1 -
        currentSeasonWeight
      ) +
      rawLeagueAverage *
        currentSeasonWeight
  );
}

function calculateWeightedAverage(
  games,
  team,
  usePointsScored,
  lowerBoundary,
  upperBoundary
) {
  const scores =
    games.map((game) => {
      const isHome =
        getGameTeamCode(
          game,
          "home"
        ) === team;

      const pointsScored =
        getGameScore(
          game,
          isHome
            ? "home"
            : "away"
        );

      const pointsAllowed =
        getGameScore(
          game,
          isHome
            ? "away"
            : "home"
        );

      return clamp(
        usePointsScored
          ? pointsScored
          : pointsAllowed,
        lowerBoundary,
        upperBoundary
      );
    });

  const weightOffset =
    Math.max(
      0,
      RECENCY_WEIGHTS.length -
        scores.length
    );

  const weights =
    RECENCY_WEIGHTS.slice(
      weightOffset
    );

  const weightedTotal =
    scores.reduce(
      (
        total,
        score,
        index
      ) =>
        total +
        score *
          weights[index],
      0
    );

  const totalWeight =
    weights.reduce(
      (
        total,
        weight
      ) =>
        total + weight,
      0
    );

  return (
    weightedTotal /
    Math.max(
      1,
      totalWeight
    )
  );
}

function regressAverage(
  robustAverage,
  gamesPlayed,
  leagueAverage
) {
  const teamWeight =
    gamesPlayed /
    (
      gamesPlayed +
      PRIOR_GAMES
    );

  return (
    robustAverage *
      teamWeight +
    leagueAverage *
      (
        1 -
        teamWeight
      )
  );
}

function calculatePercentile(
  values,
  fraction,
  fallback
) {
  const sorted =
    values
      .filter(
        Number.isFinite
      )
      .sort(
        (first, second) =>
          first - second
      );

  if (!sorted.length) {
    return fallback;
  }

  const position =
    (
      sorted.length -
      1
    ) *
    fraction;

  const lowerIndex =
    Math.floor(position);

  const upperIndex =
    Math.ceil(position);

  if (
    lowerIndex === upperIndex
  ) {
    return sorted[
      lowerIndex
    ];
  }

  return (
    sorted[lowerIndex] +
    (
      sorted[upperIndex] -
      sorted[lowerIndex]
    ) *
      (
        position -
        lowerIndex
      )
  );
}

function buildTeamForm(
  team,
  games,
  recordsByGame
) {
  if (!games.length) {
    return createNeutralForm(
      team
    );
  }

  const totals =
    createEmptyTotals();

  for (const game of games) {
    const records =
      recordsByGame.get(
        String(game.id)
      ) || [];

    const teamStats =
      aggregateTeamStats(
        records
      )[team] ||
      createEmptyTotals();

    addTotals(
      totals,
      teamStats
    );

    const isHome =
      getGameTeamCode(
        game,
        "home"
      ) === team;

    totals.pointsFor +=
      getGameScore(
        game,
        isHome
          ? "home"
          : "away"
      );

    totals.pointsAgainst +=
      getGameScore(
        game,
        isHome
          ? "away"
          : "home"
      );
  }

  const gameCount =
    games.length;

  const offensivePlays =
    totals.passingAttempts +
    totals.rushingAttempts;

  return {
    team,
    games: gameCount,

    pointsForPerGame:
      roundThree(
        totals.pointsFor /
          gameCount
      ),

    pointsAgainstPerGame:
      roundThree(
        totals.pointsAgainst /
          gameCount
      ),

    offensivePlaysPerGame:
      roundThree(
        offensivePlays /
          gameCount
      ),

    yardsPerPlay:
      roundThree(
        (
          totals.passingYards +
          totals.rushingYards
        ) /
        Math.max(
          1,
          offensivePlays
        )
      ),

    interceptionRate:
      roundThree(
        totals.interceptionsThrown /
        Math.max(
          1,
          totals.passingAttempts
        )
      ),

    sackRateAllowed:
      roundThree(
        totals.sacksAllowed /
        Math.max(
          1,
          totals.passingAttempts +
            totals.sacksAllowed
        )
      ),

    defensiveSacksPerGame:
      roundThree(
        totals.sacks /
          gameCount
      ),

    fumbleRecoveryRate:
      roundThree(
        totals.fumblesRecovered /
        Math.max(
          1,
          totals.fumblesForced +
            totals.fumbles
        )
      ),

    turnoverMarginPerGame:
      roundThree(
        (
          totals.defensiveInterceptions +
          totals.fumblesRecovered -
          totals.interceptionsThrown -
          totals.fumblesLost
        ) /
        gameCount
      ),

    completionRate: roundThree(totals.passingCompletions / Math.max(1, totals.passingAttempts)),
    passingYardsPerAttempt: roundThree(totals.passingYards / Math.max(1, totals.passingAttempts)),
    rushingYardsPerAttempt: roundThree(totals.rushingYards / Math.max(1, totals.rushingAttempts)),
    offensiveTouchdownsPerGame: roundThree((totals.passingTouchdowns + totals.rushingTouchdowns) / gameCount),
    explosivePlayProxyPerGame: roundThree((totals.longReception + totals.longRushing) / gameCount),
    dataCoverage: {
      trueEpa: false,
      successRate: false,
      driveData: false,
      pressureRate: false,
      boxScoreEfficiency: true,
    },
    raw: totals,
  };
}

function compareForms(
  away,
  home
) {
  if (
    !away.games ||
    !home.games
  ) {
    return createNeutralLayers();
  }

  const turnoverEdge =
    clamp(
      calculateTurnoverRegression(
        home
      ) -
      calculateTurnoverRegression(
        away
      ),
      -1.3,
      1.3
    );

  const homePressure =
    clamp(
      (
        home.defensiveSacksPerGame -
        away.sackRateAllowed *
          away.offensivePlaysPerGame
      ) *
        0.12,
      -0.65,
      0.65
    );

  const awayPressure =
    clamp(
      (
        away.defensiveSacksPerGame -
        home.sackRateAllowed *
          home.offensivePlaysPerGame
      ) *
        0.12,
      -0.65,
      0.65
    );

  const pressureHomePoints =
    clamp(
      awayPressure -
        homePressure,
      -0.8,
      0.8
    );

  const awayEfficiency = (away.passingYardsPerAttempt - 6.7) * 0.45 + (away.rushingYardsPerAttempt - 4.2) * 0.35 + (away.completionRate - 0.64) * 4;
  const homeEfficiency = (home.passingYardsPerAttempt - 6.7) * 0.45 + (home.rushingYardsPerAttempt - 4.2) * 0.35 + (home.completionRate - 0.64) * 4;
  const efficiencyEdge = clamp(homeEfficiency - awayEfficiency, -1.2, 1.2);
  const awayFinishing = clamp((away.offensiveTouchdownsPerGame - 2.5) * 0.32, -0.8, 0.8);
  const homeFinishing = clamp((home.offensiveTouchdownsPerGame - 2.5) * 0.32, -0.8, 0.8);
  const awayExplosive = clamp((away.explosivePlayProxyPerGame - 2) * 0.08, -0.45, 0.45);
  const homeExplosive = clamp((home.explosivePlayProxyPerGame - 2) * 0.08, -0.45, 0.45);
  const awayDriveProxy = clamp((away.pointsForPerGame / Math.max(1, away.offensivePlaysPerGame) - 0.35) * 4, -0.7, 0.7);
  const homeDriveProxy = clamp((home.pointsForPerGame / Math.max(1, home.offensivePlaysPerGame) - 0.35) * 4, -0.7, 0.7);
  const awaySituationalProxy = clamp((away.offensiveTouchdownsPerGame - 2.5) * 0.18, -0.45, 0.45);
  const homeSituationalProxy = clamp((home.offensiveTouchdownsPerGame - 2.5) * 0.18, -0.45, 0.45);

  const averagePlayVolume =
    (
      away.offensivePlaysPerGame +
      home.offensivePlaysPerGame
    ) / 2;

  const paceTotal =
    clamp(
      (
        averagePlayVolume -
        63
      ) *
        0.06,
      -0.7,
      0.7
    );

  return {
    turnoverRegression:
      createLayer(
        -turnoverEdge / 2,
        turnoverEdge / 2,
        0.63,
        [
          "Interception and fumble-recovery regression",
        ]
      ),

    schemeMatchup:
      createLayer(
        -pressureHomePoints / 2,
        pressureHomePoints / 2,
        0.58,
        [
          "Pass protection versus defensive sack production",
        ]
      ),

    passProtection:
      createLayer(-pressureHomePoints / 2, pressureHomePoints / 2, 0.58, ["Sack rate allowed versus defensive sack production"]),

    driveEfficiency:
      createLayer(awayDriveProxy, homeDriveProxy, 0.34, ["Points-per-offensive-play proxy; true drive data are unavailable"]),

    situationalEfficiency:
      createLayer(awaySituationalProxy, homeSituationalProxy, 0.32, ["Touchdown finishing proxy; third-down splits are unavailable"]),

    earlyDownEpa:
      createLayer(-efficiencyEdge / 2, efficiencyEdge / 2, 0.46, ["Box-score efficiency proxy; true EPA is unavailable"]),

    explosivePlays:
      createLayer(awayExplosive, homeExplosive, 0.36, ["Long-rush and long-reception proxy"]),

    redZone:
      createLayer(awayFinishing, homeFinishing, 0.4, ["Touchdown finishing proxy; true red-zone trips are unavailable"]),

    pace:
      createLayer(
        paceTotal / 2,
        paceTotal / 2,
        0.52,
        [
          "Recent offensive play volume",
        ]
      ),
  };
}

function calculateTurnoverRegression(
  teamForm
) {
  const expectedInterceptionRate =
    0.023;

  const regressedInterceptionRate =
    (
      teamForm.raw
        .interceptionsThrown +
      expectedInterceptionRate *
        120
    ) /
    Math.max(
      1,
      teamForm.raw
        .passingAttempts +
        120
    );

  const fumbleRegression =
    (
      0.5 -
      teamForm.fumbleRecoveryRate
    ) *
    0.55;

  return clamp(
    (
      expectedInterceptionRate -
      regressedInterceptionRate
    ) *
      45 +
      fumbleRegression -
      teamForm.turnoverMarginPerGame *
        0.12,
    -1.3,
    1.3
  );
}

function aggregateTeamStats(
  records
) {
  const teams = {};

  for (const record of records) {
    const teamCode =
      normalizeTeamCode(
        record.team?.abbreviation
      );

    if (!teamCode) {
      continue;
    }

    if (!teams[teamCode]) {
      teams[teamCode] =
        createEmptyTotals();
    }

    const totals =
      teams[teamCode];

    totals.passingAttempts +=
      getRecordValue(
        record,
        "passing_attempts"
      );

    totals.passingYards +=
      getRecordValue(
        record,
        "passing_yards"
      );

    totals.passingCompletions += getRecordValue(record, "passing_completions");
    totals.passingTouchdowns += getRecordValue(record, "passing_touchdowns");

    totals.interceptionsThrown +=
      getRecordValue(
        record,
        "passing_interceptions"
      );

    totals.rushingAttempts +=
      getRecordValue(
        record,
        "rushing_attempts"
      );

    totals.rushingYards +=
      getRecordValue(
        record,
        "rushing_yards"
      );

    totals.rushingTouchdowns += getRecordValue(record, "rushing_touchdowns");
    totals.longRushing += getRecordValue(record, "long_rushing");
    totals.longReception += getRecordValue(record, "long_reception");

    totals.sacks +=
      getRecordValue(
        record,
        "sacks"
      );

    totals.sacksAllowed +=
      getRecordValue(
        record,
        "sacks_suffered"
      ) ||
      getRecordValue(
        record,
        "passing_sacks"
      );

    totals.defensiveInterceptions +=
      getRecordValue(
        record,
        "interceptions"
      ) ||
      getRecordValue(
        record,
        "defensive_interceptions"
      );

    totals.fumbles +=
      getRecordValue(
        record,
        "fumbles"
      );

    totals.fumblesLost +=
      getRecordValue(
        record,
        "fumbles_lost"
      );

    totals.fumblesForced +=
      getRecordValue(
        record,
        "fumbles_forced"
      );

    totals.fumblesRecovered +=
      getRecordValue(
        record,
        "fumbles_recovered"
      );
  }

  return teams;
}

function createNeutralLayers() {
  return {
    scoringBaseline:
      createLayer(
        0,
        0,
        0,
        []
      ),

    turnoverRegression:
      createLayer(
        0,
        0,
        0,
        []
      ),

    schemeMatchup:
      createLayer(
        0,
        0,
        0,
        []
      ),

    passProtection: createLayer(0, 0, 0, []),
    driveEfficiency: createLayer(0, 0, 0, []),
    situationalEfficiency: createLayer(0, 0, 0, []),

    earlyDownEpa:
      createLayer(
        0,
        0,
        0,
        []
      ),

    explosivePlays:
      createLayer(
        0,
        0,
        0,
        []
      ),

    redZone:
      createLayer(
        0,
        0,
        0,
        []
      ),

    pace:
      createLayer(
        0,
        0,
        0,
        []
      ),
  };
}

function createLayer(
  awayPoints,
  homePoints,
  confidence,
  reasons
) {
  return {
    active:
      Math.abs(awayPoints) >
        0.01 ||
      Math.abs(homePoints) >
        0.01,

    awayPoints:
      roundThree(
        awayPoints
      ),

    homePoints:
      roundThree(
        homePoints
      ),

    confidence,
    reasons,
  };
}

function createNeutralForm(team) {
  return {
    team,
    games: 0,
    pointsForPerGame: 0,
    pointsAgainstPerGame: 0,
    offensivePlaysPerGame: 0,
    yardsPerPlay: 0,
    interceptionRate: 0,
    sackRateAllowed: 0,
    defensiveSacksPerGame: 0,
    fumbleRecoveryRate: 0.5,
    turnoverMarginPerGame: 0,
    completionRate: 0.64,
    passingYardsPerAttempt: 6.7,
    rushingYardsPerAttempt: 4.2,
    offensiveTouchdownsPerGame: 2.5,
    explosivePlayProxyPerGame: 2,
    dataCoverage: { trueEpa: false, successRate: false, driveData: false, pressureRate: false, boxScoreEfficiency: false },
    raw: createEmptyTotals(),
  };
}

function createEmptyTotals() {
  return {
    passingAttempts: 0,
    passingCompletions: 0,
    passingYards: 0,
    passingTouchdowns: 0,
    interceptionsThrown: 0,
    rushingAttempts: 0,
    rushingYards: 0,
    rushingTouchdowns: 0,
    longRushing: 0,
    longReception: 0,
    sacks: 0,
    sacksAllowed: 0,
    defensiveInterceptions: 0,
    fumbles: 0,
    fumblesLost: 0,
    fumblesForced: 0,
    fumblesRecovered: 0,
    pointsFor: 0,
    pointsAgainst: 0,
  };
}

function getTeamGames(
  games,
  team
) {
  return games
    .filter(
      (game) =>
        gameIncludesTeam(
          game,
          team
        )
    )
    .sort(
      (first, second) =>
        new Date(first.date) -
        new Date(second.date)
    );
}

function groupRecordsByGame(
  records
) {
  const recordsByGame =
    new Map();

  for (const record of records) {
    const gameId = String(
      record.game?.id ||
      record.game_id ||
      ""
    );

    if (!gameId) {
      continue;
    }

    if (
      !recordsByGame.has(gameId)
    ) {
      recordsByGame.set(
        gameId,
        []
      );
    }

    recordsByGame
      .get(gameId)
      .push(record);
  }

  return recordsByGame;
}

function getUniqueGames(games) {
  return [
    ...new Map(
      games.map(
        (game) => [
          String(game.id),
          game,
        ]
      )
    ).values(),
  ];
}

function addTotals(
  target,
  source
) {
  for (
    const key of Object.keys(
      target
    )
  ) {
    target[key] +=
      toNumber(source[key]);
  }
}

function isCompletedGame(game) {
  const status = String(
    game.status ||
    game.status_state ||
    ""
  ).toLowerCase();

  return (
    status.includes("final") ||
    status.includes("complete") ||
    (
      game.home_team_score !==
        null &&
      game.home_team_score !==
        undefined &&
      (
        game.visitor_team_score !==
          null &&
        game.visitor_team_score !==
          undefined
      )
    )
  );
}

function gameIncludesTeam(
  game,
  team
) {
  return (
    getGameTeamCode(
      game,
      "home"
    ) === team ||
    getGameTeamCode(
      game,
      "away"
    ) === team
  );
}

function getGameTeamCode(
  game,
  side
) {
  const team =
    side === "away"
      ? game.visitor_team ||
        game.away_team
      : game.home_team;

  return normalizeTeamCode(
    team?.abbreviation ||
    game?.[
      `${side}_team_abbreviation`
    ]
  );
}

function getGameScore(
  game,
  side
) {
  if (side === "away") {
    return toNumber(
      game.visitor_team_score ??
      game.away_team_score ??
      game.away_score
    );
  }

  return toNumber(
    game.home_team_score ??
    game.home_score
  );
}

function getRecordValue(
  record,
  key
) {
  return toNumber(
    record?.[key]
  );
}

function normalizeTeamCode(code) {
  const normalized =
    String(code || "")
      .trim()
      .toUpperCase();

  return (
    TEAM_ALIASES[
      normalized
    ] || normalized
  );
}

function toNumber(value) {
  const result =
    Number(value);

  return Number.isFinite(result)
    ? result
    : 0;
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    maximum,
    Math.max(
      minimum,
      value
    )
  );
}

function roundThree(value) {
  return (
    Math.round(
      value * 1000
    ) / 1000
  );
}

// Shared Supabase prediction ledger actions.
async function handlePredictionLedger(request, response) {
  setLedgerHeaders(response);

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  let supabase;
  try {
    supabase = createServerClient();
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }

  if (request.method === "GET") {
    return readSnapshots(supabase, request, response);
  }

  if (request.method === "POST") {
    if (!isSameOriginRequest(request)) {
      return response.status(403).json({ error: "Cross-origin writes are not allowed" });
    }

    if (String(request.query?.mode || "").toLowerCase() === "grade") {
      return gradeSnapshots(supabase, request, response);
    }

    return saveSnapshots(supabase, request, response);
  }

  response.setHeader("Allow", "GET, POST, OPTIONS");
  return response.status(405).json({ error: "Method not allowed" });
}

async function readSnapshots(supabase, request, response) {
  const season = ledgerIntegerOrNull(request.query?.season);
  const week = ledgerIntegerOrNull(request.query?.week);

  let query = supabase
    .from("prediction_snapshots")
    .select("*")
    .order("week", { ascending: true })
    .order("kickoff", { ascending: true });

  if (season !== null) query = query.eq("season", season);
  if (week !== null) query = query.eq("week", week);

  const { data, error } = await query;

  if (error) {
    return response.status(500).json({ error: error.message });
  }

  return response.status(200).json({
    snapshots: (data || []).map(databaseToSnapshot),
    count: data?.length || 0,
    source: "supabase",
  });
}

async function saveSnapshots(supabase, request, response) {
  const body = parseBody(request.body);
  const supplied = Array.isArray(body?.snapshots)
    ? body.snapshots
    : body?.snapshot
      ? [body.snapshot]
      : [];

  if (!supplied.length) {
    return response.status(400).json({ error: "No prediction snapshots supplied" });
  }

  const valid = supplied
    .map(normaliseSnapshot)
    .filter((snapshot) =>
      snapshot.season &&
      snapshot.week &&
      snapshot.awayCode &&
      snapshot.homeCode &&
      snapshot.kickoff
    );

  if (!valid.length) {
    return response.status(400).json({ error: "No valid prediction snapshots supplied" });
  }

  const saved = [];
  const rejected = [];

  for (const incoming of valid) {
    const { data: existing, error: existingError } = await supabase
      .from("prediction_snapshots")
      .select("*")
      .eq("season", incoming.season)
      .eq("week", incoming.week)
      .eq("away_code", incoming.awayCode)
      .eq("home_code", incoming.homeCode)
      .maybeSingle();

    if (existingError) {
      rejected.push({ gameKey: incoming.gameKey, reason: existingError.message });
      continue;
    }

    const now = Date.now();
    const kickoffTime = new Date(incoming.kickoff).getTime();
    const existingSnapshot = existing ? databaseToSnapshot(existing) : null;
    const existingFrozen = Boolean(existing?.frozen_at) ||
      (Number.isFinite(kickoffTime) && now >= kickoffTime && hasPrediction(existingSnapshot));

    const incomingHasFinal = hasFinalResult(incoming);
    const existingHasFinal = hasFinalResult(existingSnapshot);

    // The first complete official prediction becomes the shared source of truth.
    // Other devices may calculate locally, but they cannot replace an existing
    // official score before kickoff. Final results can still be added later.
    if (hasPrediction(existingSnapshot) && !incomingHasFinal) {
      saved.push(existingSnapshot);
      continue;
    }

    if (existingFrozen && !incomingHasFinal && hasPrediction(existingSnapshot)) {
      saved.push(existingSnapshot);
      continue;
    }

    let merged = mergeSnapshots(existingSnapshot, incoming);

    if (existingHasFinal && !incomingHasFinal) {
      merged = mergeSnapshots(incoming, existingSnapshot);
    }

    if (Number.isFinite(kickoffTime) && now >= kickoffTime && hasPrediction(merged)) {
      merged.savedBeforeKickoff = true;
      merged.frozenAt = existing?.frozen_at || incoming.frozenAt || incoming.snapshotAt || incoming.kickoff;
    }

    const databaseRow = snapshotToDatabase(merged, existing?.id);
    const { data, error } = await supabase
      .from("prediction_snapshots")
      .upsert(databaseRow, {
        onConflict: "season,week,away_code,home_code",
      })
      .select("*")
      .single();

    if (error) {
      rejected.push({ gameKey: incoming.gameKey, reason: error.message });
    } else {
      saved.push(databaseToSnapshot(data));
    }
  }

  return response.status(rejected.length && !saved.length ? 500 : 200).json({
    saved,
    rejected,
    count: saved.length,
  });
}

async function gradeSnapshots(supabase, request, response) {
  const body = parseBody(request.body);
  const rows = Array.isArray(body?.results) ? body.results : [];
  const graded = [];
  const rejected = [];

  for (const result of rows) {
    const season = ledgerIntegerOrNull(result?.season);
    const week = ledgerIntegerOrNull(result?.week);
    const awayCode = ledgerNormaliseTeam(result?.awayCode);
    const homeCode = ledgerNormaliseTeam(result?.homeCode);
    const awayScore = ledgerNullableNumber(result?.actualAwayScore);
    const homeScore = ledgerNullableNumber(result?.actualHomeScore);

    if (
      season === null ||
      week === null ||
      !awayCode ||
      !homeCode ||
      awayScore === null ||
      homeScore === null
    ) {
      rejected.push({ result, reason: "Invalid result" });
      continue;
    }

    const { data: existing, error: readError } = await supabase
      .from("prediction_snapshots")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .eq("away_code", awayCode)
      .eq("home_code", homeCode)
      .maybeSingle();

    if (readError || !existing) {
      rejected.push({
        result,
        reason: readError?.message || "Prediction not found",
      });
      continue;
    }

    const actualWinner =
      awayScore === homeScore
        ? "TIE"
        : awayScore > homeScore
          ? awayCode
          : homeCode;

    const fourthDownCorrect = existing.fourth_down_pick
      ? ledgerNormaliseTeam(existing.fourth_down_pick) === actualWinner
      : null;

    const marketCorrect = existing.market_pick
      ? ledgerNormaliseTeam(existing.market_pick) === actualWinner
      : null;

    const snapshot = existing?.data_quality?.snapshot || {};
    const gradedAt = new Date().toISOString();

    const { data, error } = await supabase
      .from("prediction_snapshots")
      .update({
        actual_away_score: awayScore,
        actual_home_score: homeScore,
        actual_winner: actualWinner,
        fourth_down_correct: fourthDownCorrect,
        market_correct: marketCorrect,
        graded_at: gradedAt,
        updated_at: gradedAt,
        data_quality: {
          ...(existing.data_quality || {}),
          snapshot: {
            ...snapshot,
            actualAwayScore: awayScore,
            actualHomeScore: homeScore,
            actualWinner,
            fourthDownCorrect,
            oddsCorrect: marketCorrect,
            gradedAt,
          },
        },
      })
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) {
      rejected.push({ result, reason: error.message });
    } else {
      graded.push(databaseToSnapshot(data));
    }
  }

  return response
    .status(rejected.length && !graded.length ? 500 : 200)
    .json({
      graded,
      rejected,
      count: graded.length,
    });
}

function createServerClient() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Supabase server environment variables are missing");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function snapshotToDatabase(snapshot, existingId) {
  const now = new Date().toISOString();
  const kickoffTime = new Date(snapshot.kickoff).getTime();
  const frozenAt = snapshot.frozenAt ||
    (snapshot.savedBeforeKickoff && Number.isFinite(kickoffTime) && Date.now() >= kickoffTime
      ? snapshot.snapshotAt || snapshot.kickoff
      : null);

  return {
    ...(existingId ? { id: existingId } : {}),
    season: snapshot.season,
    week: snapshot.week,
    game_key: snapshot.gameKey,
    kickoff: snapshot.kickoff,
    away_code: snapshot.awayCode,
    home_code: snapshot.homeCode,
    fourth_down_pick: nullableText(snapshot.fourthDownPick),
    predicted_away_score: ledgerNullableNumber(snapshot.fourthDownAwayScore),
    predicted_home_score: ledgerNullableNumber(snapshot.fourthDownHomeScore),
    away_win_probability: ledgerNullableNumber(snapshot.fourthDownAwayWinProbability),
    home_win_probability: ledgerNullableNumber(snapshot.fourthDownHomeWinProbability),
    market_pick: nullableText(snapshot.oddsPick),
    market_away_score: ledgerNullableNumber(snapshot.marketAwayScore),
    market_home_score: ledgerNullableNumber(snapshot.marketHomeScore),
    market_total: ledgerNullableNumber(snapshot.marketGameTotal),
    market_spread: ledgerNullableNumber(snapshot.marketSpread),
    confidence_score: ledgerNullableNumber(snapshot.confidenceScore),
    confidence_label: nullableText(snapshot.confidenceLabel),
    model_version: nullableText(snapshot.modelVersion),
    data_quality: {
      snapshot,
      quality: snapshot.dataQuality || null,
    },
    active_layers: snapshot.activeLayers || null,
    frozen_at: frozenAt,
    actual_away_score: ledgerNullableNumber(snapshot.actualAwayScore),
    actual_home_score: ledgerNullableNumber(snapshot.actualHomeScore),
    actual_winner: nullableText(snapshot.actualWinner),
    fourth_down_correct: nullableBoolean(snapshot.fourthDownCorrect),
    market_correct: nullableBoolean(snapshot.oddsCorrect),
    graded_at: snapshot.gradedAt || null,
    updated_at: now,
  };
}

function databaseToSnapshot(row) {
  const stored = row?.data_quality?.snapshot || {};

  return normaliseSnapshot({
    ...stored,
    databaseId: row.id,
    id: stored.id || row.game_key,
    season: row.season,
    week: row.week,
    gameKey: row.game_key,
    kickoff: row.kickoff,
    awayCode: row.away_code,
    homeCode: row.home_code,
    fourthDownPick: row.fourth_down_pick,
    fourthDownAwayScore: row.predicted_away_score,
    fourthDownHomeScore: row.predicted_home_score,
    fourthDownAwayWinProbability: row.away_win_probability,
    fourthDownHomeWinProbability: row.home_win_probability,
    oddsPick: row.market_pick,
    marketAwayScore: row.market_away_score,
    marketHomeScore: row.market_home_score,
    marketGameTotal: row.market_total,
    marketSpread: row.market_spread,
    confidenceScore: row.confidence_score,
    confidenceLabel: row.confidence_label,
    modelVersion: row.model_version,
    dataQuality: row?.data_quality?.quality || stored.dataQuality || null,
    activeLayers: row.active_layers,
    frozenAt: row.frozen_at,
    savedBeforeKickoff: stored.savedBeforeKickoff ?? Boolean(row.frozen_at),
    actualAwayScore: row.actual_away_score,
    actualHomeScore: row.actual_home_score,
    actualWinner: row.actual_winner,
    fourthDownCorrect: row.fourth_down_correct,
    oddsCorrect: row.market_correct,
    gradedAt: row.graded_at,
    snapshotAt: stored.snapshotAt || row.created_at,
    updatedAt: row.updated_at,
    shared: true,
  });
}

function mergeSnapshots(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingFinal = hasFinalResult(existing);
  const incomingFinal = hasFinalResult(incoming);

  if (existingFinal && !incomingFinal) return { ...incoming, ...existing };
  if (incomingFinal && !existingFinal) return { ...existing, ...incoming };

  const existingTime = new Date(existing.updatedAt || existing.snapshotAt || 0).getTime() || 0;
  const incomingTime = new Date(incoming.updatedAt || incoming.snapshotAt || 0).getTime() || 0;

  return incomingTime >= existingTime
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };
}

function normaliseSnapshot(snapshot) {
  const kickoff = snapshot?.kickoff || snapshot?.date || snapshot?.datetime || null;
  const season = ledgerIntegerOrNull(snapshot?.season) || getSeason(kickoff);
  const week = ledgerIntegerOrNull(snapshot?.week) || 0;
  const awayCode = ledgerNormaliseTeam(snapshot?.awayCode);
  const homeCode = ledgerNormaliseTeam(snapshot?.homeCode);
  const gameKey = snapshot?.gameKey || `${season}:${week}:${awayCode}:${homeCode}`;

  return {
    ...snapshot,
    id: snapshot?.id || gameKey,
    gameKey,
    season,
    week,
    kickoff,
    awayCode,
    homeCode,
  };
}

function hasPrediction(snapshot) {
  return Boolean(
    snapshot &&
    Number.isFinite(Number(snapshot.fourthDownAwayScore)) &&
    Number.isFinite(Number(snapshot.fourthDownHomeScore))
  );
}

function hasFinalResult(snapshot) {
  return Boolean(
    snapshot?.actualWinner &&
    Number.isFinite(Number(snapshot.actualAwayScore)) &&
    Number.isFinite(Number(snapshot.actualHomeScore))
  );
}

function getSeason(kickoff) {
  const date = new Date(kickoff || 0);
  return Number.isNaN(date.getTime()) ? 2026 : date.getUTCFullYear();
}

function ledgerNormaliseTeam(value) {
  const code = String(value || "").trim().toUpperCase();
  return ({
    WAS: "WSH",
    LA: "LAR",
    JAC: "JAX",
    OAK: "LV",
    SD: "LAC",
    STL: "LAR",
  })[code] || code;
}

function ledgerNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableText(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function ledgerIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function parseBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body || null;
}

function isSameOriginRequest(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.host;
  if (!origin || !host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function setLedgerHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}
