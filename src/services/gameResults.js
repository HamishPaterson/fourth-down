export function normalizeResultTeam(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" }[normalized] || normalized;
}

export function isFinalGame(game) {
  if (game.completed === true) return true;
  const status = String(game.status || game.status_state || game.state || "").toLowerCase();
  return status.includes("final") || status.includes("complete") ||
    status.includes("closed") || status === "post";
}

export function getGameTeamCode(game, side) {
  const team = side === "away"
    ? game.visitor_team || game.away_team || game.away || {}
    : game.home_team || game.home || {};
  return normalizeResultTeam(
    team.abbreviation || team.abbr || team.code ||
    game[`${side}_team_abbreviation`] || game[`${side}_team_code`]
  );
}

export function getGameScore(game, side) {
  const value = side === "away"
    ? game.visitor_team_score ?? game.away_team_score ?? game.away_score
    : game.home_team_score ?? game.home_score;
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export function isValidCompletedResult(row) {
  if (!row?.actualWinner) return false;
  const away = Number(row.actualAwayScore);
  const home = Number(row.actualHomeScore);
  return Number.isFinite(away) && Number.isFinite(home) && !(away === 0 && home === 0);
}

export function resultGameKey(game) {
  const kickoff = game.kickoff || game.sourceDate || game.date || game.datetime || game.start_time;
  const timestamp = Date.parse(kickoff);
  const season = Number(game.season?.year ?? game.season ?? new Date(timestamp).getUTCFullYear());
  const week = Number(game.week?.number ?? game.week);
  const away = normalizeResultTeam(game.awayCode || (typeof game.away === "string" && game.away)) || getGameTeamCode(game, "away");
  const home = normalizeResultTeam(game.homeCode || (typeof game.home === "string" && game.home)) || getGameTeamCode(game, "home");
  if (!Number.isInteger(season) || !Number.isInteger(week) || !away || !home || !Number.isFinite(timestamp)) return null;
  return [season, week, away, home, timestamp].join(":");
}

export function withGameResult(row, game) {
  if (isValidCompletedResult(row)) return row;
  const source = game?.resultGame || game;
  const key = source && resultGameKey(source);
  if (!key || key !== resultGameKey(row) || !isFinalGame(source)) return row;
  const actualAwayScore = getGameScore(source, "away");
  const actualHomeScore = getGameScore(source, "home");
  if (actualAwayScore === null || actualHomeScore === null) return row;
  const actualWinner = actualAwayScore === actualHomeScore ? "TIE"
    : actualAwayScore > actualHomeScore ? normalizeResultTeam(row.awayCode) : normalizeResultTeam(row.homeCode);
  return { ...row, actualAwayScore, actualHomeScore, actualWinner };
}

export function completedPickLabel(row) {
  if (!isValidCompletedResult(row) || !row.fourthDownPick || row.actualWinner === "TIE") return "PICK NOT GRADED";
  return normalizeResultTeam(row.fourthDownPick) === normalizeResultTeam(row.actualWinner)
    ? "PICK CORRECT" : "PICK INCORRECT";
}
