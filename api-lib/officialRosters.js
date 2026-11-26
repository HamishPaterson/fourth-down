// Checks players against each team's official roster (data/nflverse-rosters-<season>.js) and
// the reported roster changes, so stale feed entries (retired, released, traded players) drop out.
import OFFICIAL_ROSTERS from "../data/nflverse-rosters-2026.js";
import { nameKey } from "../src/services/fourthDownRatings.js";
import { reportedDeparture } from "../src/services/rosterChanges.js";

const UNAVAILABLE = new Set(["RES", "INA", "SUS", "PUP", "NFI", "EXE"]);

export function rosterIndex(rosters = OFFICIAL_ROSTERS) {
  const teams = new Map();
  for (const [team, players] of Object.entries(rosters?.teams || {})) {
    const index = { sleeper: new Map(), gsis: new Map(), pfr: new Map(), name: new Map() };
    for (const player of players) {
      if (player.sleeperId) index.sleeper.set(String(player.sleeperId), player);
      if (player.gsisId) index.gsis.set(String(player.gsisId), player);
      if (player.pfrId) index.pfr.set(String(player.pfrId), player);
      const key = nameKey(player.name);
      if (key) index.name.set(key, index.name.has(key) ? null : player); // ambiguous names never match
    }
    teams.set(team, index);
  }
  return { week: rosters?.week ?? null, teams };
}

const DEFAULT_INDEX = rosterIndex();

// The official entry for this player at this team; undefined when no official roster is loaded
// for the team (nothing can be checked), null when he is not on it.
export function officialEntry(team, player, index = DEFAULT_INDEX) {
  const roster = index.teams.get(String(team || "").toUpperCase());
  if (!roster) return undefined;
  const sleeper = player?.sleeperId ?? player?.playerId ?? player?.id;
  const gsis = player?.gsisId ?? player?.gsis_id;
  return (sleeper != null && roster.sleeper.get(String(sleeper))) || (gsis && roster.gsis.get(String(gsis))) ||
    (player?.pfrId && roster.pfr.get(String(player.pfrId))) ||
    roster.name.get(nameKey(player?.fullName || player?.full_name || player?.name)) || null;
}

// Whether a player still belongs to the team: on its official roster and not reported gone.
export function onTeam(team, player, index = DEFAULT_INDEX) {
  if (reportedDeparture(team, player)) return false;
  return officialEntry(team, player, index) !== null;
}

export function officiallyUnavailable(entry) {
  return Boolean(entry && UNAVAILABLE.has(entry.status));
}
