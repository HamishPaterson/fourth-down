import { TEAM_NAMES } from "../data.js";

// A favourite team is optional. Until someone picks a team or chooses "no team", the app asks
// once. The choice lives in this browser and on the signed-in account (Supabase user metadata,
// a preference only — never used for access), so it follows the user to other devices.
const TEAM_KEY = "favoriteTeam";
const CHOICE_KEY = "favoriteTeamChoice";
const NO_TEAM = "none";

export function isTeamCode(team) {
  return typeof team === "string" && Object.hasOwn(TEAM_NAMES, team);
}

// { team: code or null, decided: whether the user has answered the question }
export function readFavoriteTeamChoice() {
  try {
    const team = localStorage.getItem(TEAM_KEY);
    if (isTeamCode(team)) return { team, decided: true };
    return { team: null, decided: localStorage.getItem(CHOICE_KEY) === NO_TEAM };
  } catch (error) {
    console.warn("Favourite team preference could not be loaded", error);
    return { team: null, decided: false };
  }
}

export function readFavoriteTeam() {
  return readFavoriteTeamChoice().team;
}

// team: a team code, or null for "no favourite team".
export function saveFavoriteTeamPreference(team) {
  if (team !== null && !isTeamCode(team)) throw new Error("Invalid favourite NFL team code");
  if (team) {
    localStorage.setItem(TEAM_KEY, team);
    localStorage.removeItem?.(CHOICE_KEY);
  } else {
    localStorage.removeItem?.(TEAM_KEY);
    localStorage.setItem(CHOICE_KEY, NO_TEAM);
  }
}

// The account's saved answer: a team code, null for "no team", or undefined when never answered.
export function accountFavoriteTeam(user) {
  const value = user?.user_metadata?.favorite_team;
  if (value === NO_TEAM) return null;
  return isTeamCode(value) ? value : undefined;
}

export async function saveFavoriteTeamToAccount(authClient, team) {
  const { error } = await authClient.auth.updateUser({ data: { favorite_team: team || NO_TEAM } });
  if (error) throw error;
}
