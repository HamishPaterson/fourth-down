import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const season = Number(process.argv[2] || new Date().getUTCFullYear());
const outputPath = path.resolve("api/nfl/nflverse-team-metrics.js");
const aliases = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
const release = "https://github.com/nflverse/nflverse-data/releases/download";

const sourceCandidates = {
  pbp: [`${release}/pbp/play_by_play_${season}.csv.gz`],
  snapCounts: [
    `${release}/snap_counts/snap_counts_${season}.csv`,
    `${release}/snap_counts/snap_counts_${season}.csv.gz`,
  ],
  depthCharts: [
    `${release}/depth_charts/depth_charts_${season}.csv`,
    `${release}/depth_charts/depth_charts_${season}.csv.gz`,
  ],
};

console.log(`Downloading nflverse ${season} datasets...`);
const pbpSource = await fetchFirst(sourceCandidates.pbp, true);
const snapSource = await fetchFirst(sourceCandidates.snapCounts, false);
const depthSource = await fetchFirst(sourceCandidates.depthCharts, false);
const plays = parsePbp(pbpSource.text);
const snapRows = snapSource ? parseGenericCsv(snapSource.text) : [];
const depthRows = depthSource ? parseGenericCsv(depthSource.text) : [];
const completedWeeks = [...new Set(plays.map((play) => play.week).filter((week) => week > 0))].sort((a, b) => a - b);
const metricsByWeek = {};

for (const predictionWeek of completedWeeks.map((week) => week + 1)) {
  const eligible = plays.filter((play) => play.week < predictionWeek && isEligible(play));
  const teams = [...new Set(eligible.flatMap((play) => [play.posteam, play.defteam]).filter(Boolean))];
  const base = Object.fromEntries(teams.map((code) => [code, buildMetrics(eligible, code)]));
  const snap = buildSnapMetrics(snapRows, predictionWeek);
  const depth = buildDepthMetrics(depthRows, predictionWeek);

  metricsByWeek[predictionWeek] = Object.fromEntries(teams.map((code) => [
    code,
    {
      ...base[code],
      opponentAdjusted: buildOpponentAdjustedMetrics(code, base, eligible),
      snapParticipation: snap[code] || null,
      expectedLineup: depth[code] || null,
    },
  ]));
}

const payload = {
  season,
  generatedAt: new Date().toISOString(),
  source: "nflverse/nflfastR",
  garbageTimeFilter: "Win probability between 5% and 95%",
  weighting: {
    method: "play-level recency weighting",
    currentSeasonShareFromWeek5: 0.75,
    priorBaselineShareFromWeek5: 0.10,
    marketCalibrationShareFromWeek5: 0.15,
    recentFourGameMultipliers: [0.75, 0.85, 0.95, 1.00],
  },
  pressureDefinition: "qb_hit or sack proxy from play-by-play; not charted pressure",
  sourceStatus: {
    playByPlay: sourceMeta(pbpSource, true),
    snapCounts: sourceMeta(snapSource, false),
    depthCharts: sourceMeta(depthSource, false),
  },
  metricsByWeek,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `const NFLVERSE_TEAM_METRICS = ${JSON.stringify(payload, null, 2)};\n\nexport default NFLVERSE_TEAM_METRICS;\n`);
console.log(`Wrote ${outputPath}`);
console.log(`PBP: ${plays.length} plays | snap counts: ${snapRows.length} rows | depth charts: ${depthRows.length} rows`);

async function fetchFirst(urls, required) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        errors.push(`${url} (${response.status})`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = url.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      return { url, text, fetchedAt: new Date().toISOString() };
    } catch (error) {
      errors.push(`${url} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (required) throw new Error(`Required dataset unavailable: ${errors.join("; ")}`);
  console.warn(`Optional dataset unavailable: ${errors.join("; ")}`);
  return null;
}

function sourceMeta(source, required) {
  return source
    ? { available: true, required, url: source.url, fetchedAt: source.fetchedAt }
    : { available: false, required, url: null, fetchedAt: null };
}

function parsePbp(text) {
  return parseGenericCsv(text).map((row) => ({
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
  })).map((play, index, rows) => ({
    ...play,
    recencyWeight: recencyWeight(play.week, Math.max(...rows.map((item) => item.week || 0))),
  }));
}

function parseGenericCsv(text) {
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

function buildDepthMetrics(rows, predictionWeek) {
  const map = {};
  for (const row of rows) {
    const week = num(row.week);
    if (week !== null && week > predictionWeek) continue;
    const code = team(row.team || row.club_code);
    if (!code) continue;
    const rank = num(row.pos_rank || row.depth_team || row.depth_chart_order);
    const player = cleanName(row.player_name || row.full_name || row.football_name);
    const position = String(row.pos_abb || row.position || row.depth_position || "").toUpperCase();
    const entry = map[code] ||= { rows: 0, projectedStarters: 0, offensiveLineStarters: 0, schema: Object.keys(row) };
    entry.rows += 1;
    if (player && (rank === 1 || row.depth_team === "1")) {
      entry.projectedStarters += 1;
      if (/^(C|G|OG|T|OT|OL|LT|LG|RG|RT)$/.test(position)) entry.offensiveLineStarters += 1;
    }
  }
  return Object.fromEntries(Object.entries(map).map(([code, entry]) => [code, {
    available: entry.rows > 0,
    rows: entry.rows,
    projectedStarters: entry.projectedStarters,
    offensiveLineStarters: entry.offensiveLineStarters,
    schemaValidated: entry.schema.some((name) => ["team", "club_code"].includes(name)) && entry.schema.some((name) => ["player_name", "full_name", "football_name"].includes(name)),
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
