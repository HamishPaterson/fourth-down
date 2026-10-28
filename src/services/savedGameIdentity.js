import { resolveTeamCode } from "./oddsApi.js";

export function savedGameIdentity(snapshot) {
  const game = snapshot?.game;
  const id = String(game?.id ?? "");
  const season = Number(snapshot?.season), week = Number(snapshot?.week);
  const away = resolveTeamCode(snapshot?.awayCode), home = resolveTeamCode(snapshot?.homeCode);
  const kickoff = Date.parse(snapshot?.kickoff);
  if (!game || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) ||
      !Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 19 ||
      !away || !home || away === home || !Number.isFinite(kickoff)) return null;
  if ((game.season != null && Number(game.season) !== season) ||
      (game.week != null && Number(game.week) !== week)) return null;
  for (const [fields, expected] of [[["away", "awayCode"], away], [["home", "homeCode"], home]]) {
    if (fields.some((field) => game[field] != null && resolveTeamCode(game[field]) !== expected)) return null;
  }
  const dates = ["sourceDate", "kickoff", "date", "commence_time"].filter((field) => game[field] != null);
  if (!dates.length || dates.some((field) => Date.parse(game[field]) !== kickoff)) return null;
  return { ...game, id, season, week, away, home, sourceDate: snapshot.kickoff, kickoff: snapshot.kickoff };
}
