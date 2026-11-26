// Measures what losing a starter costs, by position and by how well he was playing, from
// every regular-season game of past seasons (with-or-without analysis).
//   node scripts/fit-absence-values.mjs <data dir> <players.csv> [first season] [last season]
// The data dir holds NFLverse play_by_play_<season>.csv.gz, snap_counts_<season>.csv and
// nfldata games.csv.
//
// For each team and game:
//   - regular starters are players averaging 60%+ of the team's snaps over its previous four
//     games (at least two), as the ratings choose starters;
//   - a starter is absent if he plays under 15% of the snaps and has not moved to another team;
//   - his quality is how well he had played for the team before that game, measured as in the
//     Fourth Down ratings, as standard deviations from that season's regulars at his unit,
//     shrunk towards average for small samples. Offensive linemen have no individual measure.
// The margin of each game is then modelled as home field + each team's strength that season
// (fitted for every team-season) - the cost of each side's absences, where an absence costs
// a(unit) + b(unit) x quality. Fitting team strength stops a weak team's injuries looking
// like the cause of its losses.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { STARTER_SHARE, UNITS, unitForPosition } from "../src/services/fourthDownRatings.js";

export { STARTER_SHARE };

export const ABSENCE_UNITS = Object.keys(UNITS);
const OFFENCE = new Set(["qb", "rb", "wr", "te", "ol"]);
const ABSENT_SHARE = 0.15, PRIOR_GAMES = 4;
// Quality slopes can be shared within these groups, which steadies thin positions.
export const QUALITY_GROUPS = { qb: "qb", rb: "skill", wr: "skill", te: "skill", front: "defence", lb: "defence", db: "defence" };
const teamCode = (value) => ({ WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" })[String(value || "").toUpperCase()] ||
  String(value || "").toUpperCase();

function parseLine(line) {
  const values = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { values.push(value); value = ""; }
    else value += c;
  }
  values.push(value);
  return values;
}

// Keeps only the named columns, so a full play-by-play season fits in memory.
export function parseColumns(text, columns) {
  const lines = text.split(/\r?\n/);
  const header = parseLine(lines.shift() || "");
  const index = columns.map((column) => header.indexOf(column));
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const values = parseLine(line);
    const row = {};
    columns.forEach((column, i) => { row[column] = index[i] >= 0 ? values[index[i]] : ""; });
    rows.push(row);
  }
  return rows;
}

const PBP_COLUMNS = ["game_id", "season_type", "week", "posteam", "defteam", "epa", "qb_dropback", "qb_scramble", "passer_player_id",
  "rusher_player_id", "receiver_player_id", "pass_attempt", "rush_attempt", "success", "sack_player_id", "half_sack_1_player_id",
  "half_sack_2_player_id", "qb_hit_1_player_id", "qb_hit_2_player_id", "tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id",
  "forced_fumble_player_1_player_id", "forced_fumble_player_2_player_id", "solo_tackle_1_player_id", "solo_tackle_2_player_id",
  "tackle_with_assist_1_player_id", "tackle_with_assist_2_player_id", "assist_tackle_1_player_id", "assist_tackle_2_player_id",
  "interception_player_id", "pass_defense_1_player_id", "pass_defense_2_player_id"];
const num = (value) => { const x = Number(value); return value === "" || value === "NA" || !Number.isFinite(x) ? null : x; };
const id = (value) => value && value !== "NA" ? value : null;

function emptyStats() {
  return { dropbacks: 0, dropbackEpa: 0, carries: 0, rushEpa: 0, rushSuccess: 0, targets: 0, targetEpa: 0,
    sacks: 0, hits: 0, tfl: 0, forcedFumbles: 0, tackles: 0, ints: 0, passesDefended: 0 };
}

// Per player, per game production (keyed gsis id -> game id -> stats).
function gameProduction(plays) {
  const byPlayer = new Map();
  const get = (player, game) => {
    if (!byPlayer.has(player)) byPlayer.set(player, new Map());
    const games = byPlayer.get(player);
    if (!games.has(game)) games.set(game, emptyStats());
    return games.get(game);
  };
  for (const play of plays) {
    if (play.season_type !== "REG") continue;
    const epa = num(play.epa);
    if (epa === null) continue;
    const game = play.game_id;
    if (play.qb_dropback === "1") {
      const qb = id(play.passer_player_id) || (play.qb_scramble === "1" ? id(play.rusher_player_id) : null);
      if (qb) { const s = get(qb, game); s.dropbacks++; s.dropbackEpa += epa; }
    }
    if (id(play.receiver_player_id) && play.pass_attempt === "1") { const s = get(play.receiver_player_id, game); s.targets++; s.targetEpa += epa; }
    if (play.qb_dropback !== "1" && play.rush_attempt === "1" && id(play.rusher_player_id)) {
      const s = get(play.rusher_player_id, game); s.carries++; s.rushEpa += epa; if (play.success === "1") s.rushSuccess++;
    }
    const credit = (field, weight, ...ids) => { for (const player of ids) if (id(player)) get(player, game)[field] += weight; };
    credit("sacks", 1, play.sack_player_id);
    credit("sacks", 0.5, play.half_sack_1_player_id, play.half_sack_2_player_id);
    credit("hits", 1, play.qb_hit_1_player_id, play.qb_hit_2_player_id);
    credit("tfl", 1, play.tackle_for_loss_1_player_id, play.tackle_for_loss_2_player_id);
    credit("forcedFumbles", 1, play.forced_fumble_player_1_player_id, play.forced_fumble_player_2_player_id);
    credit("tackles", 1, play.solo_tackle_1_player_id, play.solo_tackle_2_player_id, play.tackle_with_assist_1_player_id, play.tackle_with_assist_2_player_id);
    credit("tackles", 0.5, play.assist_tackle_1_player_id, play.assist_tackle_2_player_id);
    credit("ints", 1, play.interception_player_id);
    credit("passesDefended", 1, play.pass_defense_1_player_id, play.pass_defense_2_player_id);
  }
  return byPlayer;
}

// Individual performance, as in scripts/player-ratings.mjs (team-level parts left out, since
// team strength is fitted separately). Returns null where no individual measure exists.
export function individualPerformance(unit, s, snaps) {
  if (unit === "ol") return null;
  if (unit === "qb") return s.dropbacks ? { value: s.dropbackEpa / s.dropbacks, sample: s.dropbacks } : null;
  if (unit === "rb") {
    const plays = s.carries + s.targets;
    return plays ? { value: (s.rushEpa + s.targetEpa) / plays + 0.1 * ((s.carries ? s.rushSuccess / s.carries : 0.4) - 0.4), sample: plays } : null;
  }
  if (!snaps) return null;
  if (unit === "wr" || unit === "te") return { value: s.targetEpa / snaps, sample: snaps };
  if (unit === "front") return { value: (s.sacks + 0.5 * s.hits + 0.5 * s.tfl + s.forcedFumbles) / snaps, sample: snaps };
  if (unit === "lb") return { value: (0.2 * s.tackles + s.tfl + s.sacks + 0.5 * s.hits + s.passesDefended + 2 * s.ints) / snaps, sample: snaps };
  return { value: (s.passesDefended + 2 * s.ints + 0.1 * s.tackles) / snaps, sample: snaps };
}

const addStats = (total, s) => { for (const key of Object.keys(total)) total[key] += s[key]; return total; };

export function seasonAbsences({ games, snapRows, plays, pfrToGsis }) {
  const production = gameProduction(plays);
  const regular = games.filter((game) => game.game_type === "REG" && num(game.home_score) !== null && num(game.away_score) !== null)
    .sort((a, b) => Number(a.week) - Number(b.week));
  const snapsByGameTeam = new Map(), teamByWeekPlayer = new Map();
  for (const row of snapRows) {
    if (row.game_type && row.game_type !== "REG") continue;
    const unit = unitForPosition(row.position);
    if (!unit) continue;
    const team = teamCode(row.team), key = `${row.game_id}|${team}`;
    const share = OFFENCE.has(unit) ? num(row.offense_pct) : num(row.defense_pct);
    const count = OFFENCE.has(unit) ? num(row.offense_snaps) : num(row.defense_snaps);
    if (!snapsByGameTeam.has(key)) snapsByGameTeam.set(key, new Map());
    snapsByGameTeam.get(key).set(row.pfr_player_id, { unit, share: share > 1 ? share / 100 : share || 0, snaps: count || 0, name: row.player });
    teamByWeekPlayer.set(`${row.week}|${row.pfr_player_id}`, team);
  }
  // Each team's games in order, then every starter's absence and quality.
  const teamGames = new Map();
  for (const game of regular) for (const side of ["home", "away"]) {
    const team = teamCode(game[`${side}_team`]);
    if (!teamGames.has(team)) teamGames.set(team, []);
    teamGames.get(team).push(game);
  }
  const absences = new Map(); // `${game_id}|${team}` -> [{unit, raw, sample, name}]
  const regularsRaw = Object.fromEntries(ABSENCE_UNITS.map((unit) => [unit, []]));
  for (const [team, list] of teamGames) {
    for (let i = 0; i < list.length; i++) {
      const prior = list.slice(Math.max(0, i - PRIOR_GAMES), i);
      if (prior.length < 2) continue;
      const shares = new Map();
      for (const game of prior) for (const [pfr, row] of snapsByGameTeam.get(`${game.game_id}|${team}`) || []) {
        const entry = shares.get(pfr) || { total: 0, unit: row.unit, name: row.name };
        entry.total += row.share; entry.unit = row.unit; shares.set(pfr, entry);
      }
      const current = snapsByGameTeam.get(`${list[i].game_id}|${team}`) || new Map();
      const missing = [];
      for (const [pfr, entry] of shares) {
        if (entry.total / prior.length < STARTER_SHARE[entry.unit]) continue;
        // Quality from everything he had done for this team before the game.
        const gsis = pfrToGsis.get(pfr);
        const stats = emptyStats();
        let snaps = 0;
        for (const game of list.slice(0, i)) {
          const row = snapsByGameTeam.get(`${game.game_id}|${team}`)?.get(pfr);
          if (row) snaps += row.snaps;
          const s = gsis && production.get(gsis)?.get(game.game_id);
          if (s) addStats(stats, s);
        }
        const performance = individualPerformance(entry.unit, stats, snaps);
        if (performance && performance.sample >= UNITS[entry.unit].sample / 2) regularsRaw[entry.unit].push(performance.value);
        const playing = current.get(pfr);
        const moved = teamByWeekPlayer.get(`${list[i].week}|${pfr}`) && teamByWeekPlayer.get(`${list[i].week}|${pfr}`) !== team;
        if ((!playing || playing.share < ABSENT_SHARE) && !moved) missing.push({ unit: entry.unit, name: entry.name, performance });
      }
      absences.set(`${list[i].game_id}|${team}`, missing);
    }
  }
  // Quality in standard deviations from the season's regulars at the unit, shrunk for sample.
  const scale = Object.fromEntries(Object.entries(regularsRaw).map(([unit, values]) => {
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length || 1)) || 1;
    return [unit, { mean, sd }];
  }));
  const quality = (player) => {
    if (!player.performance) return 0;
    const { mean, sd } = scale[player.unit];
    const z = Math.max(-3, Math.min(3, (player.performance.value - mean) / sd));
    return z * player.performance.sample / (player.performance.sample + UNITS[player.unit].sample);
  };
  return regular.map((game) => {
    const side = (team) => {
      const list = absences.get(`${game.game_id}|${teamCode(team)}`);
      return list ? list.map((player) => ({ unit: player.unit, name: player.name, quality: quality(player) })) : null;
    };
    return { gameId: game.game_id, season: Number(game.season), week: Number(game.week), home: teamCode(game.home_team),
      away: teamCode(game.away_team), neutral: game.location === "Neutral", margin: num(game.home_score) - num(game.away_score),
      homeAbsent: side(game.home_team), awayAbsent: side(game.away_team) };
  }).filter((game) => game.homeAbsent && game.awayAbsent);
}

// ---- Model fit ----------------------------------------------------------------------------
function invert(matrix) {
  const n = matrix.length, M = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    const p = M[i][i];
    for (let j = 0; j < 2 * n; j++) M[i][j] /= p;
    for (let k = 0; k < n; k++) {
      if (k === i || !M[k][i]) continue;
      const f = M[k][i];
      for (let j = 0; j < 2 * n; j++) M[k][j] -= f * M[i][j];
    }
  }
  return M.map((row) => row.slice(n));
}

export function designRows(games, { withAbsences = true, grouped = false } = {}) {
  const teamIndex = new Map();
  for (const game of games) for (const team of [game.home, game.away]) {
    const key = `${game.season}|${team}`;
    if (!teamIndex.has(key)) teamIndex.set(key, teamIndex.size);
  }
  const qualityColumn = (unit) => `${grouped ? QUALITY_GROUPS[unit] : unit}:quality`;
  const absenceColumns = withAbsences ? [...ABSENCE_UNITS.map((unit) => `${unit}:starter`),
    ...new Set(ABSENCE_UNITS.filter((unit) => unit !== "ol").map(qualityColumn))] : [];
  const columns = ["homeField", ...absenceColumns, ...[...teamIndex.keys()].map((key) => `team:${key}`)];
  const rows = games.map((game) => {
    const x = new Array(columns.length).fill(0);
    x[0] = game.neutral ? 0 : 1;
    if (withAbsences) {
      // Positive coefficient = points lost per absence, so absences enter negatively for their side.
      for (const [list, sign] of [[game.homeAbsent, -1], [game.awayAbsent, 1]]) for (const player of list) {
        x[columns.indexOf(`${player.unit}:starter`)] += sign;
        if (player.unit !== "ol") x[columns.indexOf(qualityColumn(player.unit))] += sign * player.quality;
      }
    }
    x[columns.indexOf(`team:${game.season}|${game.home}`)] += 1;
    x[columns.indexOf(`team:${game.season}|${game.away}`)] -= 1;
    return { x, y: game.margin, game };
  });
  return { columns, rows };
}

export function fit(rows, columns, { teamPenalty = 0.5 } = {}) {
  const k = columns.length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (const { x, y } of rows) {
    const nonzero = x.map((v, i) => [i, v]).filter(([, v]) => v);
    for (const [i, vi] of nonzero) { b[i] += vi * y; for (const [j, vj] of nonzero) A[i][j] += vi * vj; }
  }
  // A light penalty on team strengths only: it fixes their level and keeps them stable.
  // A column with no data (a unit never absent) is held at zero instead of breaking the solve.
  columns.forEach((column, i) => { A[i][i] += column.startsWith("team:") ? teamPenalty : 1e-6; });
  const inverse = invert(A);
  const beta = inverse.map((row) => row.reduce((sum, v, j) => sum + v * b[j], 0));
  const residuals = rows.map(({ x, y }) => y - x.reduce((sum, v, i) => sum + v * beta[i], 0));
  const sigma2 = residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(1, rows.length - k);
  return { beta, se: inverse.map((row, i) => Math.sqrt(Math.max(0, row[i] * sigma2))), sigma: Math.sqrt(sigma2) };
}

// Error on games the fit has not seen: each (season, week) is held out in turn.
export function heldOutError(games, options) {
  const { columns, rows } = designRows(games, options);
  const folds = [...new Set(games.map((game) => `${game.season}|${game.week}`))];
  let squared = 0, absolute = 0, count = 0;
  for (const fold of folds) {
    const train = rows.filter((row) => `${row.game.season}|${row.game.week}` !== fold);
    const test = rows.filter((row) => `${row.game.season}|${row.game.week}` === fold);
    const { beta } = fit(train, columns);
    for (const { x, y } of test) {
      const error = x.reduce((sum, v, i) => sum + v * beta[i], 0) - y;
      squared += error * error; absolute += Math.abs(error); count++;
    }
  }
  return { rmse: Math.sqrt(squared / count), mae: absolute / count, games: count };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, playersFile, first = "2021", last = "2025"] = process.argv.slice(2);
  const players = parseColumns(fs.readFileSync(playersFile, "utf8"), ["gsis_id", "pfr_id"]);
  const pfrToGsis = new Map(players.filter((row) => row.pfr_id && row.gsis_id).map((row) => [row.pfr_id, row.gsis_id]));
  const gameRows = parseColumns(fs.readFileSync(path.join(dir, "games.csv"), "utf8"),
    ["game_id", "season", "game_type", "week", "away_team", "away_score", "home_team", "home_score", "location"]);
  const all = [];
  for (let season = Number(first); season <= Number(last); season++) {
    const plays = parseColumns(gunzipSync(fs.readFileSync(path.join(dir, `play_by_play_${season}.csv.gz`))).toString("utf8"), PBP_COLUMNS);
    const snapRows = parseColumns(fs.readFileSync(path.join(dir, `snap_counts_${season}.csv`), "utf8"),
      ["game_id", "game_type", "week", "player", "pfr_player_id", "position", "team", "offense_snaps", "offense_pct", "defense_snaps", "defense_pct"]);
    const games = seasonAbsences({ games: gameRows.filter((g) => Number(g.season) === season), snapRows, plays, pfrToGsis });
    const counts = {};
    for (const game of games) for (const p of [...game.homeAbsent, ...game.awayAbsent]) counts[p.unit] = (counts[p.unit] || 0) + 1;
    console.log(`${season}: ${games.length} games, starter absences ${JSON.stringify(counts)}`);
    all.push(...games);
  }
  fs.writeFileSync(path.join(dir, "absences.json"), JSON.stringify(all));
  for (const grouped of [false, true]) {
    const { columns, rows } = designRows(all, { grouped });
    const result = fit(rows, columns);
    console.log(`\n${grouped ? "Quality slopes shared within groups" : "Quality slope per unit"}: ${all.length} games, ` +
      `residual SD ${result.sigma.toFixed(2)}, home field ${result.beta[0].toFixed(2)} (se ${result.se[0].toFixed(2)})`);
    for (const unit of ABSENCE_UNITS) {
      const a = columns.indexOf(`${unit}:starter`), b = columns.indexOf(`${grouped ? QUALITY_GROUPS[unit] : unit}:quality`);
      const line = `${unit.padEnd(6)} average starter ${result.beta[a].toFixed(2)} (se ${result.se[a].toFixed(2)})`;
      console.log(b < 0 ? line : `${line}   per SD of quality ${result.beta[b].toFixed(2)} (se ${result.se[b].toFixed(2)})   ` +
        `elite (+1.5 SD) ${(result.beta[a] + 1.5 * result.beta[b]).toFixed(2)}`);
    }
    if (grouped) {
      const without = heldOutError(all, { withAbsences: false }), withAbs = heldOutError(all, { grouped });
      console.log(`Held-out error, team strength only:     RMSE ${without.rmse.toFixed(3)}  MAE ${without.mae.toFixed(3)}`);
      console.log(`Held-out error, plus measured absences: RMSE ${withAbs.rmse.toFixed(3)}  MAE ${withAbs.mae.toFixed(3)}`);
    }
  }
}
