const ALIASES = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
const GROUPS = {
  QB: ["QB"], RB: ["RB", "FB"], WR: ["WR"], TE: ["TE"],
  OL: ["LT", "LG", "C", "RG", "RT", "OL", "OT", "OG", "G", "T"],
  front: ["LDE", "RDE", "LDT", "RDT", "DE", "DT", "NT", "EDGE"],
  LB: ["WLB", "MLB", "SLB", "LILB", "RILB", "LB", "ILB", "OLB"],
  DB: ["LCB", "RCB", "SS", "FS", "NB", "CB", "DB", "S"],
};
const ABSENCE = { Out: 1, IR: 1, Inactive: 1, PUP: 1, Suspended: 1, Doubtful: .75, Questionable: .25, Probable: .08 };
export const DEPTH_SCHEMA_VERSION = 2;
const team = (value) => ALIASES[String(value || "").trim().toUpperCase()] || String(value || "").trim().toUpperCase();
const timestamp = (value) => typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function depthAvailability(row) {
  const rosterStatus = String(row.roster_status || "").trim().toLowerCase();
  const value = String(row.injury_status || row.status || row.roster_status || "").trim().toLowerCase();
  const status = rosterStatus === "ir" || rosterStatus.includes("injured reserve") ? "IR"
    : rosterStatus.includes("inactive") ? "Inactive"
      : value === "ir" || value.includes("injured reserve") ? "IR"
    : value.includes("inactive") ? "Inactive" : value.includes("doubt") ? "Doubtful"
      : value.includes("question") ? "Questionable" : value.includes("probable") ? "Probable"
        : value === "out" ? "Out" : value.includes("pup") ? "PUP"
          : value.includes("suspend") ? "Suspended" : value === "active" ? "Active" : "Unknown";
  const absenceProbability = ABSENCE[status] ?? 0;
  return { status, absenceProbability, available: absenceProbability < .5, statusKnown: status !== "Unknown" };
}

export function weeklyDepthCutoffs(games, season) {
  const byWeek = new Map();
  for (const game of games) {
    const week = Number(game.week);
    const type = String(game.season_type || game.game_type || "").toUpperCase();
    if (Number(game.season) !== season || !Number.isInteger(week) || week < 1 || week > 18 ||
        [true, 1, "true", "1"].includes(game.postseason) ||
        (type && !["REG", "REGULAR", "REGULAR SEASON", "2"].includes(type))) continue;
    const rows = byWeek.get(week) || [];
    rows.push(timestamp(game.date));
    byWeek.set(week, rows);
  }
  return Object.fromEntries([...byWeek].filter(([, dates]) => dates.every((date) => date !== null))
    .map(([week, dates]) => [week, new Date(Math.min(...dates)).toISOString()]));
}

export function personnelAvailableAt(payload, cutoff) {
  const limit = timestamp(cutoff);
  const observed = timestamp(payload?.sourceAsOf ?? payload?.fetchedAt ?? payload?.refreshedAt ?? payload?.generatedAt);
  return limit !== null && observed !== null && observed <= limit;
}

export function buildDepthMetrics(rows, { season, predictionWeek, cutoff } = {}) {
  const cutoffTime = timestamp(cutoff);
  if (cutoffTime === null || !Number.isInteger(season) || !Number.isInteger(predictionWeek)) return {};
  const eligible = rows.filter((row) => {
    const time = timestamp(row.dt);
    return time !== null && time <= cutoffTime && new Date(time).getUTCFullYear() === season;
  });
  const latestTeam = new Map();
  const latestPlayer = new Map();
  for (const row of eligible) {
    const code = team(row.team || row.club_code);
    const time = timestamp(row.dt);
    latestTeam.set(code, Math.max(latestTeam.get(code) ?? 0, time));
    // ESPN ID survives missing/changing GSIS IDs in this source.
    const id = row.espn_id || row.gsis_id;
    if (!id) continue;
    const previous = latestPlayer.get(id);
    if (!previous || time > previous.time) latestPlayer.set(id, { time, teams: new Set([code]) });
    else if (time === previous.time) previous.teams.add(code);
  }
  const result = {};
  for (const [code, snapshotTime] of latestTeam) {
    const snapshot = eligible.filter((row) => team(row.team || row.club_code) === code && timestamp(row.dt) === snapshotTime);
    const issues = new Set();
    const slots = new Map();
    for (const row of snapshot) {
      const formation = row.pos_grp;
      if (formation === "Special Teams") continue;
      if (!["3WR 1TE", "Base 4-3 D", "Base 3-4 D"].includes(formation)) {
        issues.add("Unsupported personnel group");
        continue;
      }
      const id = row.espn_id || row.gsis_id;
      const rank = Number(row.pos_rank);
      const slot = row.pos_slot;
      const position = String(row.pos_abb || "").toUpperCase();
      const group = Object.keys(GROUPS).find((key) => GROUPS[key].includes(position));
      if (!id || !slot || !Number.isInteger(rank) || rank < 1 || !group) {
        issues.add("Missing player identity, slot, rank or position");
        continue;
      }
      const owner = latestPlayer.get(id);
      if (owner.teams.size !== 1) { issues.add("Ambiguous player team"); continue; }
      if (!owner.teams.has(code)) continue;
      const key = `${formation}:${slot}`;
      const player = {
        playerId: String(id), gsisId: row.gsis_id || null, name: row.player_name || null,
        position, group, formation, slot: String(slot), rank, ...depthAvailability(row),
      };
      const previous = slots.get(key);
      if (!previous || rank < previous.rank) slots.set(key, player);
      else if (rank === previous.rank && JSON.stringify(player) !== JSON.stringify(previous)) issues.add("Conflicting depth slot");
    }
    const declared = [];
    for (const player of slots.values()) {
      const positionSlots = [...slots.values()].filter((candidate) =>
        candidate.formation === player.formation && candidate.position === player.position).length;
      if (player.rank > positionSlots) continue;
      declared.push(player);
    }
    // The source lists a nickel-back and sometimes a fullback alongside its base formations.
    // Preserve those optional roles, but do not label a 12-player base unit as starters.
    const supplemental = declared.filter((player) => player.position === "NB" || player.position === "FB");
    const base = declared.filter((player) => !supplemental.includes(player));
    const unique = new Map();
    for (const player of base) {
      if (unique.has(player.playerId)) issues.add("Player occupies multiple base slots");
      unique.set(player.playerId, player);
    }
    const players = [...unique.values()];
    const counts = Object.fromEntries(Object.keys(GROUPS).map((key) => [
      key, players.filter((player) => player.group === key && player.available).length,
    ]));
    const offense = ["QB", "RB", "WR", "TE", "OL"].reduce((sum, key) => sum + counts[key], 0);
    const defense = ["front", "LB", "DB"].reduce((sum, key) => sum + counts[key], 0);
    const declaredOffense = players.filter((player) => ["QB", "RB", "WR", "TE", "OL"].includes(player.group)).length;
    if (declaredOffense > 11 || players.length - declaredOffense > 11 ||
        players.filter((player) => player.group === "QB").length > 1 ||
        players.filter((player) => player.group === "OL").length > 5) issues.add("Impossible base-unit counts");
    const quarterbacks = players.filter((player) => player.group === "QB");
    const entry = {
      schemaVersion: DEPTH_SCHEMA_VERSION, season, predictionWeek, cutoff,
      snapshotAt: new Date(snapshotTime).toISOString(),
      available: players.length > 0 && issues.size === 0, schemaValidated: issues.size === 0,
      rows: snapshot.length, players, supplemental, positionCounts: counts,
      offensiveStarters: offense, defensiveStarters: defense,
      projectedStarters: offense + defense, offensiveLineStarters: counts.OL,
      startingQuarterback: quarterbacks.length === 1 ? quarterbacks[0] : null,
      issues: [...issues],
    };
    result[code] = entry;
  }
  return result;
}

export function validDepthLineup(lineup, week, season) {
  if (!lineup?.available || !lineup.schemaValidated || lineup.schemaVersion !== DEPTH_SCHEMA_VERSION ||
      lineup.predictionWeek !== Number(week) || (season != null && lineup.season !== Number(season)) ||
      timestamp(lineup.snapshotAt) === null || timestamp(lineup.cutoff) === null ||
      Date.parse(lineup.snapshotAt) > Date.parse(lineup.cutoff) ||
      !Array.isArray(lineup.players) || !lineup.players.length || lineup.issues?.length) return false;
  const ids = new Set();
  const slots = new Set();
  const counts = Object.fromEntries(Object.keys(GROUPS).map((group) => [group, 0]));
  for (const player of lineup.players) {
    if (!player.playerId || ids.has(player.playerId) || !(player.group in counts) ||
        !GROUPS[player.group].includes(player.position) ||
        typeof player.available !== "boolean" || !Number.isInteger(player.rank) || player.rank < 1 ||
        !player.slot || slots.has(`${player.formation}:${player.slot}`)) return false;
    ids.add(player.playerId);
    slots.add(`${player.formation}:${player.slot}`);
    if (player.available) counts[player.group] += 1;
  }
  const offense = ["QB", "RB", "WR", "TE", "OL"].reduce((sum, key) => sum + counts[key], 0);
  const defense = ["front", "LB", "DB"].reduce((sum, key) => sum + counts[key], 0);
  const declaredOffense = lineup.players.filter((player) => ["QB", "RB", "WR", "TE", "OL"].includes(player.group)).length;
  return declaredOffense <= 11 && lineup.players.length - declaredOffense <= 11 &&
    lineup.players.filter((player) => player.group === "QB").length <= 1 &&
    lineup.players.filter((player) => player.group === "OL").length <= 5 &&
    lineup.offensiveStarters === offense && lineup.defensiveStarters === defense &&
    lineup.projectedStarters === offense + defense && lineup.offensiveLineStarters === counts.OL &&
    Object.keys(counts).every((key) => lineup.positionCounts?.[key] === counts[key]);
}
