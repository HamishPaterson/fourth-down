import { TEAM_NAMES } from "../data.js";

export function readFavoriteTeam() {
  try {
    const team = localStorage.getItem("favoriteTeam");
    return Object.hasOwn(TEAM_NAMES, team) ? team : "SF";
  } catch (error) {
    console.warn("Favourite team preference could not be loaded", error);
    return "SF";
  }
}

export function saveFavoriteTeamPreference(team) {
  if (!Object.hasOwn(TEAM_NAMES, team)) throw new Error("Invalid favourite NFL team code");
  localStorage.setItem("favoriteTeam", team);
}
