import { gunzipSync } from "node:zlib";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDepthMetrics, validDepthLineup, validDepthRoster, weeklyDepthCutoffs } from "../api-lib/depthCharts.js";
import { fetchSchedule } from "./balldontlie-schedule.mjs";
import { buildWeeklySituationalMetrics } from "../api-lib/situationalMetrics.js";
import { buildWeeklyKickerProfiles } from "../api-lib/kickerMetrics.js";
import { completedPlayerGames, instant } from "../api-lib/playerMetrics.js";
import { NFL_TEAMS, loadWeeklyOpponentNetwork, validateWeeklyOpponentNetwork } from "../api/nfl/opponent-network.js";

const season = Number(process.argv[2] || new Date().getUTCFullYear());
const outputPath = path.resolve("api/nfl/nflverse-team-metrics.js");
const aliases = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
const release = "https://github.com/nflverse/nflverse-data/releases/download";

const depthReleaseMetadata = "https://api.github.com/repos/nflverse/nflverse-data/releases/tags/depth_charts";

export async function main() {
  if (!process.env.BALLDONTLIE_API_KEY) throw new Error("BALLDONTLIE_API_KEY required for team cutoff/completion provenance");
  console.log(`Downloading nflverse ${season} datasets...`);
  const result = await regenerateTeamMetrics({ season });
  console.log(`Wrote ${outputPath}; prediction week ${result.predictionWeek}; cutoff ${result.cutoff}`);
  console.log(JSON.stringify({ week: result.predictionWeek,
    audit: result.payload.teamMetricsAuditsByWeek[result.predictionWeek],
    priorWeekGames: result.priorWeekGames }));
}

const artifactPrefix = "const NFLVERSE_TEAM_METRICS = ";
const artifactSuffix = ";\n\nexport default NFLVERSE_TEAM_METRICS;\n";
const weeklyFields = ["metricsByWeek", "situationalAuditsByWeek", "kickerProfilesByWeek", "teamMetricsAuditsByWeek"];

export async function regenerateTeamMetrics({
  season,
  predictionWeek: requestedWeek,
  outputPath: destination = outputPath,
  fetchImpl = globalThis.fetch,
  scheduleFetcher = fetchSchedule,
  now = () => new Date(),
  io = { readFile, writeFile, rename, unlink },
  generateWeek = buildPredictionWeek,
  generateNetwork = loadWeeklyOpponentNetwork,
}) {
  const resolved = path.resolve(destination);
  if (resolved === path.resolve("data/nflverse-player-metrics.js")) {
    throw new Error("Team updater cannot write the player artifact");
  }
  const existing = parseTeamArtifact(await io.readFile(resolved, "utf8"));
  validateTeamArtifact(existing, { season });
  const depthUrl = await resolveDepthSource(season, fetchImpl);
  const pbpSource = await fetchDataset(`${release}/pbp/play_by_play_${season}.csv.gz`, fetchImpl, now);
  const snapSource = await fetchDataset(`${release}/snap_counts/snap_counts_${season}.csv`, fetchImpl, now);
  const depthSource = await fetchDataset(depthUrl, fetchImpl, now);
  const rows = parseGenericCsv(pbpSource.text);
  for (const field of ["season", "season_type", "week", "game_id", "play_id", "posteam", "defteam", "play_type", "epa", "success"]) {
    if (!rows.length || !(field in rows[0])) throw new Error(`Team PBP source missing ${field}`);
  }
  const snapRows = parseGenericCsv(snapSource.text);
  const depthRows = parseGenericCsv(depthSource.text);
  if (!snapRows.length) throw new Error("Team snap source is empty");
  validateDepthSource(depthRows);
  const games = await scheduleFetcher(season, { maxRetries: 0 });
  validateSchedule(games, season);
  const sourceAsOf = now().toISOString();
  const cutoffs = weeklyDepthCutoffs(games, season);
  const predictionWeek = requestedWeek ?? Number(Object.entries(cutoffs)
    .filter(([, cutoff]) => instant(cutoff) > instant(sourceAsOf))
    .sort(([a], [b]) => Number(a) - Number(b))[0]?.[0]);
  const cutoff = cutoffs[predictionWeek];
  if (!Number.isInteger(predictionWeek) || predictionWeek < 2 || predictionWeek > 18 || instant(cutoff) === null) {
    throw new Error("Unable to determine target team prediction week/cutoff");
  }
  const depthTeams = new Set(depthRows.filter((row) =>
    new Date(row.dt).getUTCFullYear() === season &&
    instant(row.dt) <= Math.min(instant(cutoff), instant(sourceAsOf))).map((row) => team(row.team)));
  if (NFL_TEAMS.some((code) => !depthTeams.has(code))) {
    throw new Error(`Target Week ${predictionWeek} lacks eligible depth-source coverage for all 32 teams`);
  }
  const result = generateWeek(rows, games, snapRows, depthRows, {
    season, predictionWeek, cutoff, sourceAsOf, generatedAt: sourceAsOf,
  });
  const completed = completedPlayerGames(games, season, predictionWeek, cutoff)
    .filter((game) => instant(game.completedAsOf) <= instant(sourceAsOf));
  const represented = new Set(result.audit.gameProvenance.map((game) => game.key));
  for (const game of completed) {
    if (!represented.has(game.key)) throw new Error(`Missing eligible NFLverse PBP for completed game ${game.key}`);
  }
  if (result.audit.referenceWeek !== predictionWeek - 1) {
    throw new Error(`Missing Week ${predictionWeek - 1} play-by-play for prediction Week ${predictionWeek}`);
  }
  for (const audit of Object.values(existing.teamMetricsAuditsByWeek)) {
    if (audit.predictionWeek >= predictionWeek) continue;
    for (const game of audit.gameProvenance) {
      if (!represented.has(game.key)) throw new Error(`Incomplete cumulative team history: missing ${game.key}`);
    }
  }
  for (const code of NFL_TEAMS) {
    if (!result.metrics[code]?.availability?.teamMetricsAvailable) {
      throw new Error(`Target Week ${predictionWeek} lacks team PBP coverage for ${code}`);
    }
  }
  const network = await generateNetwork(season, predictionWeek, {
    sourceGames: games.filter((game) => completed.some((entry) => entry.providerId === String(game.id))),
    cutoff, now: new Date(sourceAsOf),
  });
  validateWeeklyOpponentNetwork(network, season, predictionWeek);
  const replacements = {
    metricsByWeek: result.metrics,
    situationalAuditsByWeek: result.situational.audit,
    kickerProfilesByWeek: result.kickers,
    teamMetricsAuditsByWeek: result.audit,
  };
  const payload = {
    ...existing,
    generatedAt: sourceAsOf,
    opponentNetworkByWeek: Object.fromEntries(Object.entries({
      ...existing.opponentNetworkByWeek,
      [predictionWeek]: {
        ...network,
        provenance: {
          source: "Fourth Down completed-score Opponent Network",
          performanceSource: "Final schedule games with matching NFLverse PBP",
          cutoff, sourceAsOf,
          gameProvenance: result.audit.gameProvenance,
          distinction: "Score-based network; separate from NFLverse metric-specific opponent adjustments and ESPN SOS",
        },
      },
    }).sort(([a], [b]) => Number(a) - Number(b))),
    sourceStatus: {
      playByPlay: sourceMeta(pbpSource, true),
      snapCounts: sourceMeta(snapSource, true),
      depthCharts: sourceMeta(depthSource, true),
    },
  };
  for (const field of weeklyFields) {
    payload[field] = Object.fromEntries(Object.entries({ ...existing[field], [predictionWeek]: replacements[field] })
      .sort(([a], [b]) => Number(a) - Number(b)));
  }
  validateTeamArtifact(payload, { season, predictionWeek });
  for (const field of weeklyFields) {
    for (const [week, value] of Object.entries(existing[field])) {
      if (Number(week) !== predictionWeek && JSON.stringify(payload[field][week]) !== JSON.stringify(value)) {
        throw new Error(`Historical ${field} week ${week} changed`);
      }
    }
  }
  const pbpIds = new Set(rows.filter((row) => num(row.season) === season && row.season_type === "REG")
    .map((row) => {
      const [year, week, away, home] = String(row.game_id).split("_");
      return `${year}:${Number(week)}:${team(away)}:${team(home)}`;
    }));
  const priorWeekGames = games.filter((game) => Number(game.season) === season && Number(game.week) === predictionWeek - 1)
    .map((game) => {
      const away = team(game.visitor_team?.abbreviation || game.away_team?.abbreviation);
      const home = team(game.home_team?.abbreviation);
      const completion = game.completed_at || game.updated_at;
      const included = represented.has(`${season}:${Number(game.week)}:${[away, home].sort().join(":")}`);
      const final = game.completed === true || /^(final\b|completed?$|closed$|post$)/i.test(String(game.status || game.status_state || ""));
      return { away, home, status: game.status || game.status_state,
        completedAsOf: completion || null,
        pbpAvailable: pbpIds.has(`${season}:${Number(game.week)}:${away}:${home}`), included,
        exclusionReason: included ? null : !final ? "Not explicitly final/completed"
          : instant(completion) === null ? "Missing valid completion observation"
          : instant(completion) < instant(game.date) ? "Completion precedes kickoff"
          : instant(completion) > instant(cutoff) ? "Completion is after cutoff"
          : instant(completion) > instant(sourceAsOf) ? "Completion not yet observed at source time"
          : "No matching eligible regular-season PBP before cutoff" };
    });
  await writeTeamArtifactAtomically(resolved, serializeTeamArtifact(payload), { season, predictionWeek, io });
  return { payload, predictionWeek, cutoff, games, priorWeekGames };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export function parseTeamArtifact(text) {
  if (!text.startsWith(artifactPrefix) || !text.endsWith(artifactSuffix)) throw new Error("Invalid team artifact wrapper");
  return JSON.parse(text.slice(artifactPrefix.length, -artifactSuffix.length));
}

export function serializeTeamArtifact(artifact) {
  return `${artifactPrefix}${JSON.stringify(artifact, null, 2)}${artifactSuffix}`;
}

export async function writeTeamArtifactAtomically(destination, serialized, { season, predictionWeek, io }) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await io.writeFile(temporary, serialized, { flag: "wx" });
    const bytes = await io.readFile(temporary, "utf8");
    if (bytes !== serialized) throw new Error("Temporary team artifact bytes differ from validated serialization");
    validateTeamArtifact(parseTeamArtifact(bytes), { season, predictionWeek });
    await io.rename(temporary, destination);
  } catch (error) {
    try {
      await io.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Team update and temporary cleanup failed");
    }
    throw error;
  }
}

export function validateTeamArtifact(artifact, { season, predictionWeek }) {
  if (artifact?.season !== season || instant(artifact.generatedAt) === null) throw new Error("Invalid team artifact season/provenance");
  const weeks = Object.keys(artifact.metricsByWeek || {});
  if (!weeks.length) throw new Error("Team artifact contexts missing");
  for (const field of weeklyFields) {
    if (JSON.stringify(Object.keys(artifact[field] || {}).sort()) !== JSON.stringify([...weeks].sort())) {
      throw new Error(`Team artifact ${field} week coverage mismatch`);
    }
  }
  const finite = (value) => typeof value === "number" ? Number.isFinite(value)
    : !value || typeof value !== "object" || Object.values(value).every(finite);
  if (!finite(artifact)) throw new Error("Non-finite team artifact metrics");
  for (const [weekText, network] of Object.entries(artifact.opponentNetworkByWeek || {})) {
    const audit = artifact.teamMetricsAuditsByWeek[weekText];
    validateWeeklyOpponentNetwork(network, season, Number(weekText));
    if (!audit || network.provenance?.cutoff !== audit.cutoff ||
        network.provenance?.sourceAsOf !== audit.sourceAsOf ||
        JSON.stringify(network.provenance.gameProvenance) !== JSON.stringify(audit.gameProvenance)) {
      throw new Error(`Invalid network provenance for week ${weekText}`);
    }
    const represented = new Set(audit.gameProvenance.map((game) => String(game.providerId)));
    if (network.games.length !== represented.size || network.games.some((game) => !represented.has(String(game.id)))) {
      throw new Error(`Network/team game coverage mismatch for week ${weekText}`);
    }
  }
  for (const text of weeks) {
    const week = Number(text), teams = artifact.metricsByWeek[text], audit = artifact.teamMetricsAuditsByWeek[text];
    if (!/^(?:[2-9]|1[0-8])$/.test(text) || Object.keys(teams).length !== 32 ||
        NFL_TEAMS.some((team) => !teams[team]) || Object.keys(teams).some((team) => !NFL_TEAMS.includes(team))) {
      throw new Error(`Invalid team coverage for week ${text}`);
    }
    if (audit.season !== season || audit.predictionWeek !== week || instant(audit.cutoff) === null ||
        instant(audit.sourceAsOf) === null || !Array.isArray(audit.gameProvenance) ||
        audit.eligibleGames !== audit.gameProvenance.length) throw new Error(`Invalid team audit for week ${week}`);
    const seen = new Set(), matchups = new Set();
    for (const game of audit.gameProvenance) {
      if (!game.gameId || seen.has(game.gameId) || matchups.has(game.key) || !NFL_TEAMS.includes(game.away) || !NFL_TEAMS.includes(game.home) ||
          game.away === game.home || game.week >= week || game.week < 1 ||
          instant(game.kickoff) === null || instant(game.completedAsOf) === null ||
          instant(game.completedAsOf) < instant(game.kickoff) ||
          instant(game.completedAsOf) > Math.min(instant(audit.cutoff), instant(audit.sourceAsOf))) {
        throw new Error(`Invalid/duplicate/future team game for week ${week}`);
      }
      seen.add(game.gameId);
      matchups.add(game.key);
    }
    for (const [code, metrics] of Object.entries(teams)) {
      if (metrics.team !== code || metrics.season !== season || metrics.predictionWeek !== week ||
          metrics.cutoff !== audit.cutoff || !metrics.availability || !metrics.opponentAdjusted ||
          !metrics.situational) throw new Error(`Invalid team metric identity/schema ${week}:${code}`);
      if (week === predictionWeek) {
        const lineup = metrics.expectedLineup;
        if (!validDepthRoster(lineup, week, season) || lineup.cutoff !== audit.cutoff ||
            instant(lineup.snapshotAt) > instant(audit.sourceAsOf) ||
            metrics.availability.contextAvailable !== true ||
            metrics.availability.lineupAvailable !== validDepthLineup(lineup, week, season) ||
            metrics.provenance?.context?.observedAt !== lineup.snapshotAt) {
          throw new Error(`Invalid target-week depth context ${week}:${code}`);
        }
        const kicker = metrics.expectedKicker;
        if (kicker && (kicker.team !== code || kicker.provenance?.observedAt !== lineup.snapshotAt ||
            !lineup.roster.some((player) => player.position === "K" &&
              player.playerId === kicker.depthChartPlayerId))) {
          throw new Error(`Invalid target-week kicker identity ${week}:${code}`);
        }
      }
    }
    if (artifact.kickerProfilesByWeek[text].cutoff !== audit.cutoff ||
        artifact.situationalAuditsByWeek[text].cutoff !== audit.cutoff) throw new Error(`Mismatched team feature cutoff ${week}`);
  }
}

function validateSchedule(games, season) {
  if (!Array.isArray(games) || !games.length) throw new Error("Empty team schedule");
  const seen = new Set();
  for (const game of games.filter((game) => Number(game.season) === season && game.postseason !== true)) {
    const away = team(game.visitor_team?.abbreviation || game.away_team?.abbreviation);
    const home = team(game.home_team?.abbreviation);
    const key = `${game.week}:${away}:${home}`;
    if (seen.has(key) || !NFL_TEAMS.includes(away) || !NFL_TEAMS.includes(home) || away === home ||
        instant(game.date) === null) throw new Error(`Invalid or duplicate schedule game ${key}`);
    seen.add(key);
  }
}

async function resolveDepthSource(season, fetchImpl) {
  const response = await fetchImpl(depthReleaseMetadata, {
    headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Required depth release metadata unavailable (${response.status})`);
  const metadata = await response.json();
  if (metadata?.tag_name !== "depth_charts" || !Array.isArray(metadata.assets)) {
    throw new Error("Malformed official depth release metadata");
  }
  for (const name of [`depth_charts_${season}.csv.gz`, `depth_charts_${season}.csv`]) {
    const matches = metadata.assets.filter((asset) => asset.name === name);
    if (matches.length > 1) throw new Error(`Duplicate official depth asset ${name}`);
    if (!matches.length) continue;
    const asset = matches[0];
    if (asset.state !== "uploaded" || !Number.isFinite(asset.size) || asset.size <= 0 ||
        asset.browser_download_url !== `${release}/depth_charts/${name}`) {
      throw new Error(`Invalid official depth asset ${name}`);
    }
    return asset.browser_download_url;
  }
  throw new Error(`Required official depth-chart CSV asset unavailable for ${season}; no personnel substitution permitted`);
}

function validateDepthSource(rows) {
  if (!rows.length) throw new Error("Team depth source is empty");
  for (const field of ["dt", "team", "espn_id", "gsis_id", "pos_grp", "pos_abb", "pos_slot", "pos_rank"]) {
    if (!(field in rows[0])) throw new Error(`Team depth source missing ${field}`);
  }
  for (const row of rows) {
    if (instant(row.dt) === null || !NFL_TEAMS.includes(team(row.team)) ||
        !(row.espn_id || row.gsis_id) || !row.pos_grp || !row.pos_abb ||
        !Number.isInteger(num(row.pos_rank)) || num(row.pos_rank) < 1 ||
        (!row.pos_slot && !(row.pos_grp === "Special Teams" && row.pos_abb === "K"))) {
      throw new Error("Malformed team depth source row");
    }
  }
}

async function fetchDataset(url, fetchImpl, now) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Required dataset unavailable: ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = url.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return { url, text, fetchedAt: now().toISOString(), required: true };
}

function sourceMeta(source, required) {
  return source
    ? { available: true, required, url: source.url, fetchedAt: source.fetchedAt }
    : { available: false, required, url: null, fetchedAt: null };
}

export function parsePbp(rows) {
  return rows.map((row) => ({
    season: num(row.season),
    playId: row.play_id || "",
    gameId: row.game_id || "",
    seasonType: row.season_type || "",
    week: num(row.week) || 0,
    posteam: team(row.posteam),
    defteam: team(row.defteam),
    playType: row.play_type || "",
    drive: row.drive || "",
    driveResult: row.drive_result || "",
    epa: num(row.epa),
    success: num(row.success),
    pass: num(row.pass) || 0,
    rush: num(row.rush) || 0,
    completePass: num(row.complete_pass) || 0,
    yards: num(row.yards_gained) || 0,
    down: num(row.down),
    yardline100: num(row.yardline_100),
    wp: num(row.wp),
    qbHit: num(row.qb_hit) || 0,
    sack: num(row.sack) || 0,
    interception: num(row.interception) || 0,
    fumble: num(row.fumble) || 0,
    fumbleLost: num(row.fumble_lost) || 0,
    forcedFumble: num(row.forced_fumble) || 0,
    qbScramble: num(row.qb_scramble) || 0,
    airYards: num(row.air_yards),
    yardsAfterCatch: num(row.yards_after_catch),
    passerName: cleanName(row.passer_player_name || row.passer),
    penalty: num(row.penalty) || 0,
    penaltyYards: num(row.penalty_yards) || 0,
    thirdMade: num(row.third_down_converted) || 0,
    thirdMissed: num(row.third_down_failed) || 0,
    touchdown: num(row.touchdown) || 0,
    fieldGoalMade: row.field_goal_result === "made" ? 1 : 0,
    extraPointMade: row.extra_point_result === "good" ? 1 : 0,
    twoPointMade: row.two_point_conv_result === "success" ? 1 : 0,
    firstDown: num(row.first_down) || 0,
    receiverName: cleanName(row.receiver_player_name || row.receiver),
    rusherName: cleanName(row.rusher_player_name || row.rusher),
  }));
}

export function buildPredictionWeek(rows, games, snapRows, depthRows, context) {
  const { season, predictionWeek, cutoff, sourceAsOf } = context;
  if (!Number.isInteger(season) || !Number.isInteger(predictionWeek) ||
      instant(cutoff) === null || instant(sourceAsOf) === null) {
    throw new Error("Team-metrics prediction-week provenance is incomplete");
  }
  const historical = rows.filter((row) => num(row.season) === season &&
    row.season_type === "REG" && num(row.week) >= 1 && num(row.week) < predictionWeek);
  const completed = completedPlayerGames(games, season, predictionWeek, cutoff)
    .filter((game) => instant(game.completedAsOf) <= instant(sourceAsOf));
  const byMatchup = new Map(completed.map((game) => [game.key, game]));
  const gameIds = new Map();
  const idsByMatchup = new Map();
  const unique = new Map();
  for (const play of parsePbp(historical)) {
    const [idSeason, idWeek, idAway, idHome] = play.gameId.split("_");
    if (num(idSeason) !== season || num(idWeek) !== play.week) continue;
    const away = team(idAway), home = team(idHome);
    const game = byMatchup.get(`${season}:${play.week}:${[away, home].sort().join(":")}`);
    if (!game || game.away !== away || game.home !== home || !play.playId || !isEligible(play) ||
        ![game.away, game.home].includes(play.posteam) ||
        ![game.away, game.home].includes(play.defteam) || play.posteam === play.defteam) continue;
    const previousId = idsByMatchup.get(game.key);
    if (previousId && previousId !== play.gameId) throw new Error(`Conflicting team-metrics game IDs for ${game.key}`);
    idsByMatchup.set(game.key, play.gameId);
    gameIds.set(play.gameId, game);
    const key = `${play.gameId}:${play.playId}`;
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(play)) {
      throw new Error(`Conflicting team-metrics play ${key}`);
    }
    unique.set(key, play);
  }
  const sample = [...unique.values()];
  const referenceWeek = sample.length ? Math.max(...sample.map((play) => play.week)) : null;
  const eligible = sample.map((play) => ({ ...play, recencyWeight: recencyWeight(play.week, referenceWeek) }));
  const performanceTeams = [...new Set(eligible.flatMap((play) => [play.posteam, play.defteam]))];
  const base = Object.fromEntries(performanceTeams.map((code) => [code, buildMetrics(eligible, code)]));
  const represented = [...new Set(sample.map((play) => play.gameId))].map((id) => ({ ...gameIds.get(id), gameId: id }));
  const completedTeamWeeks = new Set(represented.flatMap((game) =>
    [game.away, game.home].map((code) => `${code}:${game.week}`)));
  const snap = buildSnapMetrics(snapRows.filter((row) =>
    completedTeamWeeks.has(`${team(row.team || row.team_abbr || row.club_code)}:${num(row.week)}`)), predictionWeek);
  const depth = buildDepthMetrics(depthRows.filter((row) =>
    instant(row.dt) !== null && instant(row.dt) <= instant(sourceAsOf)), { season, predictionWeek, cutoff });
  const situational = buildWeeklySituationalMetrics(historical, games, context);
  const kickers = buildWeeklyKickerProfiles(historical, games, context);
  const teams = [...new Set([
    ...Object.keys(situational.teams),
    ...Object.keys(depth),
    ...Object.keys(base),
    ...Object.keys(kickers.profilesByTeam),
  ])].sort();
  return {
    metrics: Object.fromEntries(teams.map((code) => {
      const teamMetricsAvailable = Boolean(base[code]);
      const opponentAdjusted = teamMetricsAvailable
        ? buildOpponentAdjustedMetrics(code, base, eligible)
        : unavailableOpponentAdjustedMetrics();
      const expectedLineup = depth[code] || null;
      const lineupAvailable = validDepthLineup(expectedLineup, predictionWeek, season);
      const situationalMetrics = situational.teams[code] || null;
      const situationalAvailable = Boolean(situationalMetrics?.gameProvenance?.length &&
        (situationalMetrics.thirdDown.offense.opportunities > 0 ||
          situationalMetrics.redZone.offense.opportunities > 0));
      const situationalUnavailableReason =
        "No eligible completed point-in-time situational sample before cutoff";
      const teamProfiles = kickers.profilesByTeam[code] || [];
      const expectedKicker = expectedKickerFromLineup(expectedLineup, code);
      const availability = {
        contextAvailable: validDepthRoster(expectedLineup, predictionWeek, season),
        lineupAvailable,
        teamMetricsAvailable,
        opponentAdjustedAvailable: Boolean(teamMetricsAvailable && opponentAdjusted.opponents.length),
        phase1Available: teamMetricsAvailable,
        situationalAvailable,
        kickerIdentityAvailable: Boolean(expectedKicker),
        kickerProfileAvailable: teamProfiles.length > 0,
      };
      return [code, {
        ...(base[code] || unavailableTeamMetrics(code)),
        team: code,
        season,
        predictionWeek,
        cutoff,
        schemaVersion: 1,
        availability,
        provenance: {
          schemaVersion: 1,
          season,
          predictionWeek,
          cutoff,
          context: expectedLineup ? {
            source: "nflverse depth charts",
            observedAt: expectedLineup.snapshotAt,
            available: availability.contextAvailable,
          } : { source: "nflverse depth charts", observedAt: null, available: false },
          performance: {
            source: "nflverse play-by-play",
            available: teamMetricsAvailable,
            eligibleGames: represented.filter((game) => game.away === code || game.home === code).length,
            reason: teamMetricsAvailable ? null : "No completed point-in-time team PBP sample before cutoff",
          },
        },
        opponentAdjusted,
        snapParticipation: snap[code] || unavailableSnapParticipation(),
        expectedLineup,
        expectedKicker,
        situational: situationalAvailable ? {
          ...situationalMetrics,
          available: true,
          unavailableReason: null,
        } : unavailableSituationalMetrics(code, season, predictionWeek, cutoff, sourceAsOf,
          situationalUnavailableReason),
      }];
    })),
    audit: {
      available: sample.length > 0,
      reason: sample.length ? null : "No completed point-in-time team PBP sample before cutoff",
      season, predictionWeek, cutoff, sourceAsOf, referenceWeek,
      eligiblePlays: sample.length, eligibleGames: represented.length,
      gameProvenance: represented,
    },
    situational, kickers,
  };
}

function expectedKickerFromLineup(lineup, code) {
  const kickers = (lineup?.roster || []).filter((player) => player.position === "K" &&
    player.rank > 0 && player.team !== "UNKNOWN")
    .sort((a, b) => a.rank - b.rank || a.playerId.localeCompare(b.playerId));
  if (!kickers.length || kickers[0].identityConflict ||
      kickers[1]?.rank === kickers[0].rank) return null;
  const kicker = kickers[0];
  return {
    playerId: String(kicker.gsisId || kicker.playerId),
    canonicalPlayerId: String(kicker.gsisId || kicker.playerId),
    depthChartPlayerId: String(kicker.playerId),
    fullName: kicker.name,
    team: code,
    position: "K",
    status: kicker.status,
    statusKnown: kicker.statusKnown,
    depth: kicker.rank,
    provenance: {
      source: "nflverse depth charts",
      observedAt: lineup.snapshotAt,
      sourcePosition: kicker.sourcePosition || null,
    },
  };
}

function unavailableTeamMetrics(code) {
  return {
    team: code,
    games: null,
    offensivePlays: null,
    defensivePlays: null,
    epaPerPlay: null,
    defensiveEpaPerPlay: null,
    successRate: null,
    defensiveSuccessRate: null,
    passingEpaPerPlay: null,
    rushingEpaPerPlay: null,
    earlyDownEpaPerPlay: null,
    explosivePlayRate: null,
    explosivePlayRateAllowed: null,
    passingEpaAllowedPerPlay: null,
    rushingEpaAllowedPerPlay: null,
    pressureAllowedRate: null,
    sackRateAllowed: null,
    sacksAllowed: null,
    pressureGeneratedRate: null,
    sackRateGenerated: null,
    sacksGenerated: null,
    qbHitsGenerated: null,
    pressureToSackRateAllowed: null,
    pressureToSackRateGenerated: null,
    interceptionsThrown: null,
    interceptionRate: null,
    interceptionsGenerated: null,
    defensiveInterceptionRate: null,
    offensiveFumbles: null,
    fumblesLost: null,
    fumbleLostRate: null,
    defensiveFumblesForced: null,
    defensiveFumbleRecoveries: null,
    turnoversPerDrive: null,
    takeawaysPerDrive: null,
    qbScrambleRate: null,
    completionRate: null,
    airYardsPerAttempt: null,
    yardsAfterCatchPerCompletion: null,
    penaltiesPerPlay: null,
    penaltyYardsPerPlay: null,
    playsPerGame: null,
    quarterback: null,
    sampleReliability: null,
    thirdDownRate: null,
    redZoneTouchdownRate: null,
    drives: null,
    scoringDriveRate: null,
    threeAndOutRate: null,
    longestReception: null,
    longestRush: null,
  };
}

function unavailableOpponentAdjustedMetrics() {
  return {
    available: false,
    opponents: [],
    epaPerPlay: null,
    defensiveEpaPerPlay: null,
    successRate: null,
    defensiveSuccessRate: null,
    passingEpaPerPlay: null,
    rushingEpaPerPlay: null,
    explosivePlayRate: null,
  };
}

function unavailableSnapParticipation() {
  return {
    available: false,
    rows: 0,
    offensiveRegulars: null,
    defensiveRegulars: null,
    offensiveLineRegulars: null,
    continuityScore: null,
  };
}

function unavailableSituationalMetrics(team, season, predictionWeek, cutoff, sourceAsOf, reason) {
  return {
    team,
    schemaVersion: 1,
    season,
    predictionWeek,
    cutoff,
    sourceAsOf,
    available: false,
    unavailableReason: reason,
    gameProvenance: [],
    thirdDown: null,
    redZone: null,
    league: null,
  };
}

export function parseGenericCsv(text) {
  const lines = text.split(/\r?\n/);
  const headings = parseCsvLine(lines.shift() || "");
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headings.map((heading, index) => [heading, values[index] ?? ""]));
  });
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { values.push(value); value = ""; }
    else value += character;
  }
  values.push(value);
  return values;
}

function isEligible(play) {
  return play.seasonType === "REG" && play.posteam && play.defteam &&
    !["no_play", "qb_kneel", "qb_spike"].includes(play.playType) &&
    (play.wp === null || (play.wp >= 0.05 && play.wp <= 0.95));
}

function buildMetrics(plays, code) {
  const offense = plays.filter((play) => play.posteam === code);
  const defense = plays.filter((play) => play.defteam === code);
  const passes = offense.filter((play) => play.pass === 1);
  const defensiveDropbacks = defense.filter((play) => play.pass === 1);
  const rushes = offense.filter((play) => play.rush === 1);
  const earlyDowns = offense.filter((play) => play.down === 1 || play.down === 2);
  const thirdDowns = offense.filter((play) => play.thirdMade || play.thirdMissed);
  const redZoneDrives = new Map();
  for (const play of offense.filter((item) => item.yardline100 !== null && item.yardline100 <= 20)) {
    const key = `${play.gameId}:${play.drive}`;
    const existing = redZoneDrives.get(key) || false;
    redZoneDrives.set(key, existing || play.touchdown === 1);
  }
  const explosive = offense.filter((play) => (play.pass && play.yards >= 20) || (play.rush && play.yards >= 10));
  const defensiveExplosive = defense.filter((play) => (play.pass && play.yards >= 20) || (play.rush && play.yards >= 10));
  const defensivePasses = defense.filter((play) => play.pass === 1);
  const defensiveRushes = defense.filter((play) => play.rush === 1);
  const drives = groupDrives(offense);
  const driveList = [...drives.values()];
  const longestReception = maxPlay(passes.filter((play) => play.completePass && play.receiverName), "receiverName");
  const longestRush = maxPlay(rushes.filter((play) => play.rusherName), "rusherName");

  return {
    team: code,
    games: new Set(offense.map((play) => play.gameId)).size,
    offensivePlays: offense.length,
    defensivePlays: defense.length,
    epaPerPlay: weightedAverage(offense, "epa"),
    defensiveEpaPerPlay: weightedAverage(defense, "epa"),
    successRate: weightedAverage(offense, "success"),
    defensiveSuccessRate: weightedAverage(defense, "success"),
    passingEpaPerPlay: weightedAverage(passes, "epa"),
    rushingEpaPerPlay: weightedAverage(rushes, "epa"),
    earlyDownEpaPerPlay: weightedAverage(earlyDowns, "epa"),
    explosivePlayRate: rate(explosive.length, offense.length),
    explosivePlayRateAllowed: rate(defensiveExplosive.length, defense.length),
    passingEpaAllowedPerPlay: weightedAverage(defensivePasses, "epa"),
    rushingEpaAllowedPerPlay: weightedAverage(defensiveRushes, "epa"),
    pressureAllowedRate: rate(passes.filter((play) => play.qbHit || play.sack).length, passes.length),
    sackRateAllowed: rate(passes.filter((play) => play.sack).length, passes.length),
    sacksAllowed: passes.filter((play) => play.sack).length,
    pressureGeneratedRate: rate(defensiveDropbacks.filter((play) => play.qbHit || play.sack).length, defensiveDropbacks.length),
    sackRateGenerated: rate(defensiveDropbacks.filter((play) => play.sack).length, defensiveDropbacks.length),
    sacksGenerated: defensiveDropbacks.filter((play) => play.sack).length,
    qbHitsGenerated: defensiveDropbacks.filter((play) => play.qbHit).length,
    pressureToSackRateAllowed: rate(passes.filter((play) => play.sack).length, passes.filter((play) => play.qbHit || play.sack).length),
    pressureToSackRateGenerated: rate(defensiveDropbacks.filter((play) => play.sack).length, defensiveDropbacks.filter((play) => play.qbHit || play.sack).length),
    interceptionsThrown: passes.filter((play) => play.interception).length,
    interceptionRate: rate(passes.filter((play) => play.interception).length, passes.length),
    interceptionsGenerated: defensiveDropbacks.filter((play) => play.interception).length,
    defensiveInterceptionRate: rate(defensiveDropbacks.filter((play) => play.interception).length, defensiveDropbacks.length),
    offensiveFumbles: offense.filter((play) => play.fumble).length,
    fumblesLost: offense.filter((play) => play.fumbleLost).length,
    fumbleLostRate: rate(offense.filter((play) => play.fumbleLost).length, offense.length),
    defensiveFumblesForced: defense.filter((play) => play.forcedFumble || play.fumble).length,
    defensiveFumbleRecoveries: defense.filter((play) => play.fumbleLost).length,
    turnoversPerDrive: rate(offense.filter((play) => play.interception || play.fumbleLost).length, drives.size),
    takeawaysPerDrive: rate(defense.filter((play) => play.interception || play.fumbleLost).length, groupDrives(defense).size),
    qbScrambleRate: rate(passes.filter((play) => play.qbScramble).length, passes.length),
    completionRate: rate(passes.filter((play) => play.completePass).length, passes.filter((play) => !play.sack).length),
    airYardsPerAttempt: average(passes.map((play) => play.airYards)),
    yardsAfterCatchPerCompletion: average(passes.filter((play) => play.completePass).map((play) => play.yardsAfterCatch)),
    penaltiesPerPlay: rate(offense.filter((play) => play.penalty).length, offense.length),
    penaltyYardsPerPlay: rate(offense.reduce((sum, play) => sum + (play.penaltyYards || 0), 0), offense.length),
    playsPerGame: rate(offense.length, new Set(offense.map((play) => play.gameId)).size),
    quarterback: buildQuarterbackMetrics(passes),
    sampleReliability: round(Math.min(1, offense.length / 250)),
    thirdDownRate: rate(thirdDowns.filter((play) => play.thirdMade).length, thirdDowns.length),
    redZoneTouchdownRate: rate([...redZoneDrives.values()].filter(Boolean).length, redZoneDrives.size),
    drives: drives.size,
    scoringDriveRate: rate(driveList.filter((drive) => drive.scored).length, drives.size),
    threeAndOutRate: rate(driveList.filter((drive) => drive.plays <= 3 && drive.firstDowns === 0 && !drive.scored).length, drives.size),
    longestReception,
    longestRush,
  };
}

function groupDrives(plays) {
  const drives = new Map();
  for (const play of plays) {
    if (!play.gameId || !play.drive) continue;
    const key = `${play.gameId}:${play.drive}`;
    const drive = drives.get(key) || { plays: 0, firstDowns: 0, scored: false };
    drive.plays += 1;
    drive.firstDowns += play.firstDown ? 1 : 0;
    drive.scored ||= Boolean(play.touchdown || play.fieldGoalMade || play.extraPointMade || play.twoPointMade || /touchdown|field goal/i.test(play.driveResult));
    drives.set(key, drive);
  }
  return drives;
}

function buildOpponentAdjustedMetrics(code, base, plays) {
  const opponents = [];
  for (const play of plays) {
    if (play.posteam === code && play.defteam) opponents.push(play.defteam);
    if (play.defteam === code && play.posteam) opponents.push(play.posteam);
  }
  const uniqueOpponents = [...new Set(opponents)].filter((opponent) => base[opponent]);
  const opponentOffense = average(uniqueOpponents.map((opponent) => base[opponent].epaPerPlay));
  const opponentDefense = average(uniqueOpponents.map((opponent) => base[opponent].defensiveEpaPerPlay));
  const own = base[code];
  return {
    opponents: uniqueOpponents,
    epaPerPlay: round(own.epaPerPlay - opponentDefense),
    defensiveEpaPerPlay: round(own.defensiveEpaPerPlay - opponentOffense),
    successRate: round(own.successRate - average(uniqueOpponents.map((opponent) => base[opponent].defensiveSuccessRate))),
    defensiveSuccessRate: round(own.defensiveSuccessRate - average(uniqueOpponents.map((opponent) => base[opponent].successRate))),
    passingEpaPerPlay: round(own.passingEpaPerPlay - average(uniqueOpponents.map((opponent) => base[opponent].passingEpaAllowedPerPlay))),
    rushingEpaPerPlay: round(own.rushingEpaPerPlay - average(uniqueOpponents.map((opponent) => base[opponent].rushingEpaAllowedPerPlay))),
    explosivePlayRate: round(own.explosivePlayRate - average(uniqueOpponents.map((opponent) => base[opponent].explosivePlayRateAllowed))),
  };
}

function buildSnapMetrics(rows, predictionWeek) {
  const map = {};
  for (const row of rows) {
    const week = num(row.week);
    if (week !== null && week >= predictionWeek) continue;
    const code = team(row.team || row.team_abbr || row.club_code);
    if (!code) continue;
    const player = cleanName(row.player || row.player_name || row.player_display_name);
    const offensePct = normalisePercent(row.offense_pct || row.offense_percent || row.offense_snap_pct);
    const defensePct = normalisePercent(row.defense_pct || row.defense_percent || row.defense_snap_pct);
    const entry = map[code] ||= { rows: 0, offensiveRegulars: new Set(), defensiveRegulars: new Set(), offensiveLineRegulars: new Set() };
    entry.rows += 1;
    if (player && offensePct >= 0.5) entry.offensiveRegulars.add(player);
    if (player && defensePct >= 0.5) entry.defensiveRegulars.add(player);
    const position = String(row.position || row.pos || "").toUpperCase();
    if (player && offensePct >= 0.5 && /^(C|G|OG|T|OT|OL|LT|LG|RG|RT)$/.test(position)) entry.offensiveLineRegulars.add(player);
  }
  return Object.fromEntries(Object.entries(map).map(([code, entry]) => [code, {
    available: entry.rows > 0,
    rows: entry.rows,
    offensiveRegulars: entry.offensiveRegulars.size,
    defensiveRegulars: entry.defensiveRegulars.size,
    offensiveLineRegulars: entry.offensiveLineRegulars.size,
    continuityScore: round(Math.min(1, (entry.offensiveRegulars.size + entry.defensiveRegulars.size) / 22)),
  }]));
}

function maxPlay(plays, nameKey) {
  const play = plays.reduce((best, current) => !best || current.yards > best.yards ? current : best, null);
  return play ? { player: play[nameKey], yards: play.yards } : null;
}

function buildQuarterbackMetrics(passes) {
  const byPasser = new Map();
  for (const play of passes) {
    if (!play.passerName) continue;
    const rows = byPasser.get(play.passerName) || [];
    rows.push(play);
    byPasser.set(play.passerName, rows);
  }
  const ranked = [...byPasser.entries()]
    .map(([player, rows]) => ({
      player,
      dropbacks: rows.length,
      epaPerDropback: weightedAverage(rows, "epa"),
      successRate: weightedAverage(rows, "success"),
      completionRate: rate(rows.filter((play) => play.completePass).length, rows.filter((play) => !play.sack).length),
      pressureRate: rate(rows.filter((play) => play.qbHit || play.sack).length, rows.length),
      sackRate: rate(rows.filter((play) => play.sack).length, rows.length),
      interceptionRate: rate(rows.filter((play) => play.interception).length, rows.length),
      fumbles: rows.filter((play) => play.fumble).length,
      fumblesLost: rows.filter((play) => play.fumbleLost).length,
      scrambleRate: rate(rows.filter((play) => play.qbScramble).length, rows.length),
    }))
    .sort((a, b) => b.dropbacks - a.dropbacks);
  return ranked[0] || null;
}
function recencyWeight(week, latestWeek) {
  const age = Math.max(0, latestWeek - week);
  return [1, 0.95, 0.85, 0.75][age] || 0.65;
}
function weightedAverage(rows, key) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const value = Number(row?.[key]);
    if (!Number.isFinite(value)) continue;
    const weight = Number(row.recencyWeight) || 1;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator ? round(numerator / denominator) : 0;
}
function normalisePercent(value) { const parsed = num(value); return parsed === null ? 0 : parsed > 1 ? parsed / 100 : parsed; }
function cleanName(value) { const name = String(value || "").trim(); return name && name !== "NA" ? name : null; }
function num(value) { if (value === undefined || value === "" || value === "NA") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function team(value) { const code = String(value || "").trim().toUpperCase(); return aliases[code] || code; }
function average(values) { const valid = values.filter(Number.isFinite); return valid.length ? round(valid.reduce((total, value) => total + value, 0) / valid.length) : 0; }
function rate(numerator, denominator) { return denominator ? round(numerator / denominator) : 0; }
function round(value) { return Math.round((Number(value) || 0) * 10000) / 10000; }
