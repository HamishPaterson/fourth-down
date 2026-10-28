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

const outputPath = path.resolve(
  "data/nflverse-player-metrics.js"
);
const teamArtifactPath = path.resolve(
  "api/nfl/nflverse-team-metrics.js"
);
const artifactPrefix = "const NFLVERSE_PLAYER_METRICS = ";
const artifactSuffix = ";\n\nexport default NFLVERSE_PLAYER_METRICS;\n";
const teamArtifactPrefix = "const NFLVERSE_TEAM_METRICS = ";
const teamArtifactSuffix = ";\n\nexport default NFLVERSE_TEAM_METRICS;\n";
export const PLAYER_SOURCE_REQUIRED_FIELDS = [
  "season", "season_type", "week", "game_id", "play_id", "posteam", "defteam",
  "play_type", "wp", "sack", "pass_attempt", "qb_scramble", "rush_attempt",
  "rush", "complete_pass", "interception", "receiver_player_name", "receiver",
  "yardline_100", "air_yards", "passer_player_id", "passer_player_name", "passer",
  "rusher_player_id", "rusher_player_name", "rusher", "receiver_player_id",
  "pass_touchdown", "rush_touchdown", "fumble", "fumble_lost", "passing_yards",
  "rushing_yards", "receiving_yards", "yards_after_catch", "pass", "two_point_attempt",
];
const sourceNumericFields = [
  "season", "week", "play_id", "wp", "sack", "pass_attempt", "pass", "qb_scramble",
  "rush_attempt", "rush", "complete_pass", "interception", "yardline_100", "air_yards",
  "pass_touchdown", "rush_touchdown", "fumble", "fumble_lost", "passing_yards",
  "rushing_yards", "receiving_yards", "yards_after_catch", "two_point_attempt",
];
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

export async function main(args = process.argv.slice(2)) {
  const [seasonText, weekText, ...extra] = args;
  if (!/^\d{4}$/.test(seasonText || "") || !/^\d{1,2}$/.test(weekText || "") || extra.length) {
    throw new Error("Usage: node scripts/update-nflverse-players.mjs <season> <prediction-week>");
  }
  const season = Number(seasonText);
  const predictionWeek = Number(weekText);
  if (!Number.isInteger(predictionWeek) || predictionWeek < 2 || predictionWeek > 18) {
    throw new Error("Prediction week must be an integer from 2 through 18");
  }
  if (!process.env.BALLDONTLIE_API_KEY) {
    throw new Error("BALLDONTLIE_API_KEY required for player game completion/cutoff provenance");
  }
  console.log(`Downloading nflverse ${season} play-by-play for player metrics...`);
  const result = await regeneratePlayerMetrics({ season, predictionWeek, outputPath });
  console.log(`Wrote ${outputPath}`);
  console.log(`Eligible plays: ${result.eligiblePlayCount} | latest player profiles: ${result.playerCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export async function regeneratePlayerMetrics({
  season,
  predictionWeek,
  outputPath: destination = outputPath,
  fetchImpl = globalThis.fetch,
  scheduleFetcher = fetchPlayerSchedule,
  now = () => new Date(),
  io = { readFile, writeFile, rename, unlink },
  generateWeek = buildWeeklyPlayerMetrics,
  teamArtifact,
  teamArtifactPath: localTeamPath = teamArtifactPath,
}) {
  if (!Number.isInteger(season) || season < 2000 || season > 9999) {
    throw new Error("Season must be provided as a four-digit integer");
  }
  if (!Number.isInteger(predictionWeek) || predictionWeek < 2 || predictionWeek > 18) {
    throw new Error("Prediction week must be explicitly provided as an integer from 2 through 18");
  }
  const resolvedOutput = path.resolve(destination);
  if (resolvedOutput === teamArtifactPath) {
    throw new Error("Player updater cannot write the team artifact");
  }

  const localTeamArtifact = teamArtifact || parseTeamArtifact(await io.readFile(localTeamPath, "utf8"));
  const targetContext = validateTeamArtifactTarget(localTeamArtifact, { season, predictionWeek });
  const preflightAsOf = now().toISOString();
  validateObservationTime(targetContext, preflightAsOf);
  const identityContext = createPlayerIdentityContext(targetContext.teams);
  const existing = parsePlayerArtifact(await io.readFile(resolvedOutput, "utf8"));
  validatePlayerArtifact(existing, { season });

  const requestedSourceUrl = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
  const response = await fetchImpl(requestedSourceUrl);
  if (!response.ok) throw new Error(`nflverse returned HTTP ${response.status}`);
  const compressedBytes = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(compressedBytes).toString("utf8");
  const rows = parseCsv(text);
  validatePlayerSourceRows(rows);
  const plays = rows.map(parsePlay).filter(isEligible);
  const schedule = await scheduleFetcher(season);
  const sourceAsOf = now().toISOString();
  validateObservationTime(targetContext, sourceAsOf);
  if (Date.parse(sourceAsOf) < Date.parse(preflightAsOf)) {
    throw new Error("Player source observation time moved backwards");
  }
  const scheduleCutoffs = weeklyDepthCutoffs(schedule, season);
  const cutoff = scheduleCutoffs[predictionWeek];
  if (!cutoff || instant(cutoff) !== instant(targetContext.cutoff)) {
    throw new Error(`Schedule cutoff does not match local team artifact for Week ${predictionWeek}`);
  }

  const observedSchedule = schedule.filter((game) =>
    instant(game.completed_at || game.updated_at) !== null &&
    Date.parse(game.completed_at || game.updated_at) <= Date.parse(sourceAsOf));
  const completed = completedPlayerGames(observedSchedule, season, predictionWeek, cutoff);
  const completedKeys = new Set(completed.map((game) => game.key));
  const eligiblePlays = plays.filter((play) =>
    play.season === season && Number.isInteger(play.week) && play.week < predictionWeek &&
    completedKeys.has(`${season}:${play.week}:${[play.team, play.opponent].sort().join(":")}`));
  const identifiedPlays = applyCanonicalPlayerIdentity(eligiblePlays, identityContext);
  const targetMetrics = generateWeek(identifiedPlays, observedSchedule, {
    season, predictionWeek, cutoff, identityContext,
  });
  validateTargetWeek(targetMetrics, {
    season, predictionWeek, cutoff, sourceAsOf, referenceWeek: targetContext.referenceWeek,
    sourceColumns: PLAYER_SOURCE_REQUIRED_FIELDS,
  });

  const cutoffs = { ...existing.cutoffs, [predictionWeek]: cutoff };
  const playerMetricsByWeek = Object.fromEntries(
    Object.entries({ ...existing.playerMetricsByWeek, [predictionWeek]: targetMetrics })
      .sort(([first], [second]) => Number(first) - Number(second)),
  );
  const targetMetadataByWeek = {
    ...(existing.targetMetadataByWeek || {}),
    [predictionWeek]: {
      season,
      predictionWeek,
      cutoff,
      referenceWeek: targetContext.referenceWeek,
      sourceAsOf,
      sourceColumns: [...PLAYER_SOURCE_REQUIRED_FIELDS],
    },
  };
  const payload = {
    ...existing,
    sourceAsOf,
    cutoffs,
    season,
    generatedAt: sourceAsOf,
    source: "nflverse/nflfastR play-by-play",
    sourceUrl: requestedSourceUrl,
    garbageTimeFilter: "Win probability between 5% and 95%",
    latestCompletedWeek: targetContext.referenceWeek,
    requiredFields: PLAYER_SOURCE_REQUIRED_FIELDS,
    targetMetadataByWeek,
    playerMetricsByWeek,
  };
  validatePlayerArtifact(payload, { season, targetWeek: predictionWeek });

  const serialized = serializePlayerArtifact(payload);
  const validatedSerialization = parsePlayerArtifact(serialized);
  validatePlayerArtifact(validatedSerialization, { season, targetWeek: predictionWeek });
  await writePlayerArtifactAtomically(resolvedOutput, serialized, {
    season, io, targetWeek: predictionWeek, targetMetadata: targetMetadataByWeek[predictionWeek],
  });

  const playerCount = Object.values(targetMetrics).reduce(
    (total, teamEntry) => total + Object.keys(teamEntry.players || {}).length,
    0,
  );
  return { payload, predictionWeek, cutoff, eligiblePlayCount: identifiedPlays.length, playerCount };
}

export async function writePlayerArtifactAtomically(destination, serialized, {
  season, io, targetWeek, targetMetadata,
}) {
  const directory = path.dirname(destination);
  const temporaryPath = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await io.writeFile(temporaryPath, serialized, { flag: "wx" });
    const temporaryArtifact = parsePlayerArtifact(await io.readFile(temporaryPath, "utf8"));
    validatePlayerArtifact(temporaryArtifact, { season, targetWeek });
    if (JSON.stringify(temporaryArtifact.targetMetadataByWeek?.[targetWeek]) !== JSON.stringify(targetMetadata)) {
      throw new Error(`Temporary player artifact target metadata changed for Week ${targetWeek}`);
    }
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

function parseTeamArtifact(source) {
  if (!source.startsWith(teamArtifactPrefix) || !source.endsWith(teamArtifactSuffix)) {
    throw new Error("Local team artifact has an invalid JavaScript wrapper");
  }
  return JSON.parse(source.slice(teamArtifactPrefix.length, -teamArtifactSuffix.length));
}

function validateTeamArtifactTarget(artifact, { season, predictionWeek }) {
  const audit = artifact?.teamMetricsAuditsByWeek?.[predictionWeek];
  if (artifact?.season !== season || !audit || audit.available !== true ||
      audit.season !== season || audit.predictionWeek !== predictionWeek ||
      audit.referenceWeek !== predictionWeek - 1 || instant(audit.cutoff) === null ||
      instant(audit.sourceAsOf) === null || Date.parse(audit.sourceAsOf) > Date.parse(audit.cutoff)) {
    throw new Error(`Local team artifact has no valid Week ${predictionWeek} cutoff/referenceWeek evidence`);
  }
  const teams = artifact.metricsByWeek?.[predictionWeek];
  if (!teams || typeof teams !== "object" || Array.isArray(teams)) {
    throw new Error(`Local team artifact is missing target Week ${predictionWeek}`);
  }
  const actualTeams = Object.keys(teams).sort();
  const expectedTeams = [...canonicalTeams].sort();
  if (actualTeams.length !== expectedTeams.length ||
      actualTeams.some((team, index) => team !== expectedTeams[index])) {
    throw new Error(`Local team artifact has incomplete target Week ${predictionWeek}`);
  }
  for (const code of canonicalTeams) {
    const teamMetrics = teams[code];
    const lineup = teamMetrics?.expectedLineup;
    if (teamMetrics?.team !== code || teamMetrics.predictionWeek !== predictionWeek ||
        instant(teamMetrics.cutoff) !== instant(audit.cutoff) ||
        lineup?.available !== true || lineup.schemaVersion !== 2 || lineup.schemaValidated !== true ||
        lineup.season !== season ||
        lineup.predictionWeek !== predictionWeek || instant(lineup.cutoff) !== instant(audit.cutoff) ||
        instant(lineup.snapshotAt) === null || Date.parse(lineup.snapshotAt) > Date.parse(audit.cutoff) ||
        !Array.isArray(lineup.players) || !Array.isArray(lineup.roster) || !lineup.roster.length) {
      throw new Error(`Local team artifact has invalid target lineup/cutoff for ${code} Week ${predictionWeek}`);
    }
  }
  return { cutoff: audit.cutoff, referenceWeek: audit.referenceWeek, sourceAsOf: audit.sourceAsOf, teams };
}

export function validatePlayerSourceRows(rows) {
  if (!rows.length) throw new Error("Player source contains no data rows");
  for (const field of PLAYER_SOURCE_REQUIRED_FIELDS) {
    if (!(field in rows[0])) throw new Error(`Player source missing required column ${field}`);
  }
  for (const [index, row] of rows.entries()) {
    for (const field of PLAYER_SOURCE_REQUIRED_FIELDS) {
      if (!(field in row)) throw new Error(`Malformed player source row ${index + 2}: missing ${field}`);
    }
    for (const field of ["season", "week", "play_id"]) {
      if (row[field] === "" || number(row[field]) === null) {
        throw new Error(`Malformed player source row ${index + 2}: invalid ${field}`);
      }
    }
    for (const field of sourceNumericFields) {
      if (!isMissingNumber(row[field]) && number(row[field]) === null) {
        throw new Error(`Malformed player source row ${index + 2}: invalid numeric ${field}`);
      }
    }
    const play = parsePlay(row);
    if (!isEligible(play)) continue;
    const scramble = number(row.qb_scramble) === 1;
    const passing = row.play_type === "pass" || number(row.pass) === 1 ||
      number(row.pass_attempt) === 1 || number(row.sack) === 1 || number(row.complete_pass) === 1;
    const rushing = row.play_type === "run" || number(row.rush) === 1 ||
      number(row.rush_attempt) === 1 || scramble;
    const relevant = [];
    if (passing && !scramble) relevant.push("sack");
    if (passing && !play.sack && !scramble) relevant.push("pass_attempt");
    if (play.passAttempt) relevant.push("complete_pass", "interception", "pass_touchdown");
    if (rushing) relevant.push("rush_attempt");
    if (passing || rushing) relevant.push("fumble", "fumble_lost", "qb_scramble");
    if (play.completePass) relevant.push("passing_yards");
    if (play.rushAttempt) relevant.push("rushing_yards", "rush_touchdown", "yardline_100");
    if (play.target) relevant.push("yardline_100", "air_yards", "pass_touchdown");
    if (play.target && play.completePass) relevant.push("receiving_yards", "yards_after_catch");
    for (const field of relevant) {
      if (number(row[field]) === null) {
        throw new Error(`Malformed player source row ${index + 2}: missing relevant numeric ${field}`);
      }
    }
  }
}

function validateObservationTime(context, sourceAsOf) {
  if (instant(sourceAsOf) === null || Date.parse(sourceAsOf) > Date.parse(context.cutoff)) {
    throw new Error("Player source timestamp is invalid or later than the target cutoff");
  }
  if (Date.parse(context.sourceAsOf) > Date.parse(sourceAsOf)) {
    throw new Error("Local team artifact evidence is later than sourceAsOf");
  }
  for (const [team, metrics] of Object.entries(context.teams)) {
    if (Date.parse(metrics.expectedLineup.snapshotAt) > Date.parse(sourceAsOf)) {
      throw new Error(`Local team lineup snapshot for ${team} is later than sourceAsOf`);
    }
  }
}

export function createPlayerIdentityContext(teams) {
  const byTeamId = new Map();
  const byTeamName = new Map();
  const idTeams = new Map();
  const unavailableRosterRecords = [];
  for (const [teamCode, metrics] of Object.entries(teams)) {
    const lineup = metrics.expectedLineup;
    if (!Array.isArray(lineup.roster) || !lineup.roster.length) {
      throw new Error(`Missing authoritative roster for ${teamCode}`);
    }
    const selectedIds = new Set(lineup.players.map((player) => clean(player.gsisId)).filter(Boolean));
    const rosterIds = new Set();
    if (selectedIds.size !== lineup.players.filter((player) => clean(player.gsisId)).length) {
      throw new Error(`Contradictory authoritative duplicate selected GSIS identity for ${teamCode}`);
    }
    const candidates = [...lineup.roster];
    for (const selected of lineup.players) {
      const id = clean(selected.gsisId);
      if (!id || lineup.roster.some((player) => clean(player.gsisId) === id)) continue;
      if (!/^00-\d{7}$/.test(id) || !isCanonicalFullName(selected.name) ||
          lineup.available !== true || lineup.schemaVersion !== 2 || lineup.schemaValidated !== true ||
          !Number.isInteger(lineup.season) || !Number.isInteger(lineup.predictionWeek) ||
          instant(lineup.cutoff) === null || instant(lineup.snapshotAt) === null ||
          Date.parse(lineup.snapshotAt) > Date.parse(lineup.cutoff) ||
          (lineup.team && team(lineup.team) !== teamCode) ||
          lineup.roster.some((player) => canonicalNameKey(player.name) === canonicalNameKey(selected.name))) {
        throw new Error(`Contradictory authoritative selected-lineup supplement for ${teamCode} ${id}`);
      }
      candidates.push(selected);
    }
    for (const player of candidates) {
      const gsisId = clean(player.gsisId);
      const name = clean(player.name);
      if (player.team && team(player.team) !== teamCode) {
        throw new Error(`Contradictory authoritative roster team for ${teamCode} ${gsisId}`);
      }
      if (gsisId && /^00-\d{7}$/.test(gsisId)) {
        if (rosterIds.has(gsisId)) {
          throw new Error(`Contradictory authoritative duplicate GSIS mapping for ${teamCode} ${gsisId}`);
        }
        rosterIds.add(gsisId);
        if (idTeams.has(gsisId) && !idTeams.get(gsisId).has(teamCode)) {
          throw new Error(`Contradictory authoritative cross-team GSIS mapping for ${gsisId}`);
        }
        idTeams.set(gsisId, new Set([teamCode]));
      }
      if (!gsisId || !/^00-\d{7}$/.test(gsisId) || !isCanonicalFullName(name)) {
        unavailableRosterRecords.push({ team: teamCode, gsisId, name,
          reason: !gsisId ? "MISSING_GSIS" : !/^00-\d{7}$/.test(gsisId) ? "INVALID_GSIS" : "NON_CANONICAL_NAME" });
        continue;
      }
      const record = {
        gsisId,
        playerName: name,
        position: clean(player.position),
        team: teamCode,
        positionSource: selectedIds.has(gsisId) ? "expectedLineup" : "expectedRoster",
      };
      byTeamId.set(`${teamCode}:${gsisId}`, record);
      const nameKey = `${teamCode}:${canonicalNameKey(name)}`;
      const candidates = byTeamName.get(nameKey) || [];
      candidates.push(record);
      byTeamName.set(nameKey, candidates);
    }
    for (const selected of lineup.players) {
      const id = clean(selected.gsisId);
      if (!id) continue;
      const identity = byTeamId.get(`${teamCode}:${id}`);
      if (!identity || identity.playerName !== clean(selected.name) ||
          identity.position !== clean(selected.position)) {
        throw new Error(`Contradictory authoritative selected-lineup identity for ${teamCode} ${id}`);
      }
    }
  }
  if (unavailableRosterRecords.length) {
    console.warn(`Player roster identity filtering: ${unavailableRosterRecords.length} records excluded without a valid GSIS/full canonical name`);
  }
  return { byTeamId, byTeamName, idTeams, unavailableRosterRecords,
    unresolved: 0, mismatchedTeam: 0, ambiguous: 0, idConflict: 0 };
}

export function applyCanonicalPlayerIdentity(plays, context) {
  let unresolved = 0;
  let mismatchedTeam = 0;
  let ambiguous = 0;
  let idConflict = 0;
  const activeRole = (play, role) => {
    if (role === "passer") return Boolean(play.passAttempt || play.sack);
    if (role === "rusher") return Boolean(play.rushAttempt);
    return Boolean(play.target);
  };
  const observedTeamsById = new Map();
  for (const play of plays) {
    for (const role of ["passer", "rusher", "receiver"]) {
      const id = play[`${role}Id`];
      if (!id || !activeRole(play, role)) continue;
      const observed = observedTeamsById.get(id) || new Set();
      observed.add(play.team);
      observedTeamsById.set(id, observed);
    }
  }
  const identified = plays.map((play) => {
    const next = { ...play };
    for (const role of ["passer", "rusher", "receiver"]) {
      const idKey = `${role}Id`;
      const nameKey = `${role}Name`;
      const sourceId = play[idKey];
      const sourceName = play[nameKey];
      if (!activeRole(play, role) || (!sourceId && !sourceName)) continue;
      let identity = sourceId ? context.byTeamId.get(`${play.team}:${sourceId}`) : null;
      if (sourceId && !identity && context.idTeams.has(sourceId)) {
        if (context.idTeams.get(sourceId).size > 1 || !context.idTeams.get(sourceId).has(play.team)) {
          mismatchedTeam += 1;
          next[idKey] = null;
          next[nameKey] = null;
          next[`${role}IdentityState`] = "TEAM_MISMATCH";
          continue;
        }
      }
      if (sourceId && !identity && !context.idTeams.has(sourceId) &&
          (observedTeamsById.get(sourceId)?.size || 0) > 1) {
        mismatchedTeam += 1;
        next[idKey] = null;
        next[nameKey] = null;
        next[`${role}IdentityState`] = "TEAM_MISMATCH";
        continue;
      }
      let state = "UNRESOLVED";
      if (!identity && sourceName && isCanonicalFullName(sourceName)) {
        const matches = context.byTeamName.get(`${play.team}:${canonicalNameKey(sourceName)}`) || [];
        if (sourceId && matches.length) {
          state = "ID_CONFLICT";
          idConflict += 1;
        } else if (!sourceId && matches.length === 1) {
          identity = matches[0];
        } else if (!sourceId && matches.length > 1) {
          state = "AMBIGUOUS";
          ambiguous += 1;
        }
      }
      if (identity) {
        next[idKey] = identity.gsisId;
        next[nameKey] = identity.playerName;
        next[`${role}Position`] = identity.position;
        next[`${role}PositionSource`] = identity.position ? identity.positionSource : "inferred";
        next[`${role}IdentityState`] = "RESOLVED";
        continue;
      }
      next[idKey] = null;
      next[nameKey] = null;
      next[`${role}IdentityState`] = state;
      unresolved += 1;
    }
    return next;
  });
  context.unresolved = unresolved;
  context.mismatchedTeam = mismatchedTeam;
  context.ambiguous = ambiguous;
  context.idConflict = idConflict;
  if (unresolved || mismatchedTeam) {
    console.warn(`Player identity filtering: ${unresolved} unresolved role records; ${mismatchedTeam} cross-team role records excluded`);
  }
  return identified;
}

function isCanonicalFullName(value) {
  const parts = String(value || "").trim().split(/\s+/);
  const nameParts = parts.filter((part) => !/^(?:Jr\.?|Sr\.?|II|III|IV|V)$/i.test(part));
  const substantive = (part) => part.replace(/[^A-Za-z]/g, "").length >= 2;
  return nameParts.filter(substantive).length >= 2 &&
    nameParts.every((part) => /^[A-Za-z][A-Za-z.'’-]*$/.test(part) &&
      (substantive(part) || /^[A-Za-z]\.?$/.test(part)));
}

function canonicalNameKey(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z]/g, "");
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
    const metadata = artifact.targetMetadataByWeek?.[targetWeek];
    if (!metadata || metadata.season !== season || metadata.predictionWeek !== targetWeek ||
        instant(metadata.cutoff) !== instant(artifact.cutoffs[targetWeek]) ||
        metadata.referenceWeek !== targetWeek - 1 ||
        instant(metadata.sourceAsOf) === null ||
        Date.parse(metadata.sourceAsOf) > Date.parse(metadata.cutoff) ||
        instant(metadata.sourceAsOf) !== instant(artifact.sourceAsOf) ||
        !Array.isArray(metadata.sourceColumns) ||
        JSON.stringify(metadata.sourceColumns) !== JSON.stringify(PLAYER_SOURCE_REQUIRED_FIELDS) ||
        JSON.stringify(artifact.requiredFields) !== JSON.stringify(PLAYER_SOURCE_REQUIRED_FIELDS)) {
      throw new Error(`Player target metadata is invalid for Week ${targetWeek}`);
    }
    const targetTeams = artifact.playerMetricsByWeek[targetWeek];
    const targetCodes = Object.keys(targetTeams || {}).sort();
    const expectedCodes = [...canonicalTeams].sort();
    if (targetCodes.length !== expectedCodes.length ||
        targetCodes.some((team, index) => team !== expectedCodes[index])) {
      throw new Error(`Player artifact target week ${targetWeek} must contain all 32 canonical teams`);
    }
    validateStrictTargetTeams(targetTeams, {
      season, targetWeek, cutoff: metadata.cutoff, sourceAsOf: metadata.sourceAsOf,
    });
  }
  return true;
}

function validateTargetWeek(teams, {
  season, predictionWeek, cutoff, sourceAsOf, referenceWeek, sourceColumns,
}) {
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
    requiredFields: sourceColumns,
    targetMetadataByWeek: {
      [predictionWeek]: {
        season, predictionWeek, cutoff, referenceWeek, sourceAsOf, sourceColumns,
      },
    },
    playerMetricsByWeek: { [predictionWeek]: teams },
  }, { season, targetWeek: predictionWeek });
}

function validateStrictTargetTeams(teams, { season, targetWeek, cutoff, sourceAsOf }) {
  if (instant(sourceAsOf) === null || Date.parse(sourceAsOf) > Date.parse(cutoff)) {
    throw new Error(`Target Week ${targetWeek} sourceAsOf is later than the cutoff`);
  }
  const seenIds = new Set();
  for (const [team, metrics] of Object.entries(teams)) {
    if (metrics.season !== undefined && metrics.season !== season) {
      throw new Error(`Target Week ${targetWeek} ${team} season mismatch`);
    }
    const names = new Set();
    const players = Object.values(metrics.players || {});
    if (!players.length) throw new Error(`Target Week ${targetWeek} ${team} has no canonical players`);
    const categoryCoverage = {
      qb: players.some((player) => player.passing?.attempts > 0),
      rushing: players.some((player) => player.rushing?.attempts > 0),
      receiving: players.some((player) => player.receiving?.targets > 0),
    };
    for (const [category, covered] of Object.entries(categoryCoverage)) {
      const teamTotal = category === "qb"
        ? metrics.teamTotals.passAttempts + metrics.teamTotals.sacksAllowed
        : category === "rushing"
          ? metrics.teamTotals.rushingAttempts
          : metrics.teamTotals.targets;
      if (teamTotal > 0 && !covered) {
        throw new Error(`Target Week ${targetWeek} ${team} has missing ${category} player coverage`);
      }
    }
    for (const [key, player] of Object.entries(metrics.players)) {
      const stableId = player.gsisId;
      const nameKey = canonicalNameKey(player.playerName);
      if (key !== stableId || !/^00-\d{7}$/.test(stableId || "") ||
          player.playerId !== stableId || player.team !== team ||
          !isCanonicalFullName(player.playerName) || names.has(nameKey) ||
          seenIds.has(stableId)) {
        throw new Error(`Invalid or duplicate GSIS/name/team identity in target Week ${targetWeek} ${team}`);
      }
      if (!["expectedLineup", "expectedRoster", "inferred"].includes(player.positionSource) ||
          (["expectedLineup", "expectedRoster"].includes(player.positionSource) && !String(player.position || "").trim()) ||
          (player.positionSource === "inferred" && !/inferred/i.test(player.positionSource)) ||
          player.health !== "Unknown" || player.healthSource !== "Unavailable") {
        throw new Error(`Invalid target identity/health metadata in Week ${targetWeek} ${team}`);
      }
      if (!Array.isArray(player.gameLog) || !player.gameLog.length ||
          player.gameLog.some((row) => !row.gameId || !Number.isInteger(row.week) ||
            row.week < 1 || row.week >= targetWeek)) {
        throw new Error(`Malformed target player game log in Week ${targetWeek} ${team}`);
      }
      names.add(nameKey);
      seenIds.add(stableId);
    }
    if (metrics.predictionWeek !== targetWeek || metrics.team !== team ||
        instant(metrics.cutoff) !== instant(cutoff) || !Number.isFinite(metrics.games) ||
        metrics.games < 1 || metrics.expectedCompletedGames !== metrics.games ||
        !Array.isArray(metrics.gameProvenance) || !metrics.gameProvenance.length ||
        metrics.gameProvenance.some((game) =>
          !game.gameId || !Number.isInteger(game.week) || game.week < 1 ||
          game.week >= targetWeek || instant(game.completedAsOf) === null ||
          Date.parse(game.completedAsOf) > Date.parse(cutoff))) {
      throw new Error(`Malformed target team/game provenance in Week ${targetWeek} ${team}`);
    }
    if (metrics.games !== metrics.gameProvenance.length) {
      throw new Error(`Target Week ${targetWeek} ${team} game coverage mismatch`);
    }
  }
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
          play.passerPosition || "QB",
          play.passerPositionSource || "inferred"
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
          play.rusherPosition,
          play.rusherPositionSource || "inferred"
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
          play.receiverPosition,
          play.receiverPositionSource || "inferred"
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
  position,
  positionSource
) {
  if (!id || !name) return null;
  const key = id;

  if (!map.has(key)) {
    map.set(
      key,
      {
        playerId: key,
        gsisId: id || null,
        playerName: name,
        team: teamCode,
        position,
        positionSource,
        health: "Unknown",
        healthSource: "Unavailable",

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

  if (canonicalNameKey(player.playerName) !== canonicalNameKey(name)) {
    throw new Error(`Conflicting canonical names for GSIS identity ${id}`);
  }

  if (
    !player.position &&
    position
  ) {
    player.position =
      position;
    player.positionSource = positionSource;
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
  const positionSource = player.positionSource || "inferred";

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
    positionSource,

    health: "Unknown",
    healthSource: "Unavailable",

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
    twoPointAttempt: number(row.two_point_attempt) === 1,

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
      airYards,

    yardsAfterCatch:
      number(
        row.yards_after_catch
      ),

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
    !play.twoPointAttempt &&
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
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error("Player source has malformed or duplicate CSV headers");
  }

  return lines
    .filter(Boolean)
    .map((line, index) => {
      const values =
        parseCsvLine(line);
      if (values.length !== headers.length) {
        throw new Error(`Malformed player source CSV row ${index + 2}`);
      }

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

  if (quoted) throw new Error("Malformed quoted player source CSV value");
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

function isMissingNumber(value) {
  return value == null || typeof value === "string" &&
    (value.trim() === "" || value.trim() === "NA");
}

function number(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === "" ||
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