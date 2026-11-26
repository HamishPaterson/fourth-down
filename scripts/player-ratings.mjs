import path from "node:path";
import { pathToFileURL } from "node:url";
import { UNITS, nameKey, teamUnitRatings, unitForPosition } from "../src/services/fourthDownRatings.js";
import { STARTER_SHARE, individualPerformance } from "./fit-absence-values.mjs";

const EMPTY_STATS = { dropbacks: 0, dropbackEpa: 0, carries: 0, rushEpa: 0, rushSuccess: 0, targets: 0, targetEpa: 0,
  sacks: 0, hits: 0, tfl: 0, forcedFumbles: 0, tackles: 0, ints: 0, passesDefended: 0 };

export { UNITS, nameKey, teamUnitRatings, unitForPosition };

// Fourth Down player ratings, built from real NFLverse play-by-play and snap counts.
//
// For each prediction week, only games before that week count. Each player has:
//   - a prior: last season's final EA rating (or replacement level for anyone EA lacked),
//   - a 2026 performance score for their unit, measured per play or per snap and expressed
//     on the same scale as the prior (league starters' mean and spread for that unit),
// and the rating moves from the prior to the performance score as their sample builds:
//   rating = prior + (performance - prior) * n / (n + K)
// Starters are chosen by snap share over each team's last three games, not depth charts.
// Offensive linemen have no individual public measures, so each lineman's performance is
// his team's measured pass protection and run blocking.

const OFFENCE = new Set(["qb", "rb", "wr", "te", "ol"]);
const CANDIDATES_KEPT = 4; // spare players per unit, so injured starters can be replaced
const MAX_Z = 3;

const teamCode = (value) => ({ WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" })[String(value || "").trim().toUpperCase()] ||
  String(value || "").trim().toUpperCase();
const n = (value) => { if (value === undefined || value === "" || value === "NA") return null; const x = Number(value); return Number.isFinite(x) ? x : null; };
const flag = (value) => n(value) === 1;
const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;



// EA rating from the end of last season, by name and position unit (team breaks ties).
export function buildPriorIndex(eaRecords) {
  const index = new Map();
  const eaUnit = (label) => ({ HB: "rb", FB: "rb", QB: "qb", WR: "wr", TE: "te", LT: "ol", LG: "ol", C: "ol", RG: "ol", RT: "ol",
    LEDG: "front", REDG: "front", LE: "front", RE: "front", DT: "front", MIKE: "lb", WILL: "lb", SAM: "lb", MLB: "lb",
    LOLB: "lb", ROLB: "lb", CB: "db", FS: "db", SS: "db" })[String(label || "").toUpperCase()] || null;
  for (const record of eaRecords || []) {
    const unit = eaUnit(record.position?.shortLabel || record.position?.label || record.position);
    const rating = n(record.overallRating);
    const key = nameKey(`${record.firstName} ${record.lastName}`);
    if (!unit || rating === null || !key) continue;
    const list = index.get(key) || [];
    list.push({ unit, rating, team: String(record.team?.label || "") });
    index.set(key, list);
  }
  return index;
}

function priorFor(index, name, unit) {
  const matches = (index.get(nameKey(name)) || []);
  const sameUnit = matches.filter((match) => match.unit === unit);
  // Edge rushers move between DE and OLB labels, so accept the other front-seven unit.
  const near = sameUnit.length ? sameUnit : matches.filter((match) =>
    (unit === "front" && match.unit === "lb") || (unit === "lb" && match.unit === "front"));
  return near.length === 1 ? near[0].rating : null;
}

// Per-player production from plays before the prediction week.
function production(plays) {
  const players = new Map();
  const teams = new Map();
  const get = (id) => { if (!players.has(id)) players.set(id, { dropbacks: 0, dropbackEpa: 0, carries: 0, rushEpa: 0, rushSuccess: 0,
    targets: 0, targetEpa: 0, sacks: 0, hits: 0, tfl: 0, forcedFumbles: 0, tackles: 0, ints: 0, passesDefended: 0 }); return players.get(id); };
  const team = (code) => { if (!teams.has(code)) teams.set(code, { dropbacks: 0, sacksAllowed: 0, hitsAllowed: 0, designedRuns: 0,
    runEpa: 0, runSuccess: 0, passEpaAllowed: 0, dropbacksFaced: 0 }); return teams.get(code); };
  for (const play of plays) {
    const epa = n(play.epa);
    if (epa === null) continue;
    const offence = teamCode(play.posteam), defence = teamCode(play.defteam);
    const dropback = flag(play.qb_dropback), scramble = flag(play.qb_scramble);
    if (dropback) {
      const qb = play.passer_player_id || (scramble ? play.rusher_player_id : "");
      if (qb && qb !== "NA") { const p = get(qb); p.dropbacks++; p.dropbackEpa += epa; }
      const t = team(offence); t.dropbacks++; if (flag(play.sack)) t.sacksAllowed++; if (flag(play.qb_hit)) t.hitsAllowed++;
      const d = team(defence); d.dropbacksFaced++; d.passEpaAllowed += epa;
    }
    if (play.receiver_player_id && play.receiver_player_id !== "NA" && flag(play.pass_attempt)) {
      const p = get(play.receiver_player_id); p.targets++; p.targetEpa += epa;
    }
    if (!dropback && flag(play.rush_attempt) && play.rusher_player_id && play.rusher_player_id !== "NA") {
      const p = get(play.rusher_player_id); p.carries++; p.rushEpa += epa; if (flag(play.success)) p.rushSuccess++;
      const t = team(offence); t.designedRuns++; t.runEpa += epa; if (flag(play.success)) t.runSuccess++;
    }
    const credit = (field, weight, ...ids) => { for (const id of ids) if (id && id !== "NA") get(id)[field] += weight; };
    credit("sacks", 1, play.sack_player_id);
    credit("sacks", 0.5, play.half_sack_1_player_id, play.half_sack_2_player_id);
    credit("hits", 1, play.qb_hit_1_player_id, play.qb_hit_2_player_id);
    credit("tfl", 1, play.tackle_for_loss_1_player_id, play.tackle_for_loss_2_player_id);
    credit("forcedFumbles", 1, play.forced_fumble_player_1_player_id, play.forced_fumble_player_2_player_id);
    credit("tackles", 1, play.solo_tackle_1_player_id, play.solo_tackle_2_player_id, play.tackle_with_assist_1_player_id, play.tackle_with_assist_2_player_id);
    credit("tackles", 0.5, play.assist_tackle_1_player_id, play.assist_tackle_2_player_id, play.assist_tackle_3_player_id, play.assist_tackle_4_player_id);
    credit("ints", 1, play.interception_player_id);
    credit("passesDefended", 1, play.pass_defense_1_player_id, play.pass_defense_2_player_id);
  }
  return { players, teams };
}

// Raw performance per unit: higher is better. Returns { value, sample }.
function rawPerformance(unit, stats, snaps, teamStats, opponentTeamStats) {
  const s = stats || {};
  if (unit === "qb") return { value: s.dropbacks ? s.dropbackEpa / s.dropbacks : 0, sample: s.dropbacks || 0 };
  if (unit === "rb") {
    const plays = (s.carries || 0) + (s.targets || 0);
    return { value: plays ? (s.rushEpa + s.targetEpa) / plays + 0.1 * ((s.carries ? s.rushSuccess / s.carries : 0.4) - 0.4) : 0, sample: plays };
  }
  if (unit === "wr" || unit === "te") return { value: snaps ? (s.targetEpa || 0) / snaps : 0, sample: snaps };
  if (unit === "ol") {
    const t = teamStats || {};
    const pressure = t.dropbacks ? (t.sacksAllowed + 0.5 * t.hitsAllowed) / t.dropbacks : 0.1;
    const run = t.designedRuns ? t.runEpa / t.designedRuns : 0;
    return { value: -pressure + 0.5 * run, sample: snaps };
  }
  const perSnap = (value) => snaps ? value / snaps : 0;
  if (unit === "front") return { value: perSnap((s.sacks || 0) + 0.5 * (s.hits || 0) + 0.5 * (s.tfl || 0) + (s.forcedFumbles || 0)), sample: snaps };
  if (unit === "lb") return { value: perSnap(0.2 * (s.tackles || 0) + (s.tfl || 0) + (s.sacks || 0) + 0.5 * (s.hits || 0) +
    (s.passesDefended || 0) + 2 * (s.ints || 0)), sample: snaps };
  const t = opponentTeamStats || {};
  const coverage = t.dropbacksFaced ? -t.passEpaAllowed / t.dropbacksFaced : 0;
  return { value: perSnap((s.passesDefended || 0) + 2 * (s.ints || 0) + 0.1 * (s.tackles || 0)) + 0.5 * coverage, sample: snaps };
}

// Snap totals before the week, and each player's share over his team's last three games.
function snapUsage(snapRows, week) {
  const byPlayer = new Map(), teamGames = new Map();
  for (const row of snapRows) {
    const rowWeek = n(row.week);
    if (rowWeek === null || rowWeek >= week || String(row.game_type || "REG") !== "REG") continue;
    const unit = unitForPosition(row.position);
    if (!unit) continue;
    const code = teamCode(row.team);
    const games = teamGames.get(code) || new Set(); games.add(rowWeek); teamGames.set(code, games);
    const id = row.pfr_player_id;
    const entry = byPlayer.get(id) || { pfrId: id, name: row.player, unit, team: code, lastWeek: 0, snaps: 0, byWeek: new Map() };
    const share = OFFENCE.has(unit) ? n(row.offense_pct) : n(row.defense_pct);
    const count = OFFENCE.has(unit) ? n(row.offense_snaps) : n(row.defense_snaps);
    entry.snaps += count || 0;
    entry.byWeek.set(rowWeek, Math.max(entry.byWeek.get(rowWeek) || 0, share || 0));
    if (rowWeek >= entry.lastWeek) { entry.lastWeek = rowWeek; entry.team = code; entry.unit = unit; entry.name = row.player; }
    byPlayer.set(id, entry);
  }
  for (const entry of byPlayer.values()) {
    const recent = [...(teamGames.get(entry.team) || [])].sort((a, b) => b - a).slice(0, 3);
    entry.recentShare = recent.length ? recent.reduce((sum, w) => sum + (entry.byWeek.get(w) || 0), 0) / recent.length : 0;
  }
  return byPlayer;
}

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const sd = (values) => { const m = mean(values); return Math.sqrt(mean(values.map((v) => (v - m) ** 2))) || 1; };

export function buildWeekRatings({ plays, snapRows, pfrToGsis, priors, week }) {
  const before = plays.filter((play) => n(play.week) < week && String(play.season_type || "REG") === "REG");
  const { players, teams } = production(before);
  const usage = snapUsage(snapRows, week);
  const rows = [];
  for (const entry of usage.values()) {
    const gsisId = pfrToGsis.get(entry.pfrId) || null;
    const opponentStats = teams.get(entry.team);
    const raw = rawPerformance(entry.unit, gsisId ? players.get(gsisId) : null, entry.snaps, teams.get(entry.team), opponentStats);
    const individual = individualPerformance(entry.unit, { ...EMPTY_STATS, ...(gsisId ? players.get(gsisId) : {}) }, entry.snaps);
    rows.push({ ...entry, gsisId, raw, individual, prior: priorFor(priors, entry.name, entry.unit) });
  }
  // Quality on exactly the scale the absence costs were fitted on (scripts/fit-absence-values.mjs):
  // standard deviations from this season's regular starters at the unit, shrunk for sample.
  const qualityScale = {};
  for (const unit of Object.keys(UNITS)) {
    const values = rows.filter((row) => row.unit === unit && row.individual && row.recentShare >= STARTER_SHARE[unit] &&
      row.individual.sample >= UNITS[unit].sample / 2).map((row) => row.individual.value);
    qualityScale[unit] = { mean: mean(values), sd: sd(values) };
  }
  const qualityOf = (row) => {
    if (!row.individual) return null;
    const { mean: m, sd: s } = qualityScale[row.unit];
    const z = Math.max(-MAX_Z, Math.min(MAX_Z, (row.individual.value - m) / s));
    return round(z * row.individual.sample / (row.individual.sample + UNITS[row.unit].sample), 2);
  };
  // Each unit's performance is placed on the scale of its regular starters' EA ratings.
  const scale = {};
  for (const unit of Object.keys(UNITS)) {
    const regulars = rows.filter((row) => row.unit === unit && row.recentShare >= 0.5 && row.raw.sample >= UNITS[unit].sample / 2);
    const priorsOfRegulars = regulars.map((row) => row.prior).filter((value) => value !== null);
    scale[unit] = { rawMean: mean(regulars.map((row) => row.raw.value)), rawSd: sd(regulars.map((row) => row.raw.value)),
      ratingMean: priorsOfRegulars.length ? mean(priorsOfRegulars) : 74, ratingSd: priorsOfRegulars.length > 2 ? sd(priorsOfRegulars) : 7 };
  }
  const teamsOut = {};
  for (const row of rows) {
    const unit = UNITS[row.unit], s = scale[row.unit];
    const z = Math.max(-MAX_Z, Math.min(MAX_Z, (row.raw.value - s.rawMean) / s.rawSd));
    const performance = s.ratingMean + z * s.ratingSd;
    const prior = row.prior ?? unit.replacement;
    const weight = row.raw.sample / (row.raw.sample + unit.sample);
    const rating = Math.max(40, Math.min(99, prior + (performance - prior) * weight));
    const list = ((teamsOut[row.team] ||= {})[row.unit] ||= []);
    list.push({ gsisId: row.gsisId, pfrId: row.pfrId, name: row.name, rating: round(rating), prior: row.prior,
      performance: round(performance), sample: row.raw.sample, recentShare: round(row.recentShare, 2), quality: qualityOf(row) });
  }
  for (const units of Object.values(teamsOut)) {
    for (const [unit, list] of Object.entries(units)) {
      list.sort((a, b) => b.recentShare - a.recentShare || b.rating - a.rating);
      units[unit] = list.filter((player) => player.recentShare > 0).slice(0, UNITS[unit].places + CANDIDATES_KEPT);
    }
  }
  return { week, teams: teamsOut, scale: Object.fromEntries(Object.entries(scale).map(([unit, s]) =>
    [unit, { ratingMean: round(s.ratingMean), ratingSd: round(s.ratingSd) }])) };
}


// ---- Weekly artifact ---------------------------------------------------------------------
//   node scripts/player-ratings.mjs <season> <predictionWeek>
// Writes data/player-ratings-<season>.js from NFLverse play-by-play, snap counts and player IDs.
export const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";

export function validateRatingsArtifact(artifact, { season, week }) {
  const problems = [];
  if (artifact.season !== season) problems.push("season");
  if (artifact.predictionWeek !== week) problems.push("prediction week");
  if (artifact.latestCompletedWeek !== week - 1) problems.push(`play-by-play ends at Week ${artifact.latestCompletedWeek}`);
  const teams = Object.keys(artifact.teams || {});
  if (teams.length !== 32) problems.push(`${teams.length} teams`);
  for (const code of teams) {
    const { coverage } = teamUnitRatings(artifact.teams[code]);
    if (coverage < 0.9) problems.push(`${code} covers ${Math.round(coverage * 100)}% of unit places`);
    for (const list of Object.values(artifact.teams[code])) {
      if (list.some((player) => !(player.rating >= 40 && player.rating <= 99))) problems.push(`${code} rating out of range`);
    }
  }
  return problems;
}

// departedFrom(team, player) is true when the official roster no longer lists him at the team.
export function buildRatingsArtifact({ plays, snapRows, players, eaRecords, season, week, now = new Date(), departedFrom = () => false }) {
  const regular = plays.filter((play) => Number(play.season) === season && String(play.season_type) === "REG");
  const latestCompletedWeek = Math.max(0, ...regular.map((play) => n(play.week)).filter((value) => value !== null && value < week));
  const pfrToGsis = new Map(players.filter((row) => row.pfr_id && row.gsis_id).map((row) => [row.pfr_id, row.gsis_id]));
  const built = buildWeekRatings({ plays: regular, snapRows: snapRows.filter((row) => Number(row.season) === season),
    pfrToGsis, priors: buildPriorIndex(eaRecords), week });
  const teams = Object.fromEntries(Object.entries(built.teams).sort(([a], [b]) => a.localeCompare(b)).map(([code, units]) =>
    [code, Object.fromEntries(Object.entries(units).map(([unit, list]) => [unit, list.map((player) => ({
      gsisId: player.gsisId, name: player.name, rating: player.rating, share: player.recentShare, quality: player.quality,
      ...(unit === "qb" ? { dropbacks: player.sample } : {}),
      ...(departedFrom(code, { gsisId: player.gsisId, pfrId: player.pfrId, name: player.name }) ? { departed: true } : {}) }))]))]));
  return { schemaVersion: 1, season, predictionWeek: week, latestCompletedWeek, generatedAt: now.toISOString(),
    source: "NFLverse play-by-play and snap counts; prior is last season's final EA rating", scale: built.scale, teams };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { gunzipSync } = await import("node:zlib");
  const { readFile, writeFile, rename } = await import("node:fs/promises");
  const { parseGenericCsv } = await import("./update-nflverse.mjs");
  const season = Number(process.argv[2]), week = Number(process.argv[3]);
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 2 || week > 18) throw new Error("Usage: player-ratings.mjs <season> <week>");
  const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Required dataset unavailable: ${url} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return parseGenericCsv((url.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  };
  const [plays, snapRows, players] = await Promise.all([download(`${RELEASE}/pbp/play_by_play_${season}.csv.gz`),
    download(`${RELEASE}/snap_counts/snap_counts_${season}.csv`), download(`${RELEASE}/players/players.csv`)]);
  const eaRecords = JSON.parse(await readFile("api/nfl/ea_player_records.json", "utf8"));
  // Run scripts/update-rosters.mjs first so the official roster is current.
  const { officialEntry } = await import("../api-lib/officialRosters.js");
  const artifact = buildRatingsArtifact({ plays, snapRows, players, eaRecords, season, week,
    departedFrom: (team, player) => officialEntry(team, player) === null });
  const problems = validateRatingsArtifact(artifact, { season, week });
  if (problems.length) throw new Error(`Week ${week} player ratings not ready: ${problems.join(", ")}`);
  const destination = `data/player-ratings-${season}.js`, temporary = `${destination}.tmp`;
  await writeFile(temporary, `// Generated by scripts/player-ratings.mjs. Do not edit by hand.\nexport default ${JSON.stringify(artifact)};\n`);
  await rename(temporary, destination);
  console.log(`Wrote ${destination}: Week ${week} ratings from games through Week ${artifact.latestCompletedWeek}`);
}
