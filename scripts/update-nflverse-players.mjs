import { gunzipSync } from "node:zlib";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { weeklyDepthCutoffs } from "../api-lib/depthCharts.js";
import {
  instant,
  PLAYER_METRICS_SCHEMA,
  completedPlayerGames,
  playerTeam,
  validatePlayerMetrics,
} from "../api-lib/playerMetrics.js";
import { fetchSchedule as fetchPlayerSchedule } from "./balldontlie-schedule.mjs";

const season = Number(
  process.argv[2] ||
    new Date().getUTCFullYear()
);

const outputPath = path.resolve(
  "data/nflverse-player-metrics.js"
);
const teamArtifactPath = path.resolve(
  "api/nfl/nflverse-team-metrics.js"
);
const artifactPrefix = "const NFLVERSE_PLAYER_METRICS = ";
const artifactSuffix = ";\n\nexport default NFLVERSE_PLAYER_METRICS;\n";
const canonicalTeams = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH",
];

const aliases = {
  WAS: "WSH",
  LA: "LAR",
  JAC: "JAX",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

export async function main() {
  if (!process.env.BALLDONTLIE_API_KEY) {
    throw new Error("BALLDONTLIE_API_KEY required for player game completion/cutoff provenance");
  }
  console.log(`Downloading nflverse ${season} play-by-play for player metrics...`);
  const result = await regeneratePlayerMetrics({ season, outputPath });
  console.log(`Wrote ${outputPath}`);
  console.log(`Eligible plays: ${result.eligiblePlayCount} | latest player profiles: ${result.playerCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export async function regeneratePlayerMetrics({
  season,
  outputPath: destination = outputPath,
  fetchImpl = globalThis.fetch,
  scheduleFetcher = fetchPlayerSchedule,
  now = () => new Date(),
  io = { readFile, writeFile, rename, unlink },
  generateWeek = buildWeeklyPlayerMetrics,
}) {
  const resolvedOutput = path.resolve(destination);
  if (resolvedOutput === teamArtifactPath) {
    throw new Error("Player updater cannot write the team artifact");
  }

  const existing = parsePlayerArtifact(await io.readFile(resolvedOutput, "utf8"));
  validatePlayerArtifact(existing, { season });

  const requestedSourceUrl = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
  const response = await fetchImpl(requestedSourceUrl);
  if (!response.ok) throw new Error(`nflverse returned HTTP ${response.status}`);
  const compressedBytes = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(compressedBytes).toString("utf8");
  const rows = parseCsv(text);
  for (const field of ["season", "game_id", "play_id", "week", "posteam", "defteam", "play_type"]) {
    if (!rows.length || !(field in rows[0])) throw new Error(`Player source missing ${field}`);
  }

  const plays = rows.map(parsePlay).filter(isEligible);
  const schedule = await scheduleFetcher(season);
  const sourceAsOf = now().toISOString();
  const scheduleCutoffs = weeklyDepthCutoffs(schedule, season);
  const latestCompletedWeek = Math.max(0, ...plays.map((play) => play.week));
  const predictionWeek = latestCompletedWeek + 1;
  const cutoff = scheduleCutoffs[predictionWeek];
  if (!Number.isInteger(predictionWeek) || predictionWeek < 2 || predictionWeek > 18 || !cutoff) {
    throw new Error(`Unable to determine a valid target prediction week from nflverse data (${predictionWeek})`);
  }

  const targetMetrics = generateWeek(plays, schedule, { season, predictionWeek, cutoff });
  validateTargetWeek(targetMetrics, { season, predictionWeek, cutoff, sourceAsOf });

  const cutoffs = { ...existing.cutoffs, [predictionWeek]: cutoff };
  const playerMetricsByWeek = Object.fromEntries(
    Object.entries({ ...existing.playerMetricsByWeek, [predictionWeek]: targetMetrics })
      .sort(([first], [second]) => Number(first) - Number(second)),
  );
  const payload = {
    ...existing,
    sourceAsOf,
    cutoffs,
    season,
    generatedAt: sourceAsOf,
    source: "nflverse/nflfastR play-by-play",
    sourceUrl: requestedSourceUrl,
    garbageTimeFilter: "Win probability between 5% and 95%",
    latestCompletedWeek,
    requiredFields: ["season", "game_id", "play_id", "week", "posteam", "defteam", "play_type"],
    playerMetricsByWeek,
  };
  validatePlayerArtifact(payload, { season });

  const serialized = serializePlayerArtifact(payload);
  const validatedSerialization = parsePlayerArtifact(serialized);
  validatePlayerArtifact(validatedSerialization, { season });
  await writePlayerArtifactAtomically(resolvedOutput, serialized, { season, io, targetWeek: predictionWeek });

  const playerCount = Object.values(targetMetrics).reduce(
    (total, teamEntry) => total + Object.keys(teamEntry.players || {}).length,
    0,
  );
  return { payload, predictionWeek, cutoff, eligiblePlayCount: plays.length, playerCount };
}

export async function writePlayerArtifactAtomically(destination, serialized, { season, io, targetWeek }) {
  const directory = path.dirname(destination);
  const temporaryPath = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await io.writeFile(temporaryPath, serialized, { flag: "wx" });
    const temporaryArtifact = parsePlayerArtifact(await io.readFile(temporaryPath, "utf8"));
    validatePlayerArtifact(temporaryArtifact, { season, targetWeek });
    await io.rename(temporaryPath, destination);
  } catch (error) {
    try {
      await io.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "Player artifact update failed and temporary-file cleanup also failed");
      }
    }
    throw error;
  }
}

export function parsePlayerArtifact(source) {
  if (!source.startsWith(artifactPrefix) || !source.endsWith(artifactSuffix)) {
    throw new Error("Player artifact has an invalid JavaScript wrapper");
  }
  return JSON.parse(source.slice(artifactPrefix.length, -artifactSuffix.length));
}

export function serializePlayerArtifact(artifact) {
  return `${artifactPrefix}${JSON.stringify(artifact, null, 2)}${artifactSuffix}`;
}

export function validatePlayerArtifact(artifact, { season, targetWeek } = {}) {
  if (artifact?.schemaVersion !== PLAYER_METRICS_SCHEMA) throw new Error("Player artifact schema mismatch");
  if (artifact.season !== season) throw new Error("Player artifact season mismatch");
  if (instant(artifact.sourceAsOf) === null || instant(artifact.generatedAt) === null ||
      Date.parse(artifact.generatedAt) < Date.parse(artifact.sourceAsOf)) {
    throw new Error("Player artifact generation provenance invalid");
  }
  if (!artifact.cutoffs || typeof artifact.cutoffs !== "object" ||
      !artifact.playerMetricsByWeek || typeof artifact.playerMetricsByWeek !== "object") {
    throw new Error("Player artifact weekly data missing");
  }

  for (const [weekText, teams] of Object.entries(artifact.playerMetricsByWeek)) {
    const week = Number(weekText);
    const cutoff = artifact.cutoffs[weekText];
    if (!/^(?:[1-9]|1[0-8])$/.test(weekText) || instant(cutoff) === null ||
        !teams || typeof teams !== "object" || Array.isArray(teams)) {
      throw new Error(`Invalid player artifact week ${weekText}`);
    }
    for (const [team, metrics] of Object.entries(teams)) {
      if (!canonicalTeams.includes(team) || playerTeam(team) !== team ||
          metrics?.team !== team || metrics.predictionWeek !== week ||
          instant(metrics.cutoff) !== instant(cutoff)) {
        throw new Error(`Invalid player artifact team identity for week ${week} ${team}`);
      }
      const validationError = validatePlayerMetrics({
        available: true,
        schemaVersion: artifact.schemaVersion,
        season: artifact.season,
        requestedWeek: week,
        metricsWeek: week,
        cutoff,
        sourceAsOf: artifact.sourceAsOf,
        generatedAt: artifact.generatedAt,
        away: metrics,
        home: null,
      }, { season, week, cutoff });
      if (validationError) throw new Error(`Invalid player artifact week ${week} ${team}: ${validationError}`);
      const playerIds = new Set();
      for (const player of Object.values(metrics.players || {})) {
        if (typeof player.playerId !== "string" || !player.playerId.trim() ||
            playerIds.has(player.playerId) || player.team !== team) {
          throw new Error(`Invalid or duplicate player identity in week ${week} ${team}`);
        }
        playerIds.add(player.playerId);
      }
    }
  }
  if (targetWeek !== undefined) {
    const targetTeams = artifact.playerMetricsByWeek[targetWeek];
    const targetCodes = Object.keys(targetTeams || {}).sort();
    const expectedCodes = [...canonicalTeams].sort();
    if (targetCodes.length !== expectedCodes.length ||
        targetCodes.some((team, index) => team !== expectedCodes[index])) {
      throw new Error(`Player artifact target week ${targetWeek} must contain all 32 canonical teams`);
    }
  }
  return true;
}

function validateTargetWeek(teams, { season, predictionWeek, cutoff, sourceAsOf }) {
  if (!teams || typeof teams !== "object" || Array.isArray(teams)) {
    throw new Error(`Generated player week ${predictionWeek} is invalid`);
  }
  const teamCodes = Object.keys(teams).sort();
  if (teamCodes.length !== canonicalTeams.length ||
      teamCodes.some((team, index) => team !== [...canonicalTeams].sort()[index])) {
    throw new Error(`Generated player week ${predictionWeek} must contain all 32 canonical teams`);
  }
  validatePlayerArtifact({
    schemaVersion: PLAYER_METRICS_SCHEMA,
    season,
    sourceAsOf,
    generatedAt: sourceAsOf,
    cutoffs: { [predictionWeek]: cutoff },
    playerMetricsByWeek: { [predictionWeek]: teams },
  }, { season, targetWeek: predictionWeek });
}

export function buildWeeklyPlayerMetrics(plays, schedule, { season, predictionWeek, cutoff }) {
  const completed = completedPlayerGames(schedule, season, predictionWeek, cutoff);
  const byKey = new Map(completed.map((game) => [game.key, game]));
  const seen = new Map();
  const eligible = plays.filter((play) => {
    if (play.season !== season || !isEligible(play) ||
        !byKey.has(`${season}:${play.week}:${[playerTeam(play.team), playerTeam(play.opponent)].sort().join(":")}`)) return false;
    if (!play.gameId || !play.playId) throw new Error("Missing player play identity");
    const key = `${play.gameId}:${play.playId}`;
    const previous = seen.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(play)) throw new Error(`Conflicting player play ${key}`);
    seen.set(key, play);
    return !previous;
  });
  const teams = [...new Set(eligible.map((play) => play.team))];
  return Object.fromEntries(teams.map((code) => {
    const metrics = buildTeamPlayerMetrics(eligible, code);
    const logs = new Map(eligible.filter((play) => play.team === code).map((play) => {
      const game = byKey.get(`${season}:${play.week}:${[playerTeam(play.team), playerTeam(play.opponent)].sort().join(":")}`);
      return [play.gameId, { ...game, gameId: play.gameId }];
    }));
    const expectedCompletedGames = completed.filter((game) => [game.away, game.home].includes(code)).length;
    // Partial PBP coverage is not an exact-week profile.
    if (logs.size !== expectedCompletedGames) throw new Error(`Incomplete player game coverage for ${code}, week ${predictionWeek}`);
    return [code, { ...metrics, predictionWeek, cutoff, expectedCompletedGames, gameProvenance: [...logs.values()] }];
  }));
}

export function buildTeamPlayerMetrics(
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
      player.qbScrambles += play.qbScramble;
      recordUsage(player, play, "qbScrambles", play.qbScramble);
      recordUsage(player, play, "redZoneCarries", play.redZone ? 1 : 0);
      recordUsage(player, play, "goalLineCarries", play.goalLine ? 1 : 0);

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
      recordUsage(player, play, "redZoneTargets", play.redZone ? 1 : 0);
      recordUsage(player, play, "endZoneTargets", play.endZoneTarget ? 1 : 0);

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
          totals,
          [...new Map(offense.map((play) => [play.gameId, { gameId: play.gameId, week: play.week }])).values()]
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
        qbScrambles: 0,

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
    interceptions: 0,
    sacksTaken: 0,
    qbScrambles: 0,
    redZoneCarries: 0,
    goalLineCarries: 0,
    redZoneTargets: 0,
    endZoneTargets: 0,

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
  recordUsage(player, play, "interceptions", play.interception);
  recordUsage(player, play, "sacksTaken", play.sack);
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
  totals,
  teamGames
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

  const recentRows = [...teamGames].sort((a, b) => a.week - b.week).slice(-2)
    .map((game) => player.gameUsage.get(game.gameId) || createUsageRow(game));

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
      sackRate: rate(player.sacksTaken, player.dropbacks),

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
      scrambles: player.qbScrambles,
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

export function parsePlay(row) {
  const sack = number(row.sack) || 0;
  const passAttempt = sack || number(row.qb_scramble) === 1 ? 0 :
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
    season: number(row.season),
    playId: row.play_id,
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