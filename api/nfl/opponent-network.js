import process from "node:process";
import { fetchSchedule } from "../../scripts/balldontlie-schedule.mjs";
import teamArtifact from "./nflverse-team-metrics.js";

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
export const NFL_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH",
];

export function createOpponentNetworkHandler({ loadNetwork = loadWeeklyOpponentNetwork } = {}) {
  return (req, res) => handler(req, res, { loadNetwork });
}

export default async function handler(req, res, { loadNetwork = loadWeeklyOpponentNetwork } = {}) {
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
    week < 1 || week > 19 ||
    !NFL_TEAMS.includes(away) ||
    !NFL_TEAMS.includes(home) ||
    away === home
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
    const { games, ratings, provenance } = await loadNetwork(season, week);

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

    const awayRating =
      ratings[away] ||
      createNeutralRating();

    const homeRating =
      ratings[home] ||
      createNeutralRating();

    if (!awayRating.games || !homeRating.games) {
      return sendNeutral(res, season, week, away, home,
        "Both teams need completed current-season games", ratings);
    }

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
        provenance?.source || "BALLDONTLIE completed games",
      ...(provenance ? { provenance } : {}),

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
    const message = error instanceof Error ? error.message : "Opponent network request failed";
    console.error("Opponent network failed:", message);
    return res.status(502).json({
      error: "Opponent network unavailable", code: "OPPONENT_NETWORK_UNAVAILABLE",
      reason: message, season, week, away, home, dataStatus: "unavailable",
    });
  }
}

export async function loadWeeklyOpponentNetwork(season, week, { sourceGames, cutoff, now = new Date(), ...fetchOptions } = {}) {
  const stored = teamArtifact.season === season && teamArtifact.opponentNetworkByWeek?.[week];
  if (!sourceGames && stored && (!cutoff || stored.provenance?.cutoff === cutoff)) {
    return validateWeeklyOpponentNetwork(stored, season, week);
  }
  const source = sourceGames || await fetchSchedule(season, { deadline: Date.now() + 55000, ...fetchOptions });
  const limit = cutoff ? Date.parse(cutoff) : null;
  const eligible = limit === null ? source : source.filter((game) => {
    const completed = Date.parse(game.completed_at || game.updated_at);
    const kickoff = Date.parse(game.date);
    return Number.isFinite(completed) && Number.isFinite(kickoff) &&
      kickoff < limit && completed >= kickoff && completed < limit && completed <= now.getTime();
  });
  const games = prepareNetworkGames(eligible, season, week);
  return { season, week, games, ratings: solveOpponentNetwork(games, week) };
}

export function validateWeeklyOpponentNetwork(network, season, week) {
  if (network?.season !== season || network?.week !== week || !Array.isArray(network.games) || !network.games.length ||
      !network.games.every((g) => g.season === season && g.week >= 1 && g.week < week)) {
    throw new Error("Wrong-week or incomplete weekly opponent network");
  }
  for (const code of NFL_TEAMS) {
    const rating = network.ratings?.[code];
    if (!rating || !["offense", "defense", "overall", "scheduleStrength", "games"]
      .every((field) => typeof rating[field] === "number" && Number.isFinite(rating[field])) ||
        !Number.isInteger(rating.games) || rating.games < 1) throw new Error(`Invalid weekly opponent network team ${code}`);
  }
  if (new Set(NFL_TEAMS.map((code) => network.ratings[code].overall)).size < 2) {
    throw new Error("Weekly opponent network ratings are constant");
  }
  return network;
}

export function solveOpponentNetwork(
  games,
  targetWeek
) {
  const activeTeams = [
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
      NFL_TEAMS.map(
        (team) => [
          team,
          0,
        ]
      )
    );

  let defense =
    Object.fromEntries(
      NFL_TEAMS.map(
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

    for (const team of activeTeams) {
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

        const weight = networkGameWeight(game, targetWeek);

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
        (offense[team] + weightedAverage(
          offensiveEntries
        )) / 2;

      nextDefense[team] =
        (defense[team] + weightedAverage(
          defensiveEntries
        )) / 2;
    }

    // Half-step relaxation prevents the synchronous two-cycle on sparse/bipartite schedules.
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
    NFL_TEAMS.map((team) => {
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
              offense[team] ?? 0
            ),

          defense:
            round(
              defense[team] ?? 0
            ),

          overall:
            round(
              (offense[team] ?? 0) +
                (defense[team] ?? 0)
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

export function getRecentTeamGames(
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
        second.week - first.week ||
        String(second.date || "").localeCompare(String(first.date || "")) ||
        String(first.id).localeCompare(String(second.id))
    )
    .slice(
      0,
      RECENT_GAME_LIMIT
    );
}

export function findCommonOpponents(
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

export function teamPerformanceAgainst(
  games,
  team,
  opponent,
  ratings,
  targetWeek
) {
  const matches =
    games.filter(
      (game) => (game.away === team && game.home === opponent) ||
        (game.home === team && game.away === opponent)
    );

  // Reconstructed: compare weighted scoring margins plus opponent strength.
  return weightedAverage(matches.map((game) => ({
    value: (game.home === team
      ? game.homeScore - game.awayScore
      : game.awayScore - game.homeScore) + (ratings[opponent]?.overall ?? 0),
    weight: networkGameWeight(game, targetWeek),
  })));
}

// The tail below was missing in every recoverable revision; these helpers are reconstructed.
export function calculateCommonOpponentEdge(commonOpponents) {
  // Reconstructed: use the existing one-point limit, without adding a new weight.
  return clamp(average(commonOpponents.map(
    (opponent) => opponent.homePerformance - opponent.awayPerformance
  )), -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
}

export function networkGameWeight(game, targetWeek) {
  // Reconstructed from the existing NFLverse recency curve; latest eligible week is age zero.
  const age = Math.max(0, targetWeek - 1 - game.week);
  const recency = [1, 0.95, 0.85, 0.75][age] ?? 0.65;
  // Reconstructed smooth volatility discount, scaled by the network's existing 22-point baseline.
  return recency * 22 / (22 + Math.abs(game.homeScore - game.awayScore));
}

export function prepareNetworkGames(sourceGames, season, targetWeek) {
  const byId = new Map();
  const byMatchup = new Map();
  for (const source of sourceGames) {
    const week = Number(source.week);
    const type = String(source.season_type ?? source.game_type ?? "").toUpperCase();
    if (Number(source.season) !== season ||
        !Number.isInteger(week) || week < 1 || week > 18 || week >= targetWeek ||
        [true, 1, "true", "1"].includes(source.postseason) ||
        (type && !["REG", "REGULAR", "REGULAR SEASON", "2"].includes(type)) ||
        !isCompleted(source)) continue;

    const game = normalizeGame(source);
    if (!NFL_TEAMS.includes(game.away) || !NFL_TEAMS.includes(game.home) ||
        game.away === game.home || game.awayScore === null || game.homeScore === null) {
      throw new Error(`Invalid teams or scores in opponent network game ${source.id ?? "without ID"}`);
    }
    const matchup = `${season}:${week}:${[game.away, game.home].sort().join(":")}`;
    const signature = [game.away, game.home].sort()
      .map((team) => `${team}:${team === game.away ? game.awayScore : game.homeScore}`).join(":");
    const id = source.id == null ? matchup : String(source.id);
    const existing = byId.get(id) || byMatchup.get(matchup);
    if (existing) {
      if (existing.matchup !== matchup || existing.signature !== signature) {
        throw new Error(`Conflicting duplicate opponent network game ${id}`);
      }
      byId.set(id, existing);
      continue;
    }
    const entry = { matchup, signature, game: { ...game, id, season, weight: networkGameWeight(game, targetWeek) } };
    byId.set(id, entry);
    byMatchup.set(matchup, entry);
  }
  return [...byMatchup.values()].map((entry) => entry.game);
}

function isCompleted(game) {
  const status = String(game.status || game.status_state || game.state || "").trim().toLowerCase();
  return game.completed === true || /^(final\b|completed?$|closed$|post$)/.test(status);
}

function normalizeGame(game) {
  return {
    week: Number(game.week),
    date: game.date || null,
    away: normalizeTeam(game.visitor_team?.abbreviation ?? game.away_team?.abbreviation ?? game.away_team_abbreviation),
    home: normalizeTeam(game.home_team?.abbreviation ?? game.home_team_abbreviation),
    awayScore: scoreOrNull(game.visitor_team_score ?? game.away_team_score ?? game.away_score),
    homeScore: scoreOrNull(game.home_team_score ?? game.home_score),
  };
}

function scoreOrNull(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const score = Number(value);
  return Number.isSafeInteger(score) && score >= 0 ? score : null;
}

function normalizeTeam(value) {
  const team = String(value || "").trim().toUpperCase();
  return TEAM_ALIASES[team] || team;
}

function weightedAverage(entries) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return totalWeight ? entries.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function centerRatings(ratings) {
  const mean = average(Object.values(ratings));
  return Object.fromEntries(Object.entries(ratings).map(([team, value]) => [team, value - mean]));
}

function createNeutralRating() {
  return { offense: 0, defense: 0, overall: 0, scheduleStrength: 0, games: 0 };
}

function sendNeutral(res, season, week, away, home, reason, ratings) {
  return res.status(200).json({
    season, week, away, home,
    source: "BALLDONTLIE completed games",
    ratings: ratings || Object.fromEntries(NFL_TEAMS.map((team) => [team, createNeutralRating()])),
    commonOpponents: [],
    gamesUsed: 0,
    dataStatus: "neutral",
    reason,
    modelLayer: {
      active: false, available: false, awayPoints: 0, homePoints: 0,
      rawAwayPoints: 0, rawHomePoints: 0, confidence: 0,
      gamesUsed: 0, commonOpponents: 0, reasons: [reason],
    },
  });
}

function buildReasons({ away, home, homePoints, commonOpponents, minimumGames }) {
  return [
    `Opponent-adjusted scoring network: ${home} versus ${away}`,
    `${minimumGames} recent games per team minimum; ${commonOpponents.length} common opponents`,
    `Home adjustment ${round(homePoints)} points`,
  ];
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}