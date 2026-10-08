import { gunzipSync } from "node:zlib";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const season = Number(
  process.argv[2] ||
    new Date().getUTCFullYear()
);

const outputPath = path.resolve(
  "data/nflverse-player-metrics.js"
);

const sourceUrl =
  "https://github.com/nflverse/" +
  "nflverse-data/releases/download/" +
  `pbp/play_by_play_${season}.csv.gz`;

const aliases = {
  WAS: "WSH",
  LA: "LAR",
  JAC: "JAX",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

console.log(
  `Downloading nflverse ${season} play-by-play for player metrics...`
);

const response = await fetch(
  sourceUrl
);

if (!response.ok) {
  throw new Error(
    `nflverse returned HTTP ${response.status}`
  );
}

const compressedBytes =
  Buffer.from(
    await response.arrayBuffer()
  );

const text = gunzipSync(
  compressedBytes
).toString("utf8");

const rows = parseCsv(text);

const plays = rows
  .map(parsePlay)
  .filter(isEligible);

const completedWeeks = [
  ...new Set(
    plays
      .map((play) => play.week)
      .filter(Boolean)
  ),
].sort(
  (first, second) =>
    first - second
);

const playerMetricsByWeek = {};

for (
  const predictionWeek
  of completedWeeks.map(
    (week) => week + 1
  )
) {
  const eligible = plays.filter(
    (play) =>
      play.week < predictionWeek
  );

  const teams = [
    ...new Set(
      eligible
        .map((play) => play.team)
        .filter(Boolean)
    ),
  ];

  playerMetricsByWeek[
    predictionWeek
  ] = Object.fromEntries(
    teams.map((teamCode) => [
      teamCode,
      buildTeamPlayerMetrics(
        eligible,
        teamCode
      ),
    ])
  );
}

const payload = {
  season,

  generatedAt:
    new Date().toISOString(),

  source:
    "nflverse/nflfastR play-by-play",

  sourceUrl,

  garbageTimeFilter:
    "Win probability between 5% and 95%",
  latestCompletedWeek: completedWeeks.length ? Math.max(...completedWeeks) : null,
  requiredFields: ["game_id", "week", "posteam", "defteam", "play_type"],
  playerMetricsByWeek,
};

await mkdir(
  path.dirname(outputPath),
  {
    recursive: true,
  }
);

await writeFile(
  outputPath,

  `const NFLVERSE_PLAYER_METRICS = ${JSON.stringify(
    payload,
    null,
    2
  )};\n\nexport default NFLVERSE_PLAYER_METRICS;\n`
);

const generatedWeeks =
  Object.keys(
    playerMetricsByWeek
  ).map(Number);

const latestWeek =
  generatedWeeks.length
    ? Math.max(...generatedWeeks)
    : null;

const latestTeams =
  latestWeek !== null
    ? playerMetricsByWeek[
        latestWeek
      ] || {}
    : {};

const playerCount =
  Object.values(
    latestTeams
  ).reduce(
    (total, teamEntry) =>
      total +
      Object.keys(
        teamEntry.players || {}
      ).length,
    0
  );

console.log(
  `Wrote ${outputPath}`
);

console.log(
  `Eligible plays: ${plays.length} | ` +
    `latest player profiles: ${playerCount}`
);

function buildTeamPlayerMetrics(
  allPlays,
  teamCode
) {
  const offense = allPlays.filter(
    (play) =>
      play.team === teamCode
  );

  const games = new Set(
    offense.map(
      (play) => play.gameId
    )
  );

  const players = new Map();

  const totals = {
    games: games.size,

    passAttempts:
      sum(
        offense,
        "passAttempt"
      ),

    completions:
      sum(
        offense,
        "completePass"
      ),

    passingYards:
      sum(
        offense,
        "passingYards"
      ),

    passingTouchdowns:
      sum(
        offense,
        "passingTouchdown"
      ),

    interceptions:
      sum(offense, "interception"),
    fumbles: sum(offense, "fumble"),
    fumblesLost: sum(offense, "fumbleLost"),
    qbScrambles: sum(offense, "qbScramble"),

    sacksAllowed:
      sum(
        offense,
        "sack"
      ),

    rushingAttempts:
      sum(
        offense,
        "rushAttempt"
      ),

    rushingYards:
      sum(
        offense,
        "rushingYards"
      ),

    rushingTouchdowns:
      sum(
        offense,
        "rushingTouchdown"
      ),

    targets:
      sum(
        offense,
        "target"
      ),

    receptions:
      offense.filter(
        (play) =>
          play.target &&
          play.completePass
      ).length,

    receivingYards:
      sum(
        offense,
        "receivingYards"
      ),

    receivingTouchdowns:
      sum(
        offense,
        "receivingTouchdown"
      ),

    airYards:
      sum(
        offense,
        "airYards"
      ),

    yardsAfterCatch:
      sum(
        offense,
        "yardsAfterCatch"
      ),

    redZoneCarries:
      offense.filter(
        (play) =>
          play.redZone &&
          play.rushAttempt
      ).length,

    goalLineCarries:
      offense.filter(
        (play) =>
          play.goalLine &&
          play.rushAttempt
      ).length,

    redZoneTargets:
      offense.filter(
        (play) =>
          play.redZone &&
          play.target
      ).length,

    goalLineTargets:
      offense.filter(
        (play) =>
          play.goalLine &&
          play.target
      ).length,

    endZoneTargets:
      offense.filter(
        (play) =>
          play.endZoneTarget
      ).length,
  };

  for (
    const play of offense
  ) {
    if (
      play.passerName &&
      (
        play.passAttempt ||
        play.sack
      )
    ) {
      const player =
        getPlayer(
          players,
          play.passerId,
          play.passerName,
          teamCode,
          "QB"
        );

      recordGame(
        player,
        play
      );

      player.dropbacks +=
        play.passAttempt +
        play.sack;

      player.passAttempts +=
        play.passAttempt;

      player.completions +=
        play.completePass;

      player.passingYards +=
        play.passingYards;

      player.passingTouchdowns +=
        play.passingTouchdown;

      player.interceptions +=
        play.interception;

      player.sacksTaken +=
        play.sack;

      recordPassingUsage(
        player,
        play
      );
    }

    if (
      play.rusherName &&
      play.rushAttempt
    ) {
      const player =
        getPlayer(
          players,
          play.rusherId,
          play.rusherName,
          teamCode,
          null
        );

      recordGame(
        player,
        play
      );

      player.rushingAttempts += 1;

      player.rushingYards +=
        play.rushingYards;

      player.rushingTouchdowns +=
        play.rushingTouchdown;

      player.redZoneCarries +=
        play.redZone
          ? 1
          : 0;

      player.goalLineCarries +=
        play.goalLine
          ? 1
          : 0;

      player.explosiveRushes +=
        play.rushingYards >= 10
          ? 1
          : 0;

      recordUsage(
        player,
        play,
        "rushingAttempts",
        1
      );

      recordUsage(
        player,
        play,
        "rushingYards",
        play.rushingYards
      );

      recordUsage(
        player,
        play,
        "rushingTouchdowns",
        play.rushingTouchdown
      );
    }

    if (
      play.receiverName &&
      play.target
    ) {
      const player =
        getPlayer(
          players,
          play.receiverId,
          play.receiverName,
          teamCode,
          null
        );

      recordGame(
        player,
        play
      );

      player.targets += 1;

      player.receptions +=
        play.completePass;

      player.receivingYards +=
        play.receivingYards;

      player.receivingTouchdowns +=
        play.receivingTouchdown;

      player.airYards +=
        play.airYards;

      player.yardsAfterCatch +=
        play.yardsAfterCatch;

      player.redZoneTargets +=
        play.redZone
          ? 1
          : 0;

      player.goalLineTargets +=
        play.goalLine
          ? 1
          : 0;

      player.endZoneTargets +=
        play.endZoneTarget
          ? 1
          : 0;

      player.explosiveReceptions +=
        play.completePass &&
        play.receivingYards >= 20
          ? 1
          : 0;

      recordUsage(
        player,
        play,
        "targets",
        1
      );

      recordUsage(
        player,
        play,
        "receptions",
        play.completePass
      );

      recordUsage(
        player,
        play,
        "receivingYards",
        play.receivingYards
      );

      recordUsage(
        player,
        play,
        "receivingTouchdowns",
        play.receivingTouchdown
      );
    }
  }

  const finalPlayers = [
    ...players.values(),
  ]
    .map(
      (player) =>
        finalisePlayer(
          player,
          totals
        )
    )
    .filter(
      (player) =>
        player.opportunities > 0
    )
    .sort(
      (first, second) =>
        second.opportunities -
        first.opportunities
    );

  return {
    team: teamCode,
    games: games.size,
    teamTotals: totals,

    players:
      Object.fromEntries(
        finalPlayers.map(
          (player) => [
            player.playerId,
            player,
          ]
        )
      ),
  };
}

function getPlayer(
  map,
  id,
  name,
  teamCode,
  position
) {
  const key =
    id ||
    `${teamCode}:${normaliseName(
      name
    )}`;

  if (!map.has(key)) {
    map.set(
      key,
      {
        playerId: key,
        gsisId: id || null,
        playerName: name,
        team: teamCode,
        position,

        gameIds: new Set(),
        weeks: new Set(),
        gameUsage: new Map(),

        dropbacks: 0,
        passAttempts: 0,
        completions: 0,
        passingYards: 0,
        passingTouchdowns: 0,
        interceptions: 0,
        sacksTaken: 0,

        rushingAttempts: 0,
        rushingYards: 0,
        rushingTouchdowns: 0,
        redZoneCarries: 0,
        goalLineCarries: 0,
        explosiveRushes: 0,

        targets: 0,
        receptions: 0,
        receivingYards: 0,
        receivingTouchdowns: 0,
        airYards: 0,
        yardsAfterCatch: 0,
        redZoneTargets: 0,
        goalLineTargets: 0,
        endZoneTargets: 0,
        explosiveReceptions: 0,
      }
    );
  }

  const player =
    map.get(key);

  if (
    !player.position &&
    position
  ) {
    player.position =
      position;
  }

  return player;
}

function recordGame(
  player,
  play
) {
  if (play.gameId) {
    player.gameIds.add(
      play.gameId
    );
  }

  if (play.week) {
    player.weeks.add(
      play.week
    );
  }
}

function createUsageRow(
  play
) {
  return {
    gameId:
      play.gameId,

    week:
      play.week,

    passAttempts: 0,
    completions: 0,
    passingYards: 0,
    passingTouchdowns: 0,

    rushingAttempts: 0,
    rushingYards: 0,
    rushingTouchdowns: 0,

    targets: 0,
    receptions: 0,
    receivingYards: 0,
    receivingTouchdowns: 0,
  };
}

function recordUsage(
  player,
  play,
  field,
  value
) {
  if (!play.gameId) {
    return;
  }

  const game =
    player.gameUsage.get(
      play.gameId
    ) ||
    createUsageRow(play);

  game[field] +=
    Number(value) || 0;

  player.gameUsage.set(
    play.gameId,
    game
  );
}

function recordPassingUsage(
  player,
  play
) {
  recordUsage(
    player,
    play,
    "passAttempts",
    play.passAttempt
  );

  recordUsage(
    player,
    play,
    "completions",
    play.completePass
  );

  recordUsage(
    player,
    play,
    "passingYards",
    play.passingYards
  );

  recordUsage(
    player,
    play,
    "passingTouchdowns",
    play.passingTouchdown
  );
}

function finalisePlayer(
  player,
  totals
) {
  const games =
    Math.max(
      1,
      player.gameIds.size
    );

  const gameRows = [
    ...player.gameUsage.values(),
  ].sort(
    (first, second) =>
      first.week -
      second.week
  );

  const recentRows =
    gameRows.slice(-2);

  const recent =
    aggregateGameUsage(
      recentRows
    );

  const opportunities =
    player.passAttempts +
    player.rushingAttempts +
    player.targets;

  const touches =
    player.rushingAttempts +
    player.receptions;

  const position =
    player.position ||
    inferPosition(player);

  return {
    playerId:
      player.playerId,

    gsisId:
      player.gsisId,

    playerName:
      player.playerName,

    team:
      player.team,

    position,

    games:
      player.gameIds.size,

    weeks: [
      ...player.weeks,
    ].sort(
      (first, second) =>
        first - second
    ),

    opportunities,
    touches,

    passing: {
      dropbacks:
        player.dropbacks,

      attempts:
        player.passAttempts,

      completions:
        player.completions,

      yards:
        player.passingYards,

      touchdowns:
        player.passingTouchdowns,

      interceptions:
        player.interceptions,

      sacksTaken:
        player.sacksTaken,

      completionRate:
        rate(
          player.completions,
          player.passAttempts
        ),

      yardsPerAttempt:
        rate(
          player.passingYards,
          player.passAttempts
        ),

      attemptsPerGame:
        averagePerGame(
          player.passAttempts,
          games
        ),

      completionsPerGame:
        averagePerGame(
          player.completions,
          games
        ),

      yardsPerGame:
        averagePerGame(
          player.passingYards,
          games
        ),

      touchdownsPerGame:
        averagePerGame(
          player.passingTouchdowns,
          games
        ),
    },

    rushing: {
      attempts:
        player.rushingAttempts,

      yards:
        player.rushingYards,

      touchdowns:
        player.rushingTouchdowns,

      yardsPerCarry:
        rate(
          player.rushingYards,
          player.rushingAttempts
        ),

      attemptsPerGame:
        averagePerGame(
          player.rushingAttempts,
          games
        ),

      yardsPerGame:
        averagePerGame(
          player.rushingYards,
          games
        ),

      touchdownsPerGame:
        averagePerGame(
          player.rushingTouchdowns,
          games
        ),

      carryShare:
        rate(
          player.rushingAttempts,
          totals.rushingAttempts
        ),

      redZoneCarries:
        player.redZoneCarries,

      redZoneCarryShare:
        rate(
          player.redZoneCarries,
          totals.redZoneCarries
        ),

      goalLineCarries:
        player.goalLineCarries,

      goalLineCarryShare:
        rate(
          player.goalLineCarries,
          totals.goalLineCarries
        ),

      explosiveRushRate:
        rate(
          player.explosiveRushes,
          player.rushingAttempts
        ),
    },

    receiving: {
      targets:
        player.targets,

      receptions:
        player.receptions,

      yards:
        player.receivingYards,

      touchdowns:
        player.receivingTouchdowns,

      catchRate:
        rate(
          player.receptions,
          player.targets
        ),

      yardsPerTarget:
        rate(
          player.receivingYards,
          player.targets
        ),

      yardsPerReception:
        rate(
          player.receivingYards,
          player.receptions
        ),

      targetsPerGame:
        averagePerGame(
          player.targets,
          games
        ),

      receptionsPerGame:
        averagePerGame(
          player.receptions,
          games
        ),

      yardsPerGame:
        averagePerGame(
          player.receivingYards,
          games
        ),

      touchdownsPerGame:
        averagePerGame(
          player.receivingTouchdowns,
          games
        ),

      targetShare:
        rate(
          player.targets,
          totals.targets
        ),

      airYards:
        player.airYards,

      airYardsShare:
        rate(
          player.airYards,
          totals.airYards
        ),

      yardsAfterCatch:
        player.yardsAfterCatch,

      redZoneTargets:
        player.redZoneTargets,

      redZoneTargetShare:
        rate(
          player.redZoneTargets,
          totals.redZoneTargets
        ),

      goalLineTargets:
        player.goalLineTargets,

      goalLineTargetShare:
        rate(
          player.goalLineTargets,
          totals.goalLineTargets
        ),

      endZoneTargets:
        player.endZoneTargets,

      endZoneTargetShare:
        rate(
          player.endZoneTargets,
          totals.endZoneTargets
        ),

      explosiveReceptionRate:
        rate(
          player.explosiveReceptions,
          player.receptions
        ),
    },

    combined: {
      rushingReceivingYards:
        player.rushingYards +
        player.receivingYards,

      yardsPerGame:
        averagePerGame(
          player.rushingYards +
            player.receivingYards,
          games
        ),

      opportunities:
        player.rushingAttempts +
        player.targets,

      opportunityShare:
        rate(
          player.rushingAttempts +
            player.targets,

          totals.rushingAttempts +
            totals.targets
        ),
    },

    recent: {
      games:
        recentRows.length,

      passAttemptsPerGame:
        averagePerGame(
          recent.passAttempts,
          recentRows.length
        ),

      completionsPerGame:
        averagePerGame(
          recent.completions,
          recentRows.length
        ),

      passingYardsPerGame:
        averagePerGame(
          recent.passingYards,
          recentRows.length
        ),

      rushingAttemptsPerGame:
        averagePerGame(
          recent.rushingAttempts,
          recentRows.length
        ),

      rushingYardsPerGame:
        averagePerGame(
          recent.rushingYards,
          recentRows.length
        ),

      targetsPerGame:
        averagePerGame(
          recent.targets,
          recentRows.length
        ),

      receptionsPerGame:
        averagePerGame(
          recent.receptions,
          recentRows.length
        ),

      receivingYardsPerGame:
        averagePerGame(
          recent.receivingYards,
          recentRows.length
        ),
    },

    gameLog:
      gameRows,
  };
}

function aggregateGameUsage(
  rows
) {
  return rows.reduce(
    (total, row) => ({
      passAttempts:
        total.passAttempts +
        row.passAttempts,

      completions:
        total.completions +
        row.completions,

      passingYards:
        total.passingYards +
        row.passingYards,

      passingTouchdowns:
        total.passingTouchdowns +
        row.passingTouchdowns,

      rushingAttempts:
        total.rushingAttempts +
        row.rushingAttempts,

      rushingYards:
        total.rushingYards +
        row.rushingYards,

      rushingTouchdowns:
        total.rushingTouchdowns +
        row.rushingTouchdowns,

      targets:
        total.targets +
        row.targets,

      receptions:
        total.receptions +
        row.receptions,

      receivingYards:
        total.receivingYards +
        row.receivingYards,

      receivingTouchdowns:
        total.receivingTouchdowns +
        row.receivingTouchdowns,
    }),

    {
      passAttempts: 0,
      completions: 0,
      passingYards: 0,
      passingTouchdowns: 0,

      rushingAttempts: 0,
      rushingYards: 0,
      rushingTouchdowns: 0,

      targets: 0,
      receptions: 0,
      receivingYards: 0,
      receivingTouchdowns: 0,
    }
  );
}

function parsePlay(row) {
  const passAttempt =
    number(
      row.pass_attempt
    ) ??
    (
      number(row.pass) === 1 &&
      number(row.sack) !== 1 &&
      number(
        row.qb_scramble
      ) !== 1
        ? 1
        : 0
    );

  const rushAttempt =
    number(
      row.rush_attempt
    ) ??
    (
      number(row.rush) === 1 &&
      row.play_type !==
        "qb_kneel"
        ? 1
        : 0
    );

  const completePass =
    number(
      row.complete_pass
    ) || 0;

  const sack =
    number(row.sack) || 0;

  const interception =
    number(
      row.interception
    ) || 0;

  const receiverName =
    clean(
      row.receiver_player_name ||
      row.receiver
    );

  const yardline100 =
    number(
      row.yardline_100
    );

  const airYards =
    number(
      row.air_yards
    );

  const passerId =
    clean(
      row.passer_player_id
    );

  const passerName =
    clean(
      row.passer_player_name ||
      row.passer
    );

  const rusherId =
    clean(
      row.rusher_player_id
    );

  const rusherName =
    clean(
      row.rusher_player_name ||
      row.rusher
    );

  const receiverId =
    clean(
      row.receiver_player_id
    );

  const passingTouchdown =
    number(
      row.pass_touchdown
    ) || 0;

  const rushingTouchdown =
    number(
      row.rush_touchdown
    ) || 0;

  const receivingTouchdown =
    receiverName
      ? passingTouchdown
      : 0;

  return {
    gameId:
      row.game_id || "",

    seasonType:
      row.season_type || "",

    week:
      number(row.week) || 0,

    team:
      team(row.posteam),

    opponent:
      team(row.defteam),

    playType:
      row.play_type || "",

    wp:
      number(row.wp),

    passAttempt,
    rushAttempt,
    completePass,
    sack,
    interception,
    fumble: number(row.fumble) || 0,
    fumbleLost: number(row.fumble_lost) || 0,
    qbScramble: number(row.qb_scramble) || 0,

    passingYards:
      number(
        row.passing_yards
      ) || 0,

    rushingYards:
      number(
        row.rushing_yards
      ) || 0,

    receivingYards:
      number(
        row.receiving_yards
      ) || 0,

    passingTouchdown,
    rushingTouchdown,
    receivingTouchdown,

    airYards:
      airYards || 0,

    yardsAfterCatch:
      number(
        row.yards_after_catch
      ) || 0,

    passerId,
    passerName,

    rusherId,
    rusherName,

    receiverId,
    receiverName,

    target:
      receiverName &&
      passAttempt === 1
        ? 1
        : 0,

    redZone:
      yardline100 !== null &&
      yardline100 <= 20,

    goalLine:
      yardline100 !== null &&
      yardline100 <= 5,

    endZoneTarget:
      Boolean(
        receiverName &&
        passAttempt === 1 &&
        yardline100 !== null &&
        airYards !== null &&
        airYards >=
          yardline100
      ),
  };
}

function isEligible(play) {
  return (
    play.seasonType ===
      "REG" &&

    play.team &&
    play.opponent &&

    ![
      "no_play",
      "qb_kneel",
      "qb_spike",
    ].includes(
      play.playType
    ) &&

    (
      play.wp === null ||
      (
        play.wp >= 0.05 &&
        play.wp <= 0.95
      )
    )
  );
}

function parseCsv(text) {
  const lines =
    text.split(/\r?\n/);

  const headers =
    parseCsvLine(
      lines.shift() || ""
    );

  return lines
    .filter(Boolean)
    .map((line) => {
      const values =
        parseCsvLine(line);

      return Object.fromEntries(
        headers.map(
          (
            header,
            index
          ) => [
            header,
            values[index] ??
              "",
          ]
        )
      );
    });
}

function parseCsvLine(line) {
  const values = [];

  let value = "";
  let quoted = false;

  for (
    let index = 0;
    index < line.length;
    index += 1
  ) {
    const character =
      line[index];

    if (character === '"') {
      if (
        quoted &&
        line[index + 1] ===
          '"'
      ) {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (
      character === "," &&
      !quoted
    ) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value);

  return values;
}

function inferPosition(
  player
) {
  if (
    player.passAttempts > 0
  ) {
    return "QB";
  }

  if (
    player.rushingAttempts >
    player.targets
  ) {
    return "RB";
  }

  return "WR/TE";
}

function normaliseName(value) {
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

function clean(value) {
  const text =
    String(value || "")
      .trim();

  return (
    text &&
    text !== "NA"
      ? text
      : null
  );
}

function number(value) {
  if (
    value === undefined ||
    value === "" ||
    value === "NA"
  ) {
    return null;
  }

  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : null;
}

function team(value) {
  const code =
    String(value || "")
      .trim()
      .toUpperCase();

  return (
    aliases[code] ||
    code
  );
}

function sum(
  rows,
  field
) {
  return rows.reduce(
    (total, row) =>
      total +
      (
        Number(
          row[field]
        ) || 0
      ),
    0
  );
}

function rate(
  numerator,
  denominator
) {
  return denominator
    ? round(
        numerator /
        denominator
      )
    : 0;
}

function averagePerGame(
  value,
  games
) {
  return games
    ? round(
        value / games
      )
    : 0;
}

function round(value) {
  return (
    Math.round(
      (
        Number(value) || 0
      ) *
        10000
    ) / 10000
  );
}