import { canonicalTeamIdentity } from "./contracts.js";

export const PLAYER_MATCH = Object.freeze({
  MATCHED_STABLE_ID: "MATCHED_STABLE_ID",
  MATCHED_EXACT_NAME_EVENT: "MATCHED_EXACT_NAME_EVENT",
  MATCHED_NORMALIZED_NAME_EVENT: "MATCHED_NORMALIZED_NAME_EVENT",
  UNRESOLVED: "UNRESOLVED",
  AMBIGUOUS: "AMBIGUOUS",
  TEAM_MISMATCH: "TEAM_MISMATCH",
});

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export function resolvePlayerIdentity({
  providerPlayerId = null,
  providerIdType = null,
  playerName,
  eventTeams = [],
  playerTeam = null,
  players = [],
}) {
  const suppliedTeam = normalizeTeam(playerTeam);
  const gameTeams = new Set(eventTeams.map(normalizeTeam).filter(Boolean));
  if (suppliedTeam && !gameTeams.has(suppliedTeam)) {
    return unresolved(PLAYER_MATCH.TEAM_MISMATCH, "supplied player team is outside the event team context");
  }
  const permittedTeams = suppliedTeam ? new Set([suppliedTeam]) : gameTeams;
  if (providerPlayerId && isCompatibleStableId(providerIdType)) {
    const stableMatches = players.filter((player) => stableId(player) === String(providerPlayerId));
    if (stableMatches.length === 1) {
      if (!permittedTeams.has(normalizeTeam(stableMatches[0].team))) {
        return unresolved(PLAYER_MATCH.TEAM_MISMATCH, "stable identifier resolves outside the event team context");
      }
      return matched(PLAYER_MATCH.MATCHED_STABLE_ID, stableMatches[0]);
    }
    if (stableMatches.length > 1) return unresolved(PLAYER_MATCH.AMBIGUOUS, "stable identifier is not unique");
  }

  const input = tokenizeName(playerName);
  if (!input.length) return unresolved(PLAYER_MATCH.UNRESOLVED, "player name is missing");

  const exact = players.filter((player) => sameName(input, tokenizeName(playerNameOf(player))));
  const exactContext = exact.filter((player) => permittedTeams.has(normalizeTeam(player.team)));
  if (exactContext.length === 1) return matched(PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT, exactContext[0]);
  if (exactContext.length > 1) return unresolved(PLAYER_MATCH.AMBIGUOUS, "multiple exact name matches on the event teams");
  if (exact.length) return unresolved(PLAYER_MATCH.TEAM_MISMATCH, "exact name exists, but not for the supplied event team");

  const normalized = players.filter((player) =>
    sameAbbreviatedName(input, tokenizeName(playerNameOf(player)))
  );
  const normalizedContext = normalized.filter((player) => permittedTeams.has(normalizeTeam(player.team)));
  if (normalizedContext.length === 1) return matched(PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT, normalizedContext[0]);
  if (normalizedContext.length > 1) return unresolved(PLAYER_MATCH.AMBIGUOUS, "normalized name matches multiple event players");
  if (normalized.length) return unresolved(PLAYER_MATCH.TEAM_MISMATCH, "normalized name exists, but not for the supplied event team");
  return unresolved(PLAYER_MATCH.UNRESOLVED, "no exact or supported normalized event player match");
}

export function normalizePlayerName(value) {
  return tokenizeName(value).join(" ");
}

export function isEligibleBettingQuote(quote) {
  if (quote?.eligibleForBetting !== true) return false;
  if (!quote.playerName) return true;
  return [
    PLAYER_MATCH.MATCHED_STABLE_ID,
    PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT,
    PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT,
  ].includes(quote.playerIdentityStatus);
}

function matched(status, player) {
  return {
    status,
    playerId: stableId(player),
    playerName: playerNameOf(player),
    team: player.team,
    reason: null,
  };
}

function unresolved(status, reason) {
  return { status, playerId: null, playerName: null, team: null, reason };
}

function playerNameOf(player) {
  return player?.playerName || player?.name || player?.displayName || "";
}

function stableId(player) {
  return player?.gsisId || player?.gsis_id || player?.playerId || player?.id || null;
}

function isCompatibleStableId(type) {
  return ["gsis", "gsis_id", "nflverse_gsis"].includes(String(type || "").toLowerCase());
}

function normalizeTeam(value) {
  return canonicalTeamIdentity(value);
}

function tokenizeName(value) {
  const normalized = String(value || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/([a-z])\.([a-z])/g, "$1 $2")
    .replace(/[.'’]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return normalized;
}

function sameName(left, right) {
  if (!left.length || left.length !== right.length) return false;
  return left.every((token, index) => token === right[index]);
}

function sameAbbreviatedName(left, right) {
  if (!left.length || !right.length) return false;
  const leftHasSuffix = SUFFIXES.has(left.at(-1));
  const rightHasSuffix = SUFFIXES.has(right.at(-1));
  if (leftHasSuffix !== rightHasSuffix) return false;
  const a = leftHasSuffix ? left.slice(0, -1) : left;
  const b = rightHasSuffix ? right.slice(0, -1) : right;
  if (a.length !== b.length || a.length < 2) return false;
  if (a.slice(1).join(" ") !== b.slice(1).join(" ")) return false;
  const firstInitial = (name) => name[0].length === 1 ? name[0] : name[0][0];
  return firstInitial(a) === firstInitial(b);
}
