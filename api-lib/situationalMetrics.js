import { completedPlayerGames, instant, playerTeam } from "./playerMetrics.js";
import { TEAM_NAMES } from "../src/data.js";

export const SITUATIONAL_SCHEMA = 1;
export const THIRD_DOWN_BUCKETS = { short: [1, 3], medium: [4, 6], long: [7, Infinity] };
const REQUIRED = ["season", "season_type", "week", "game_id", "play_id", "posteam", "defteam",
  "play_type", "down", "ydstogo", "third_down_converted", "third_down_failed",
  "fixed_drive", "fixed_drive_result", "yardline_100", "touchdown", "td_team", "penalty"];
const RESULTS = new Set(["Touchdown", "Field goal", "Missed field goal", "Turnover",
  "Turnover on downs", "Punt", "End of half", "Opp touchdown", "Safety"]);
const number = (value) => value === "" || value === null || value === undefined || value === "NA" ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const sample = () => ({ opportunities: 0, conversions: 0, rate: null });
const third = () => ({ ...sample(), buckets: Object.fromEntries(Object.keys(THIRD_DOWN_BUCKETS).map((key) => [key, sample()])) });
const finish = (value) => {
  value.rate = value.opportunities ? value.conversions / value.opportunities : null;
  if (value.buckets) Object.values(value.buckets).forEach(finish);
};
const add = (value, converted) => { value.opportunities++; value.conversions += Number(converted); };

export function auditSituationalFields(rows) {
  return Object.fromEntries([...REQUIRED, "no_play", "game_status", "game_date", "yards_gained", "desc",
    "drive", "drive_result", "drive_end_transition", "drive_ended_with_score"].map((field) => [field, {
    present: Boolean(rows.length && field in rows[0]),
    nonNull: rows.filter((row) => row[field] !== undefined && row[field] !== "" && row[field] !== "NA" && row[field] !== null).length,
    rows: rows.length,
  }]));
}

export function buildWeeklySituationalMetrics(rows, schedule, { season, predictionWeek, cutoff, sourceAsOf }) {
  for (const field of REQUIRED) {
    if (rows.length && !(field in rows[0])) throw new Error(`Situational PBP source missing ${field}`);
  }
  if (instant(sourceAsOf) === null) throw new Error("Situational source observation time missing");
  const games = completedPlayerGames(schedule, season, predictionWeek, cutoff)
    .filter((game) => instant(game.completedAsOf) < instant(cutoff) &&
      instant(game.completedAsOf) <= instant(sourceAsOf) && TEAM_NAMES[game.away] && TEAM_NAMES[game.home]);
  const byKey = new Map(games.map((game) => [game.key, game]));
  const seen = new Map(), identities = new Map(), eligible = [];
  const excluded = { duplicatePlays: 0, mismatchedGames: 0, unresolvedThirdDowns: 0, unresolvedRedZoneDrives: 0 };
  for (const row of rows) {
    const offense = playerTeam(row.posteam), defense = playerTeam(row.defteam);
    const week = number(row.week);
    if (number(row.season) !== season || row.season_type !== "REG" || !week ||
        week >= predictionWeek || !TEAM_NAMES[offense] || !TEAM_NAMES[defense] || offense === defense ||
        !row.game_id || !row.play_id) continue;
    const game = byKey.get(`${season}:${week}:${[offense, defense].sort().join(":")}`);
    if (!game) continue;
    const [idSeason, idWeek, idAway, idHome] = row.game_id.split("_");
    if (number(idSeason) !== season || number(idWeek) !== week ||
        playerTeam(idAway) !== game.away || playerTeam(idHome) !== game.home) {
      excluded.mismatchedGames++;
      continue;
    }
    const identity = identities.get(game.key);
    if (identity && identity !== row.game_id) throw new Error(`Conflicting situational game IDs for ${game.key}`);
    identities.set(game.key, row.game_id);
    const key = `${row.game_id}:${row.play_id}`;
    const previous = seen.get(key);
    if (previous) {
      if ([...REQUIRED, "no_play", "qb_kneel", "qb_spike"].some((field) => previous[field] !== row[field])) {
        throw new Error(`Conflicting situational play ${key}`);
      }
      excluded.duplicatePlays++;
      continue;
    }
    seen.set(key, row);
    eligible.push({ row, offense, defense, game });
  }
  const teams = {};
  for (const code of Object.keys(TEAM_NAMES)) {
    const provenance = games.filter((game) => identities.has(game.key) && [game.away, game.home].includes(code))
      .map((game) => ({ ...game, gameId: identities.get(game.key) }));
    teams[code] = { team: code, schemaVersion: SITUATIONAL_SCHEMA, season, predictionWeek, cutoff, sourceAsOf,
      gameProvenance: provenance, thirdDown: { offense: third(), defense: third() },
      redZone: { offense: sample(), defense: sample() } };
  }
  const drives = new Map();
  for (const entry of eligible) {
    const { row, offense, defense } = entry;
    const validSnap = !["1", "true"].includes(String(row.no_play)) &&
      !["1", "true"].includes(String(row.qb_kneel)) && !["1", "true"].includes(String(row.qb_spike));
    const usable = validSnap && ["run", "pass"].includes(row.play_type);
    if (usable && number(row.down) === 3) {
      const made = number(row.third_down_converted), missed = number(row.third_down_failed);
      if (![0, 1].includes(made) || ![0, 1].includes(missed) || made + missed !== 1) {
        excluded.unresolvedThirdDowns++;
      } else {
        const values = [teams[offense].thirdDown.offense, teams[defense].thirdDown.defense];
        for (const value of values) {
          add(value, made === 1);
          const distance = number(row.ydstogo);
          const bucket = Object.entries(THIRD_DOWN_BUCKETS).find(([, [min, max]]) => distance !== null && distance >= min && distance <= max)?.[0];
          if (bucket) add(value.buckets[bucket], made === 1);
        }
      }
    }
    if (!row.fixed_drive) continue;
    const key = `${row.game_id}:${row.fixed_drive}`;
    const drive = drives.get(key) || { offense, defense, entered: false, results: new Set(), mismatched: false, touchdown: false };
    if (drive.offense !== offense || drive.defense !== defense) drive.mismatched = true;
    const yardline = number(row.yardline_100);
    const scrimmage = validSnap && ["run", "pass", "field_goal", "punt"].includes(row.play_type);
    if (scrimmage && yardline !== null && yardline > 0 && yardline <= 20) drive.entered = true;
    if (row.fixed_drive_result) drive.results.add(row.fixed_drive_result);
    if (usable && number(row.touchdown) === 1 && playerTeam(row.td_team) === offense) drive.touchdown = true;
    drives.set(key, drive);
  }
  for (const drive of drives.values()) {
    if (!drive.entered) continue;
    const result = [...drive.results][0];
    if (drive.mismatched || drive.results.size !== 1 || !RESULTS.has(result) ||
        (result === "Touchdown" && !drive.touchdown) || (drive.touchdown && result !== "Touchdown")) {
      excluded.unresolvedRedZoneDrives++;
      continue;
    }
    add(teams[drive.offense].redZone.offense, result === "Touchdown");
    add(teams[drive.defense].redZone.defense, result === "Touchdown");
  }
  const league = { cutoff, sourceAsOf, maxWeek: games.length ? Math.max(...games.map((game) => game.week)) : null,
    latestCompletion: games.length ? new Date(Math.max(...games.map((game) => instant(game.completedAsOf)))).toISOString() : null };
  for (const key of ["thirdDown", "redZone"]) {
    const total = sample();
    for (const metrics of Object.values(teams)) {
      finish(metrics[key].offense);
      finish(metrics[key].defense);
      total.opportunities += metrics[key].offense.opportunities;
      total.conversions += metrics[key].offense.conversions;
    }
    finish(total);
    league[key] = total;
  }
  for (const metrics of Object.values(teams)) metrics.league = league;
  return { teams, audit: { coverage: auditSituationalFields(rows), eligibleGames: identities.size,
    eligiblePlays: eligible.length, excluded, sourceAsOf, cutoff } };
}
