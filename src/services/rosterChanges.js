// Roster moves reported before the official feeds show them (data/roster-changes.js).
import ROSTER_CHANGES from "../../data/roster-changes.js";
import { nameKey } from "./fourthDownRatings.js";

const sameTeam = (a, b) => String(a || "").toUpperCase() === String(b || "").toUpperCase();

// The reported move for this player at this team, if any.
export function reportedDeparture(team, player, changes = ROSTER_CHANGES) {
  const ids = [player?.gsisId, player?.canonicalId, player?.gsis_id].filter(Boolean).map(String);
  const sleeper = player?.sleeperId ?? player?.playerId ?? player?.id;
  const name = nameKey(player?.name || player?.fullName || player?.full_name);
  return changes.find((change) => sameTeam(change.team, team) && (
    (change.gsisId && ids.includes(String(change.gsisId))) ||
    (change.sleeperId && sleeper != null && String(change.sleeperId) === String(sleeper)) ||
    (name && nameKey(change.name) === name))) || null;
}
