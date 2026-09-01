const SLEEPER_PLAYERS_URL =
  "https://api.sleeper.app/v1/players/nfl";

let memoryCache = null;
let memoryCacheExpiresAt = 0;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const team = normalizeTeamCode(req.query.team);

  if (!team) {
    return res.status(400).json({
      error: "A team abbreviation is required",
    });
  }

  try {
    const allPlayers = await getPlayers();

    const teamPlayers = Object.entries(allPlayers)
      .map(([playerId, player]) => ({
        playerId,
        ...player,
      }))
      .filter((player) => {
        return normalizeTeamCode(player.team) === team;
      })
      .map(mapPlayer)
      .sort(sortPlayers);

    const grouped = groupPlayers(teamPlayers);

    return res.status(200).json({
      team,
      count: teamPlayers.length,
      starters: teamPlayers.filter(isStarter),
      reserves: teamPlayers.filter(
        (player) => !isStarter(player)
      ),
      groups: grouped,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Sleeper players request failed", error);

    return res.status(500).json({
      error: "Unable to load Sleeper player data",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

async function getPlayers() {
  const now = Date.now();

  if (memoryCache && now < memoryCacheExpiresAt) {
    return memoryCache;
  }

  const response = await fetch(SLEEPER_PLAYERS_URL);

  if (!response.ok) {
    throw new Error(
      `Sleeper returned HTTP ${response.status}`
    );
  }

  const body = await response.json();

  memoryCache = body;
  memoryCacheExpiresAt =
    now + 12 * 60 * 60 * 1000;

  return body;
}

function mapPlayer(player) {
  return {
    id: player.playerId,
    fullName:
      player.full_name ||
      [player.first_name, player.last_name]
        .filter(Boolean)
        .join(" ") ||
      "Unknown player",

    firstName: player.first_name || "",
    lastName: player.last_name || "",
    team: normalizeTeamCode(player.team),
    position: player.position || "Unknown",
    fantasyPositions:
      player.fantasy_positions || [],

    jerseyNumber:
      player.number ??
      player.jersey_number ??
      null,

    status:
      player.status ||
      player.injury_status ||
      "Unknown",

    injuryStatus:
      player.injury_status || null,

    depthChartPosition:
      player.depth_chart_position ||
      player.position ||
      null,

    depthChartOrder:
      toNumberOrNull(player.depth_chart_order),

    age: toNumberOrNull(player.age),
    height: player.height || null,
    weight: player.weight || null,
    college: player.college || null,

    yearsExperience: toNumberOrNull(
      player.years_exp
    ),

    active:
      String(player.status || "")
        .toLowerCase() === "active",
  };
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

  for (const player of players) {
    groups[getPositionGroup(player.position)].push(
      player
    );
  }

  return groups;
}

function getPositionGroup(position) {
  const code = String(position || "").toUpperCase();

  if (code === "QB") return "Quarterbacks";

  if (["RB", "FB"].includes(code)) {
    return "Running Backs";
  }

  if (["WR"].includes(code)) {
    return "Receivers";
  }

  if (["TE"].includes(code)) {
    return "Tight Ends";
  }

  if (
    ["C", "G", "OG", "T", "OT", "OL"].includes(code)
  ) {
    return "Offensive Line";
  }

  if (
    ["DE", "DT", "DL", "NT"].includes(code)
  ) {
    return "Defensive Line";
  }

  if (
    ["LB", "ILB", "OLB", "MLB"].includes(code)
  ) {
    return "Linebackers";
  }

  if (
    ["CB", "DB", "S", "FS", "SS"].includes(code)
  ) {
    return "Defensive Backs";
  }

  if (
    ["K", "P", "LS", "KR", "PR"].includes(code)
  ) {
    return "Special Teams";
  }

  return "Other";
}

function isStarter(player) {
  return (
    player.active &&
    player.depthChartOrder !== null &&
    player.depthChartOrder === 1
  );
}

function sortPlayers(first, second) {
  const positionComparison =
    first.position.localeCompare(second.position);

  if (positionComparison !== 0) {
    return positionComparison;
  }

  const firstDepth =
    first.depthChartOrder ?? 999;
  const secondDepth =
    second.depthChartOrder ?? 999;

  if (firstDepth !== secondDepth) {
    return firstDepth - secondDepth;
  }

  return first.fullName.localeCompare(
    second.fullName
  );
}

function normalizeTeamCode(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase();

  const aliases = {
    WAS: "WSH",
    LA: "LAR",
  };

  return aliases[normalized] || normalized;
}

function toNumberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}