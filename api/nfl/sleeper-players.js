import fs from "node:fs";
import path from "node:path";

const SLEEPER_PLAYERS_URL =
  "https://api.sleeper.app/v1/players/nfl";

const RATINGS_FILE = path.join(
  process.cwd(),
  "api",
  "nfl",
  "ea_player_records.json"
);

const CACHE_DURATION_MS =
  12 * 60 * 60 * 1000;

let playerCache = null;
let playerCacheExpiresAt = 0;
let ratingsIndex = null;

const TEAM_CODES = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "NY Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WSH",
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const team = normalizeTeamCode(
    req.query.team
  );

  if (!team) {
    return res.status(400).json({
      error:
        "A team abbreviation is required",
    });
  }

  try {
    const allPlayers =
      await getSleeperPlayers();

    const teamPlayers =
      Object.entries(allPlayers)
        .map(
          ([playerId, player]) => ({
            playerId,
            ...player,
          })
        )
        .filter(
          (player) =>
            normalizeTeamCode(
              player.team
            ) === team
        )
        .map((player) =>
          mapPlayer(player, team)
        )
        .sort(sortPlayers);

    const matchedRatings =
      teamPlayers.filter(
        (player) =>
          player.playerRating !== null
      ).length;

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=43200, stale-while-revalidate=86400"
    );

    return res.status(200).json({
      team,
      count: teamPlayers.length,

      matchedRatings,

      unmatchedRatings:
        teamPlayers.length -
        matchedRatings,

      ratingsSource:
        "EA player ratings baseline",

      ratingsAffectPredictions:
        false,

      starters:
        teamPlayers.filter(
          isStarter
        ),

      reserves:
        teamPlayers.filter(
          (player) =>
            !isStarter(player)
        ),

      groups:
        groupPlayers(teamPlayers),

      refreshedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "Sleeper player endpoint failed:",
      error
    );

    return res.status(500).json({
      error:
        "Unable to load Sleeper player data",

      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

async function getSleeperPlayers() {
  const now = Date.now();

  if (
    playerCache &&
    now < playerCacheExpiresAt
  ) {
    return playerCache;
  }

  const response = await fetch(
    SLEEPER_PLAYERS_URL,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Sleeper returned HTTP ${response.status}`
    );
  }

  const body =
    await response.json();

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error(
      "Sleeper returned an invalid player response"
    );
  }

  playerCache = body;

  playerCacheExpiresAt =
    now + CACHE_DURATION_MS;

  return body;
}

function getRatingsIndex() {
  if (ratingsIndex) {
    return ratingsIndex;
  }

  if (
    !fs.existsSync(RATINGS_FILE)
  ) {
    console.warn(
      `EA player ratings file was not found at ${RATINGS_FILE}`
    );

    ratingsIndex =
      createEmptyRatingsIndex();

    return ratingsIndex;
  }

  try {
    const fileContents =
      fs.readFileSync(
        RATINGS_FILE,
        "utf8"
      );

    const records =
      JSON.parse(fileContents);

    if (!Array.isArray(records)) {
      throw new Error(
        "EA player ratings file must contain an array"
      );
    }

    const byNameAndTeam =
      new Map();

    const byNameAndPosition =
      new Map();

    for (const record of records) {
      const fullName = [
        record.firstName,
        record.lastName,
      ]
        .filter(Boolean)
        .join(" ");

      const normalizedName =
        normalizeName(fullName);

      const team =
        normalizeEaTeam(
          record.team
        );

      const position =
        normalizeEaPosition(
          record.position
        );

      const overall =
        toNumberOrNull(
          record.overallRating
        );

      if (
        !normalizedName ||
        overall === null
      ) {
        continue;
      }

      const rating = {
        eaId:
          record.id ?? null,

        overall,

        iteration:
          record.iteration?.label ||
          record.iteration?.name ||
          null,

        attributes:
          extractRatingAttributes(
            record.stats
          ),
      };

      if (team) {
        byNameAndTeam.set(
          `${normalizedName}|${team}`,
          rating
        );
      }

      if (position) {
        byNameAndPosition.set(
          `${normalizedName}|${position}`,
          rating
        );
      }
    }

    ratingsIndex = {
      byNameAndTeam,
      byNameAndPosition,
    };

    return ratingsIndex;
  } catch (error) {
    console.error(
      "Unable to load EA player ratings:",
      error
    );

    ratingsIndex =
      createEmptyRatingsIndex();

    return ratingsIndex;
  }
}

function createEmptyRatingsIndex() {
  return {
    byNameAndTeam:
      new Map(),

    byNameAndPosition:
      new Map(),
  };
}

function findPlayerRating(
  player,
  team
) {
  const index =
    getRatingsIndex();

  const fullName =
    player.full_name ||
    [
      player.first_name,
      player.last_name,
    ]
      .filter(Boolean)
      .join(" ");

  const normalizedName =
    normalizeName(fullName);

  const position =
    normalizePosition(
      player.position
    );

  const teamMatch =
    index.byNameAndTeam.get(
      `${normalizedName}|${team}`
    );

  if (teamMatch) {
    return {
      rating: teamMatch,
      method: "name-team",
      confidence: 0.98,
    };
  }

  const positionMatch =
    index.byNameAndPosition.get(
      `${normalizedName}|${position}`
    );

  if (positionMatch) {
    return {
      rating: positionMatch,
      method: "name-position",
      confidence: 0.9,
    };
  }

  return null;
}

function mapPlayer(
  player,
  team
) {
  const ratingMatch =
    findPlayerRating(
      player,
      team
    );

  const rating =
    ratingMatch?.rating ||
    null;

  return {
    id: player.playerId,

    fullName:
      player.full_name ||
      [
        player.first_name,
        player.last_name,
      ]
        .filter(Boolean)
        .join(" ") ||
      "Unknown player",

    firstName:
      player.first_name ||
      "",

    lastName:
      player.last_name ||
      "",

    team:
      normalizeTeamCode(
        player.team
      ),

    position:
      player.position ||
      "Unknown",

    fantasyPositions:
      player.fantasy_positions ||
      [],

    jerseyNumber:
      player.number ??
      player.jersey_number ??
      null,

    status:
      player.status ||
      player.injury_status ||
      "Unknown",

    injuryStatus:
      player.injury_status ||
      null,

    depthChartPosition:
      player.depth_chart_position ||
      player.position ||
      null,

    depthChartOrder:
      toNumberOrNull(
        player.depth_chart_order
      ),

    age:
      toNumberOrNull(
        player.age
      ),

    height:
      player.height ||
      null,

    weight:
      player.weight ||
      null,

    college:
      player.college ||
      null,

    yearsExperience:
      toNumberOrNull(
        player.years_exp
      ),

    active:
      isRosterEligible(player.status) &&
      !isUnavailableInjury(player.injury_status),

    playerRating:
      rating?.overall ??
      null,

    playerRatingSource:
      rating
        ? "EA player ratings baseline"
        : null,

    playerRatingIteration:
      rating?.iteration ||
      null,

    playerRatingAttributes:
      rating?.attributes ||
      {},

    playerRatingMatch:
      ratingMatch
        ? {
            method:
              ratingMatch.method,

            confidence:
              ratingMatch.confidence,

            eaId:
              rating.eaId,
          }
        : null,

    fourthDownRating:
      null,

    fourthDownRatingStatus:
      "Not yet rated",

    fourthDownRatingConfidence:
      0,

    effectiveRating:
      rating?.overall ??
      null,
  };
}

function extractRatingAttributes(
  stats
) {
  if (
    !stats ||
    typeof stats !== "object"
  ) {
    return {};
  }

  const attributes = {};

  for (
    const [
      key,
      entry,
    ] of Object.entries(stats)
  ) {
    const value =
      entry &&
      typeof entry === "object"
        ? entry.value
        : entry;

    const numericValue =
      toNumberOrNull(value);

    if (
      numericValue !== null
    ) {
      attributes[key] =
        numericValue;
    }
  }

  return attributes;
}

function normalizeEaTeam(team) {
  const label =
    typeof team === "string"
      ? team
      : team?.label ||
        team?.name ||
        team?.shortLabel ||
        "";

  return (
    TEAM_CODES[label] ||
    normalizeTeamCode(label)
  );
}

function normalizeEaPosition(
  position
) {
  const value =
    typeof position === "string"
      ? position
      : position?.shortLabel ||
        position?.abbreviation ||
        position?.id ||
        position?.label ||
        "";

  return normalizePosition(
    value
  );
}

function groupPlayers(players) {
  const groups = {
    Quarterbacks: [],
    "Running Backs": [],
    Receivers: [],
    "Tight Ends": [],
    "Offensive Line": [],
    "Defensive Line": [],
    Linebackers: [],
    "Defensive Backs": [],
    "Special Teams": [],
    Other: [],
  };

  for (
    const player of players
  ) {
    const group =
      getPositionGroup(
        player.position
      );

    groups[group].push(
      player
    );
  }

  return groups;
}

function getPositionGroup(
  position
) {
  const code =
    normalizePosition(
      position
    );

  if (code === "QB") {
    return "Quarterbacks";
  }

  if (
    [
      "RB",
      "HB",
      "FB",
    ].includes(code)
  ) {
    return "Running Backs";
  }

  if (code === "WR") {
    return "Receivers";
  }

  if (code === "TE") {
    return "Tight Ends";
  }

  if (
    [
      "LT",
      "LG",
      "C",
      "RG",
      "RT",
      "G",
      "OG",
      "T",
      "OT",
      "OL",
    ].includes(code)
  ) {
    return "Offensive Line";
  }

  if (
    [
      "DE",
      "DT",
      "DL",
      "NT",
      "LEDG",
      "REDG",
    ].includes(code)
  ) {
    return "Defensive Line";
  }

  if (
    [
      "LB",
      "ILB",
      "OLB",
      "MLB",
      "MIKE",
      "WILL",
      "SAM",
    ].includes(code)
  ) {
    return "Linebackers";
  }

  if (
    [
      "CB",
      "DB",
      "S",
      "FS",
      "SS",
    ].includes(code)
  ) {
    return "Defensive Backs";
  }

  if (
    [
      "K",
      "P",
      "LS",
      "KR",
      "PR",
    ].includes(code)
  ) {
    return "Special Teams";
  }

  return "Other";
}

function isRosterEligible(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  return status === "active" || status === "unknown";
}
function isUnavailableInjury(value) {
  const status = String(value || "").trim().toLowerCase();
  return status === "out" || status === "ir" || status.includes("injured reserve") || status === "pup" || status.includes("suspend") || status.includes("inactive");
}

function isStarter(player) {
  return (
    player.active &&
    player.depthChartOrder === 1
  );
}

function sortPlayers(
  first,
  second
) {
  const positionComparison =
    String(
      first.position || ""
    ).localeCompare(
      String(
        second.position || ""
      )
    );

  if (
    positionComparison !== 0
  ) {
    return positionComparison;
  }

  const depthComparison =
    (
      first.depthChartOrder ??
      999
    ) -
    (
      second.depthChartOrder ??
      999
    );

  if (
    depthComparison !== 0
  ) {
    return depthComparison;
  }

  return String(
    first.fullName || ""
  ).localeCompare(
    String(
      second.fullName || ""
    )
  );
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /\b(jr|sr|ii|iii|iv)\b/g,
      ""
    )
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

function normalizePosition(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeTeamCode(code) {
  const normalized =
    String(code || "")
      .trim()
      .toUpperCase();

  const aliases = {
    WAS: "WSH",
    LA: "LAR",
    OAK: "LV",
    SD: "LAC",
    STL: "LAR",
  };

  return (
    aliases[normalized] ||
    normalized
  );
}

function toNumberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}