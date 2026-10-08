const SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";
const ADVANCED_PASSING_URL =
  "https://api.balldontlie.io/nfl/v1/advanced_stats/passing";

const TEAM_ALIASES = {
  WAS: "WSH",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

const POSITION_WEIGHTS = {
  QB: 0,
  LT: 0.42,
  RT: 0.32,
  OT: 0.34,
  T: 0.34,
  C: 0.24,
  G: 0.18,
  OG: 0.18,
  EDGE: 0.36,
  DE: 0.3,
  OLB: 0.25,
  DT: 0.2,
  NT: 0.16,
  CB: 0.3,
  DB: 0.22,
  S: 0.18,
  FS: 0.18,
  SS: 0.18,
  WR: 0.2,
  TE: 0.13,
  LB: 0.14,
  ILB: 0.14,
  MLB: 0.14,
  RB: 0.08,
  FB: 0.05,
};

const ABSENCE = {
  Out: 1,
  IR: 1,
  PUP: 1,
  Suspended: 1,
  Inactive: 1,
  Doubtful: 0.75,
  Questionable: 0.25,
  Probable: 0.08,
};

let playerCache = null;
let playerCacheUntil = 0;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const away = normalizeTeam(req.query.away);
  const home = normalizeTeam(req.query.home);
  const season = Number(
    req.query.season || new Date().getUTCFullYear()
  );

  if (!away || !home) {
    return res.status(400).json({
      error: "away and home team abbreviations are required",
    });
  }

  if (!Number.isInteger(season)) {
    return res.status(400).json({
      error: "Invalid season",
    });
  }

  try {
    const [players, passing] = await Promise.all([
      getSleeperPlayers(),
      getAdvancedPassing(
        process.env.BALLDONTLIE_API_KEY,
        season
      ),
    ]);

    const leagueQbs = buildLeagueQbRatings(passing);

    return res.status(200).json({
      season,
      away: buildTeamHealth(away, players, leagueQbs),
      home: buildTeamHealth(home, players, leagueQbs),
      sourceStatus: {
        sleeper: true,
        advancedPassing: passing.length > 0,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res
      .status(Number(error?.status) || 500)
      .json({
        error: "Unable to calculate QB and roster health",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      });
  }
}

async function getSleeperPlayers() {
  if (
    playerCache &&
    Date.now() < playerCacheUntil
  ) {
    return playerCache;
  }

  const response = await fetch(SLEEPER_URL, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Sleeper returned HTTP ${response.status}`
    );
  }

  const body = await response.json();

  playerCache = Object.entries(body).map(
    ([id, player]) => ({
      id,
      ...player,
    })
  );

  playerCacheUntil =
    Date.now() + 6 * 60 * 60 * 1000;

  return playerCache;
}

async function getAdvancedPassing(apiKey, season) {
  if (!apiKey) {
    return [];
  }

  const rows = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      season: String(season),
      week: "0",
      per_page: "100",
    });

    if (cursor != null) {
      params.set("cursor", String(cursor));
    }

    const response = await fetch(
      `${ADVANCED_PASSING_URL}?${params}`,
      {
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
        },
      }
    );

    const body = await readJson(response);

    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) {
        return [];
      }

      const error = new Error(
        body.error ||
          `BALLDONTLIE returned HTTP ${response.status}`
      );

      error.status = response.status;
      throw error;
    }

    rows.push(...(body.data || []));
    cursor = body.meta?.next_cursor ?? null;
  } while (cursor != null);

  return rows;
}

function buildTeamHealth(
  team,
  allPlayers,
  leagueQbs
) {
  const roster = allPlayers
    .filter(
      (player) =>
        normalizeTeam(player.team) === team
    )
    .map(normalizePlayer)
    .sort(
      (a, b) =>
        (a.depth ?? 99) - (b.depth ?? 99)
    );

  const qbs = roster
    .filter(
      (player) => player.position === "QB"
    )
    .sort(
      (a, b) =>
        (a.depth ?? 99) - (b.depth ?? 99)
    );

  const expectedStarter =
    qbs.find((player) => player.depth === 1) ||
    qbs[0] ||
    null;

  const availableQb =
    qbs.find(
      (player) => player.availableForGame
    ) ||
    qbs.find(
      (player) =>
        player.rosterEligible &&
        player.availability >= 0.5
    ) ||
    null;

  const starterRating = findQbRating(
    expectedStarter,
    leagueQbs
  );

  const activeRating = findQbRating(
    availableQb,
    leagueQbs
  );

  const starterUnavailable = Boolean(
    expectedStarter &&
      (
        !expectedStarter.availableForGame ||
        !availableQb ||
        expectedStarter.id !== availableQb.id
      )
  );

  let qbPoints = 0;
  const qbReasons = [];

  if (
    expectedStarter &&
    !expectedStarter.availableForGame
  ) {
    const qualityGap =
      starterRating.score - activeRating.score;

    qbPoints = clamp(
      -0.8 - qualityGap * 0.065,
      -7.5,
      0
    );

    qbPoints *= Math.min(
      starterRating.confidence,
      activeRating.confidence + 0.2
    );

    if (availableQb) {
      qbReasons.push(
        `${expectedStarter.name} is ${expectedStarter.injuryLabel}; ` +
          `${availableQb.name} is projected to start`
      );
    } else {
      qbReasons.push(
        `${expectedStarter.name} is ${expectedStarter.injuryLabel}; ` +
          "no available replacement quarterback was identified"
      );
    }
  } else if (
    expectedStarter?.injuryProbability > 0
  ) {
    qbPoints = -clamp(
      expectedStarter.injuryProbability * 0.9,
      0,
      0.8
    );

    qbReasons.push(
      `${expectedStarter.name} carries a ` +
        `${expectedStarter.injuryLabel} designation`
    );
  }

  const affectedStarters = roster.filter(
    (player) =>
      player.position !== "QB" &&
      player.depth === 1 &&
      player.injuryProbability > 0
  );

  let rosterPoints = -affectedStarters.reduce(
    (total, player) => {
      const weight =
        POSITION_WEIGHTS[player.depthPosition] ||
        POSITION_WEIGHTS[player.position] ||
        0.08;

      return (
        total +
        weight * player.injuryProbability
      );
    },
    0
  );

  const unavailable = affectedStarters.filter(
    (player) =>
      player.injuryProbability >= 0.75
  );

  const tackleCount = unavailable.filter(
    (player) =>
      ["LT", "RT", "OT", "T"].includes(
        player.depthPosition
      )
  ).length;

  const cornerCount = unavailable.filter(
    (player) => player.position === "CB"
  ).length;

  const edgeCount = unavailable.filter(
    (player) =>
      ["EDGE", "DE", "OLB"].includes(
        player.depthPosition
      )
  ).length;

  if (tackleCount >= 2) {
    rosterPoints -= 0.55;
  }

  if (cornerCount >= 2) {
    rosterPoints -= 0.45;
  }

  if (edgeCount >= 2) {
    rosterPoints -= 0.4;
  }

  rosterPoints = clamp(
    rosterPoints,
    -3.5,
    0
  );

  return {
    team,

    expectedStarter: expectedStarter
      ? qbSummary(
          expectedStarter,
          starterRating
        )
      : null,

    projectedStarter: availableQb
      ? qbSummary(
          availableQb,
          activeRating
        )
      : null,

    starterUnavailable,

    quarterback: {
      points: round(qbPoints),

      confidence: round(
        Math.min(
          starterRating.confidence,
          Math.max(
            activeRating.confidence,
            0.35
          )
        )
      ),

      reasons: qbReasons,
    },

    rosterHealth: {
      points: round(rosterPoints),
      confidence: roster.length ? 0.78 : 0,

      affectedStarters:
        affectedStarters.map((player) => ({
          name: player.name,
          position: player.depthPosition,
          status: player.injuryLabel,
          rosterStatus: player.rosterStatus,
          absenceProbability:
            player.injuryProbability,
        })),

      reasons: affectedStarters.length
        ? [
            `${affectedStarters.length} projected starter${
              affectedStarters.length === 1
                ? ""
                : "s"
            } carrying injury designations`,
          ]
        : [],
    },
  };
}

function buildLeagueQbRatings(rows) {
  return rows.map((row) => {
    const attempts = number(row.attempts);
    const games = Math.max(
      1,
      number(row.games_played)
    );

    const tdRate = attempts
      ? number(row.pass_touchdowns) / attempts
      : 0;

    const intRate = attempts
      ? number(row.interceptions) / attempts
      : 0.025;

    const yardsPerAttempt = attempts
      ? number(row.pass_yards) / attempts
      : 6.8;

    const score =
      50 +
      number(
        row.completion_percentage_above_expectation
      ) *
        2.1 +
      (number(row.passer_rating, 85) - 85) *
        0.42 +
      (yardsPerAttempt - 6.8) * 5 +
      (tdRate - 0.04) * 120 -
      (intRate - 0.025) * 150;

    return {
      name: normalizeName(
        row.player?.display_name ||
          row.player?.full_name ||
          `${row.player?.first_name || ""} ${
            row.player?.last_name || ""
          }`
      ),

      team: normalizeTeam(
        row.player?.team?.abbreviation ||
          row.player?.team ||
          row.team
      ),

      score: clamp(score, 20, 90),
      attempts,
      games,

      confidence: clamp(
        attempts / 200,
        0.25,
        1
      ),

      raw: row,
    };
  });
}

function findQbRating(player, ratings) {
  if (!player) {
    return {
      score: 38,
      confidence: 0.25,
      source: "replacement baseline",
    };
  }

  const name = normalizeName(player.name);

  const match =
    ratings.find(
      (rating) =>
        rating.name === name &&
        rating.team === player.team
    ) ||
    ratings.find(
      (rating) => rating.name === name
    );

  if (match) {
    return {
      score: match.score,
      confidence: match.confidence,
      source:
        "BALLDONTLIE advanced passing",
    };
  }

  return {
    score:
      player.depth === 1
        ? 52
        : player.depth === 2
          ? 40
          : 34,

    confidence: 0.35,
    source: "depth-chart baseline",
  };
}

function normalizePlayer(player) {
  const position = String(
    player.position || ""
  ).toUpperCase();

  const depthPosition = String(
    player.depth_chart_position || position
  ).toUpperCase();

  const rosterStatus = normalizeRosterStatus(
    player.status
  );

  const injuryLabel = normalizeStatus(
    player.injury_status
  );

  const injuryProbability =
    absenceProbability(
      injuryLabel,
      rosterStatus
    );

  const rosterEligible = [
    "active",
    "unknown",
  ].includes(rosterStatus);

  const availableForGame =
    rosterEligible &&
    injuryProbability < 0.5;

  return {
    id: player.id,

    name:
      player.full_name ||
      [player.first_name, player.last_name]
        .filter(Boolean)
        .join(" ") ||
      "Unknown player",

    team: normalizeTeam(player.team),
    position,
    depthPosition,

    depth: nullableNumber(
      player.depth_chart_order
    ),

    rosterStatus,
    rosterEligible,
    injuryLabel,
    injuryProbability,

    availability:
      1 - injuryProbability,

    availableForGame,
  };
}

function qbSummary(player, rating) {
  return {
    name: player.name,
    status: player.injuryLabel,
    rosterStatus: player.rosterStatus,
    depth: player.depth,
    availableForGame:
      player.availableForGame,
    rating: round(rating.score),
    ratingConfidence: round(
      rating.confidence
    ),
    ratingSource: rating.source,
  };
}

function normalizeStatus(status) {
  const value = String(
    status || ""
  ).toLowerCase();

  if (value.includes("question")) {
    return "Questionable";
  }

  if (value.includes("doubt")) {
    return "Doubtful";
  }

  if (value.includes("out")) {
    return "Out";
  }

  if (
    value === "ir" ||
    value.includes("injured reserve")
  ) {
    return "IR";
  }

  if (value.includes("pup")) {
    return "PUP";
  }

  if (value.includes("suspend")) {
    return "Suspended";
  }

  if (value.includes("inactive")) {
    return "Inactive";
  }

  if (value.includes("probable")) {
    return "Probable";
  }

  return "Active";
}

function normalizeRosterStatus(value) {
  const status = String(
    value || "unknown"
  )
    .trim()
    .toLowerCase();

  if (status === "active") {
    return "active";
  }

  if (
    !status ||
    status === "unknown"
  ) {
    return "unknown";
  }

  if (
    status === "ir" ||
    status.includes("injured reserve")
  ) {
    return "ir";
  }

  if (
    status === "pup" ||
    status.includes("physically unable")
  ) {
    return "pup";
  }

  if (status.includes("suspend")) {
    return "suspended";
  }

  if (status.includes("inactive")) {
    return "inactive";
  }

  return status;
}

function absenceProbability(
  injuryLabel,
  rosterStatus
) {
  if (
    ["ir", "pup", "suspended", "inactive"].includes(
      rosterStatus
    )
  ) {
    return 1;
  }

  if (
    rosterStatus !== "active" &&
    rosterStatus !== "unknown"
  ) {
    return 1;
  }

  return ABSENCE[injuryLabel] || 0;
}

function normalizeTeam(code) {
  const value = String(code || "")
    .trim()
    .toUpperCase();

  return TEAM_ALIASES[value] || value;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function number(value, fallback = 0) {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;
}

function nullableNumber(value) {
  const result = Number(value);

  return value == null ||
    !Number.isFinite(result)
    ? null
    : result;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function round(value) {
  return (
    Math.round(value * 1000) / 1000
  );
}

async function readJson(response) {
  const text = await response.text();

  try {
    return text
      ? JSON.parse(text)
      : {};
  } catch {
    return {
      error:
        text ||
        "Invalid upstream response",
    };
  }
}