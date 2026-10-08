const ESPN_URL =
  "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete";

const SLEEPER_URL =
  "https://api.sleeper.app/v1/players/nfl";

const CACHE_DURATION_MS =
  6 * 60 * 60 * 1000;

const cache = new Map();

const TEAM_ALIASES = {
  WAS: "WSH",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

const LEAGUE_PRIORS = {
  under30: {
    accuracy: 0.97,
    priorAttempts: 18,
  },
  from30to39: {
    accuracy: 0.92,
    priorAttempts: 22,
  },
  from40to49: {
    accuracy: 0.82,
    priorAttempts: 26,
  },
  from50plus: {
    accuracy: 0.68,
    priorAttempts: 32,
  },
  extraPoint: {
    accuracy: 0.95,
    priorAttempts: 24,
  },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const away = normalizeTeamCode(
    req.query.away
  );

  const home = normalizeTeamCode(
    req.query.home
  );

  const requestedSeason = Number(
    req.query.season || 2025
  );

  if (!away || !home) {
    return res.status(400).json({
      error:
        "Away and home team abbreviations are required",
    });
  }

  if (!Number.isInteger(requestedSeason)) {
    return res.status(400).json({
      error: "Invalid season",
    });
  }

  try {
    const [
      sleeperPlayers,
      espnProfiles,
    ] = await Promise.all([
      getSleeperPlayers(),
      getEspnKickingProfiles(
        requestedSeason
      ),
    ]);

    const awayKicker =
      findActiveKicker(
        sleeperPlayers,
        away
      );

    const homeKicker =
      findActiveKicker(
        sleeperPlayers,
        home
      );

    const awayProfile =
      matchEspnProfile(
        awayKicker,
        espnProfiles
      );

    const homeProfile =
      matchEspnProfile(
        homeKicker,
        espnProfiles
      );

    return res.status(200).json({
      requestedSeason,
      sourceSeason: requestedSeason,
      away: buildKickerResult(
        away,
        awayKicker,
        awayProfile
      ),
      home: buildKickerResult(
        home,
        homeKicker,
        homeProfile
      ),
      leaguePriors: LEAGUE_PRIORS,
      source: "ESPN",
      refreshedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.warn(
      "ESPN kicker lookup failed:",
      error
    );

    return res.status(200).json({
      requestedSeason,
      sourceSeason: null,
      away: buildFallbackKicker(away),
      home: buildFallbackKicker(home),
      leaguePriors: LEAGUE_PRIORS,
      source:
        "League-average fallback",
      warning:
        error instanceof Error
          ? error.message
          : String(error),
      refreshedAt:
        new Date().toISOString(),
    });
  }
}

async function getSleeperPlayers() {
  const cacheKey = "sleeper-players";
  const cached = getCached(cacheKey);

  if (cached) {
    return cached;
  }

  const response = await fetch(
    SLEEPER_URL,
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

  const body = await response.json();

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error(
      "Sleeper returned invalid player data"
    );
  }

  const players = Object.entries(
    body
  ).map(([id, player]) => ({
    id,
    ...player,
  }));

  setCached(cacheKey, players);

  return players;
}

async function getEspnKickingProfiles(
  season
) {
  const cacheKey =
    `espn-kicking-${season}`;

  const cached = getCached(cacheKey);

  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({
    region: "us",
    lang: "en",
    contentorigin: "espn",
    isqualified: "false",
    page: "1",
    limit: "100",
    season: String(season),
    seasontype: "2",
    category: "kicking",
  });

  const response = await fetch(
    `${ESPN_URL}?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; FourthDown/1.0)",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `ESPN returned HTTP ${response.status}`
    );
  }

  const body = await response.json();

  const entries = collectAthleteEntries(
    body
  );

  const profiles = entries
    .map(parseEspnAthlete)
    .filter(
      (profile) =>
        profile.name &&
        hasKickingData(profile)
    );

  if (!profiles.length) {
    throw new Error(
      "ESPN returned no usable kicking profiles"
    );
  }

  setCached(cacheKey, profiles);

  return profiles;
}

function collectAthleteEntries(
  value,
  entries = [],
  visited = new Set()
) {
  if (
    !value ||
    typeof value !== "object" ||
    visited.has(value)
  ) {
    return entries;
  }

  visited.add(value);

  const athlete =
    value.athlete || value.player;

  if (
    athlete &&
    (
      value.stats ||
      value.statistics ||
      value.categories
    )
  ) {
    entries.push(value);
  }

  if (
    value.displayName &&
    value.team &&
    (
      value.stats ||
      value.statistics
    )
  ) {
    entries.push(value);
  }

  for (
    const child of Object.values(value)
  ) {
    if (
      child &&
      typeof child === "object"
    ) {
      collectAthleteEntries(
        child,
        entries,
        visited
      );
    }
  }

  return entries;
}

function parseEspnAthlete(entry) {
  const athlete =
    entry.athlete ||
    entry.player ||
    entry;

  const stats = flattenStats(entry);

  const oneToNineteen =
    parseMadeAttempt(
      findStat(stats, [
        "1-19",
        "fg 1-19",
        "field goals 1-19",
      ])
    );

  const twentyToTwentyNine =
    parseMadeAttempt(
      findStat(stats, [
        "20-29",
        "fg 20-29",
        "field goals 20-29",
      ])
    );

  const under30 = {
    made:
      oneToNineteen.made +
      twentyToTwentyNine.made,
    attempts:
      oneToNineteen.attempts +
      twentyToTwentyNine.attempts,
  };

  return {
    id: String(
      athlete.id || entry.id || ""
    ),
    name:
      athlete.displayName ||
      athlete.fullName ||
      athlete.name ||
      entry.displayName ||
      entry.fullName ||
      "",
    team: normalizeTeamCode(
      athlete.team?.abbreviation ||
        entry.team?.abbreviation ||
        athlete.team?.shortDisplayName ||
        entry.team?.shortDisplayName
    ),
    under30,
    from30to39: parseMadeAttempt(
      findStat(stats, [
        "30-39",
        "fg 30-39",
        "field goals 30-39",
      ])
    ),
    from40to49: parseMadeAttempt(
      findStat(stats, [
        "40-49",
        "fg 40-49",
        "field goals 40-49",
      ])
    ),
    from50plus: parseMadeAttempt(
      findStat(stats, [
        "50+",
        "50 plus",
        "fg 50+",
        "field goals 50+",
      ])
    ),
    extraPoint: parseMadeAttempt(
      findStat(stats, [
        "xpm-xpa",
        "extra points",
        "extra point",
        "xp",
      ])
    ),
    overall: parseMadeAttempt(
      findStat(stats, [
        "fgm-fga",
        "field goals",
        "field goal",
      ])
    ),
  };
}

function flattenStats(
  value,
  output = [],
  visited = new Set()
) {
  if (
    !value ||
    typeof value !== "object" ||
    visited.has(value)
  ) {
    return output;
  }

  visited.add(value);

  const label =
    value.displayName ||
    value.name ||
    value.label ||
    value.abbreviation;

  const statValue =
    value.displayValue ??
    value.value ??
    value.stat ??
    value.summary;

  if (
    label &&
    (
      typeof statValue === "string" ||
      typeof statValue === "number"
    )
  ) {
    output.push({
      label: String(label),
      value: statValue,
    });
  }

  for (
    const child of Object.values(value)
  ) {
    if (
      child &&
      typeof child === "object"
    ) {
      flattenStats(
        child,
        output,
        visited
      );
    }
  }

  return output;
}

function findStat(stats, names) {
  const expectedLabels =
    names.map(normalizeLabel);

  const exactMatch = stats.find(
    (stat) =>
      expectedLabels.includes(
        normalizeLabel(stat.label)
      )
  );

  if (exactMatch) {
    return exactMatch.value;
  }

  const partialMatch = stats.find(
    (stat) =>
      expectedLabels.some(
        (expected) =>
          normalizeLabel(
            stat.label
          ).includes(expected)
      )
  );

  return partialMatch?.value ?? null;
}

function parseMadeAttempt(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return {
      made: 0,
      attempts: 0,
    };
  }

  const text = String(value);

  const match = text.match(
    /(\d+)\s*[-/]\s*(\d+)/
  );

  if (!match) {
    return {
      made: 0,
      attempts: 0,
    };
  }

  return {
    made: Number(match[1]),
    attempts: Number(match[2]),
  };
}

function findActiveKicker(
  players,
  team
) {
  const kickers = players
    .filter(
      (player) =>
        normalizeTeamCode(
          player.team
        ) === team &&
        ["K", "PK"].includes(
          String(
            player.position ||
              player.depth_chart_position ||
              ""
          ).toUpperCase()
        )
    )
    .map((player) => ({
      id: player.id,
      name:
        player.full_name ||
        [
          player.first_name,
          player.last_name,
        ]
          .filter(Boolean)
          .join(" "),
      team,
      depth:
        numberOrNull(
          player.depth_chart_order
        ) ?? 99,
      injuryStatus:
        player.injury_status || null,
      status:
        player.status || null,
    }))
    .filter(isLikelyAvailable)
    .sort(
      (first, second) =>
        first.depth - second.depth
    );

  return kickers[0] || null;
}

function isLikelyAvailable(player) {
  const status = String(
    player.status || ""
  ).toLowerCase();

  const injury = String(
    player.injuryStatus || ""
  ).toLowerCase();

  if (
    status.includes("inactive") ||
    status.includes("injured reserve") ||
    status === "ir" ||
    injury === "out"
  ) {
    return false;
  }

  return true;
}

function matchEspnProfile(
  sleeperKicker,
  profiles
) {
  if (!sleeperKicker) {
    return null;
  }

  const expectedName = normalizeName(
    sleeperKicker.name
  );

  const exactMatch = profiles.find(
    (profile) =>
      normalizeName(profile.name) ===
      expectedName
  );

  if (exactMatch) {
    return exactMatch;
  }

  return (
    profiles.find(
      (profile) =>
        profile.team ===
        sleeperKicker.team
    ) || null
  );
}

function buildKickerResult(
  team,
  sleeperKicker,
  espnProfile
) {
  if (!espnProfile) {
    return buildFallbackKicker(
      team,
      sleeperKicker
    );
  }

  return {
    id:
      sleeperKicker?.id ||
      espnProfile.id ||
      null,
    name:
      sleeperKicker?.name ||
      espnProfile.name ||
      "Unknown kicker",
    team,
    matched: true,
    source: "ESPN",
    under30:
      espnProfile.under30,
    from30to39:
      espnProfile.from30to39,
    from40to49:
      espnProfile.from40to49,
    from50plus:
      espnProfile.from50plus,
    extraPoint:
      espnProfile.extraPoint,
    overall:
      espnProfile.overall,
  };
}

function buildFallbackKicker(
  team,
  sleeperKicker = null
) {
  return {
    id: sleeperKicker?.id || null,
    name:
      sleeperKicker?.name ||
      "League-average kicker",
    team,
    matched: false,
    source:
      "League-average fallback",
    under30: {
      made: 0,
      attempts: 0,
    },
    from30to39: {
      made: 0,
      attempts: 0,
    },
    from40to49: {
      made: 0,
      attempts: 0,
    },
    from50plus: {
      made: 0,
      attempts: 0,
    },
    extraPoint: {
      made: 0,
      attempts: 0,
    },
    overall: {
      made: 0,
      attempts: 0,
    },
  };
}

function hasKickingData(profile) {
  return (
    profile.under30.attempts +
      profile.from30to39.attempts +
      profile.from40to49.attempts +
      profile.from50plus.attempts +
      profile.extraPoint.attempts >
    0
  );
}

function getCached(key) {
  const item = cache.get(key);

  if (
    item &&
    item.expiresAt > Date.now()
  ) {
    return item.value;
  }

  cache.delete(key);

  return null;
}

function setCached(key, value) {
  cache.set(key, {
    value,
    expiresAt:
      Date.now() +
      CACHE_DURATION_MS,
  });
}

function normalizeTeamCode(code) {
  const normalized = String(
    code || ""
  )
    .trim()
    .toUpperCase();

  return (
    TEAM_ALIASES[normalized] ||
    normalized
  );
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]/g, "");
}

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}