import { isFinalGame } from "./gameResults.js";

// NFL weeks roll forward only after the previous week's final game is FINAL.
// Tuesday 8 September 2026 is the start of the Week 1 display window.
const WEEK_ONE_START_MS = Date.UTC(2026, 8, 8, 0, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The calendar week derived purely from the clock. This is the upper bound for
// the week selector and the week used when no schedule state is available.
export function getCalendarWeek(now = Date.now()) {
  const week = Math.floor((now - WEEK_ONE_START_MS) / WEEK_MS) + 1;
  return Math.min(18, Math.max(1, week));
}

// The default displayed week from authoritative game lifecycle state. The active
// week is the most recent week that still has a non-FINAL game (in progress or
// not started). Once every game of a week is FINAL, the default rolls forward.
// Next-week predictions may exist without forcing the UI forward; manual
// selection still allows any week.
export function getDefaultWeek(games, now = Date.now()) {
  const calendarWeek = getCalendarWeek(now);
  const byWeek = new Map();
  for (const game of games || []) {
    const week = Number(game?.week);
    if (!Number.isInteger(week)) continue;
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(game);
  }
  // The active week is the latest week at or before the calendar week that still
  // has an unfinished game; otherwise the calendar week once it has begun.
  for (let week = calendarWeek; week >= 1; week -= 1) {
    const weekGames = byWeek.get(week);
    if (!weekGames?.length) continue;
    if (weekGames.some((game) => !isFinalGame(game?.resultGame || game))) return week;
    if (week === calendarWeek) return calendarWeek;
  }
  return calendarWeek;
}
