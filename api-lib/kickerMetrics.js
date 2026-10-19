import { instant, playerTeam, completedPlayerGames } from "./playerMetrics.js";

export const KICKER_METRICS_SCHEMA = 1;
export const KICKER_PROVENANCE_VERSION = 1;
export const KICKER_BUCKETS = Object.freeze(["under30", "from30to39", "from40to49", "from50plus"]);

const TEAM_NAMES = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
  "GB", "HOU", "IND", "JAX", "KC", "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO",
  "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WSH",
]);
const FG_RESULT = Object.freeze({ made: "made", missed: "missed", blocked: "blocked" });
const XP_RESULT = Object.freeze({ made: "good", missed: "failed", blocked: "blocked" });

const number = (value) => {
  if (value === "" || value === null || value === undefined || value === "NA") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const identity = (value) => String(value || "").trim();
const alias = (value) => playerTeam(value);

function emptyRecord() {
  return { attempts: 0, makes: 0, misses: 0, blocks: 0, accuracyAttempts: 0 };
}

function emptyProfile(team, playerId, fullName) {
  return {
    playerId,
    gsisId: playerId,
    fullName,
    team,
    teamStint: team,
    fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, emptyRecord()])),
    overallFieldGoals: emptyRecord(),
    extraPoints: emptyRecord(),
    games: new Map(),
  };
}

function emptyLeague() {
  return {
    fieldGoals: Object.fromEntries(KICKER_BUCKETS.map((bucket) => [bucket, emptyRecord()])),
    extraPoints: emptyRecord(),
    totalFieldGoalAttempts: 0,
  };
}

function recordAttempt(record, result) {
  record.attempts += 1;
  if (result === "made") {
    record.makes += 1;
    record.accuracyAttempts += 1;
  } else if (result === "missed") {
    record.misses += 1;
    record.accuracyAttempts += 1;
  } else if (result === "blocked") {
    record.blocks += 1;
  }
}

function fieldGoalBucket(distance) {
  if (!Number.isFinite(distance) || distance < 1 || distance > 75) return null;
  if (distance < 30) return "under30";
  if (distance < 40) return "from30to39";
  if (distance < 50) return "from40to49";
  return "from50plus";
}

function gameIdentity(gameId, season, week) {
  const parts = String(gameId || "").split("_");
  if (parts.length < 4 || number(parts[0]) !== season || number(parts[1]) !== week) return null;
  const away = alias(parts[2]);
  const home = alias(parts[3]);
  if (!TEAM_NAMES.has(away) || !TEAM_NAMES.has(home) || away === home) return null;
  return `${season}:${week}:${[away, home].sort().join(":")}`;
}

function classifyPlay(row) {
  if (row.play_type === "field_goal") {
    const result = String(row.field_goal_result || "").trim().toLowerCase();
    const mapped = result === FG_RESULT.made ? "made"
      : result === FG_RESULT.missed ? "missed"
        : result === FG_RESULT.blocked ? "blocked" : null;
    const bucket = fieldGoalBucket(number(row.kick_distance));
    return mapped && bucket ? { type: "fieldGoal", result: mapped, bucket } : null;
  }
  if (row.play_type === "extra_point") {
    const result = String(row.extra_point_result || "").trim().toLowerCase();
    const mapped = result === XP_RESULT.made ? "made"
      : result === XP_RESULT.missed ? "missed"
        : result === XP_RESULT.blocked ? "blocked" : null;
    return mapped ? { type: "extraPoint", result: mapped } : null;
  }
  return null;
}

function samePlay(first, second) {
  return ["season", "season_type", "week", "game_id", "play_id", "posteam",
    "play_type", "kicker_player_id", "kicker_player_name", "kick_distance",
    "field_goal_result", "extra_point_result"].every((field) => first[field] === second[field]);
}

export function buildWeeklyKickerProfiles(rows, schedule, {
  season, predictionWeek, cutoff, sourceAsOf, generatedAt,
} = {}) {
  const cutoffTime = instant(cutoff);
  const sourceTime = instant(sourceAsOf);
  const generatedTime = instant(generatedAt);
  if (!Number.isInteger(season) || !Number.isInteger(predictionWeek) ||
      cutoffTime === null || sourceTime === null || generatedTime === null || generatedTime < sourceTime) {
    throw new Error("Kicker profile provenance is incomplete");
  }
  const completed = completedPlayerGames(schedule, season, predictionWeek, cutoff)
    .filter((game) => instant(game.completedAsOf) <= sourceTime &&
      TEAM_NAMES.has(game.away) && TEAM_NAMES.has(game.home));
  const completedByMatchup = new Map(completed.map((game) => [game.key, game]));
  const plays = new Map();
  const profiles = new Map();
  const league = emptyLeague();
  const eligibleGameRows = new Map();
  const excluded = {
    incompleteOrUnresolvedGame: 0,
    invalidGameIdentity: 0,
    duplicatePlays: 0,
    invalidPlayId: 0,
    missingKickerIdentity: 0,
    unsupportedResultOrDistance: 0,
    invalidTeam: 0,
  };

  for (const row of rows) {
    const week = number(row.week);
    if (number(row.season) !== season || row.season_type !== "REG" ||
        week === null || week >= predictionWeek) continue;
    const play = classifyPlay(row);
    if (!play) {
      if (["field_goal", "extra_point"].includes(row.play_type)) excluded.unsupportedResultOrDistance += 1;
      continue;
    }
    const team = alias(row.posteam);
    if (!TEAM_NAMES.has(team)) {
      excluded.invalidTeam += 1;
      continue;
    }
    const scheduledGameKey = gameIdentity(row.game_id, season, week);
    if (!scheduledGameKey) {
      excluded.invalidGameIdentity += 1;
      continue;
    }
    const game = completedByMatchup.get(scheduledGameKey);
    if (!game || instant(game.completedAsOf) > cutoffTime) {
      excluded.incompleteOrUnresolvedGame += 1;
      continue;
    }
    if (![game.away, game.home].includes(team)) {
      excluded.invalidTeam += 1;
      continue;
    }
    const playId = identity(row.play_id);
    if (!playId) {
      excluded.invalidPlayId += 1;
      continue;
    }
    const identityKey = `${row.game_id}:${playId}`;
    const previous = plays.get(identityKey);
    if (previous) {
      if (!samePlay(previous, row)) throw new Error(`Conflicting kicker play ${identityKey}`);
      excluded.duplicatePlays += 1;
      continue;
    }
    plays.set(identityKey, row);
    eligibleGameRows.set(game.key, game);

    const playerId = identity(row.kicker_player_id || row.kicker_player_gsis_id);
    const fullName = identity(row.kicker_player_name);
    if (!playerId || !fullName) {
      excluded.missingKickerIdentity += 1;
      continue;
    }
    const profileKey = `${team}:${playerId}`;
    const profile = profiles.get(profileKey) || emptyProfile(team, playerId, fullName);
    if (profile.fullName !== fullName) throw new Error(`Conflicting kicker name for ${profileKey}`);
    profile.games.set(game.key, { ...game, gameId: row.game_id });
    if (play.type === "fieldGoal") {
      recordAttempt(profile.fieldGoals[play.bucket], play.result);
      recordAttempt(profile.overallFieldGoals, play.result);
      recordAttempt(league.fieldGoals[play.bucket], play.result);
      league.totalFieldGoalAttempts += 1;
    } else {
      recordAttempt(profile.extraPoints, play.result);
      recordAttempt(league.extraPoints, play.result);
    }
    profiles.set(profileKey, profile);
  }

  const leaguePriors = buildLeaguePriors(league);
  const teamProfiles = {};
  for (const profile of profiles.values()) {
    const gameProvenance = [...profile.games.values()]
      .sort((a, b) => instant(a.kickoff) - instant(b.kickoff));
    const latest = gameProvenance.at(-1) || null;
    const publicProfile = {
      schemaVersion: KICKER_METRICS_SCHEMA,
      provenanceVersion: KICKER_PROVENANCE_VERSION,
      playerId: profile.playerId,
      gsisId: profile.gsisId,
      fullName: profile.fullName,
      team: profile.team,
      teamStint: profile.teamStint,
      fieldGoals: profile.fieldGoals,
      overallFieldGoals: profile.overallFieldGoals,
      extraPoints: profile.extraPoints,
      gamesRepresented: gameProvenance.length,
      gameProvenance,
      latestEligibleGame: latest ? {
        gameId: latest.gameId,
        week: latest.week,
        kickoff: latest.kickoff,
        completedAsOf: latest.completedAsOf,
      } : null,
      predictionSeason: season,
      predictionWeek,
      cutoff,
      completedAsOf: latest?.completedAsOf || null,
      sourceAsOf,
      generatedAt,
      source: "nflverse play-by-play",
    };
    const list = teamProfiles[profile.team] ||= [];
    list.push(publicProfile);
  }
  for (const list of Object.values(teamProfiles)) {
    list.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.playerId.localeCompare(b.playerId));
  }

  return {
    schemaVersion: KICKER_METRICS_SCHEMA,
    provenanceVersion: KICKER_PROVENANCE_VERSION,
    season,
    predictionWeek,
    cutoff,
    sourceAsOf,
    generatedAt,
    source: "nflverse play-by-play",
    leaguePriors,
    profilesByTeam: teamProfiles,
    eligibleGames: eligibleGameRows.size,
    eligiblePlays: plays.size,
    excluded,
  };
}

function buildLeaguePriors(league) {
  const buckets = Object.fromEntries(KICKER_BUCKETS.map((bucket) => {
    const value = league.fieldGoals[bucket];
    const rate = value.accuracyAttempts ? value.makes / value.accuracyAttempts : null;
    return [bucket, {
      rate: finiteRate(rate),
      accuracy: finiteRate(rate),
      makes: value.makes,
      misses: value.misses,
      blocks: value.blocks,
      attempts: value.attempts,
      accuracyAttempts: value.accuracyAttempts,
      attemptShare: league.totalFieldGoalAttempts
        ? value.attempts / league.totalFieldGoalAttempts : 0,
    }];
  }));
  const xp = league.extraPoints;
  const xpRate = xp.accuracyAttempts ? xp.makes / xp.accuracyAttempts : null;
  return {
    fieldGoals: buckets,
    extraPoints: {
      rate: finiteRate(xpRate),
      accuracy: finiteRate(xpRate),
      makes: xp.makes,
      misses: xp.misses,
      blocks: xp.blocks,
      attempts: xp.attempts,
      accuracyAttempts: xp.accuracyAttempts,
    },
    blockedAttemptTreatment: "Blocked attempts are included in total attempts and reported separately, but excluded from accuracy denominators as non-kicker misses.",
    source: league.totalFieldGoalAttempts || xp.attempts
      ? "same-week-cutoff-eligible-nflverse-sample"
      : "no-eligible-attempts",
  };
}

function finiteRate(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}
