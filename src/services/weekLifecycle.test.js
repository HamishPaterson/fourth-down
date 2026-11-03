import test from "node:test";
import assert from "node:assert/strict";
import { getCalendarWeek, getDefaultWeek } from "./weekLifecycle.js";

// Week 8 of the 2026 season: Tuesday 27 October 2026 00:00 UTC to Tuesday 3
// November 2026 00:00 UTC. The Monday-night game kicks off 2026-11-03T01:15Z.
const WEEK8_TUESDAY = Date.UTC(2026, 9, 27, 0, 0, 0);
const WEEK8_MONDAY_NIGHT = "2026-11-03T01:15:00Z";
const WEEK8_SUNDAY = "2026-11-01T18:00:00Z";

const game = (week, status, date = WEEK8_SUNDAY) => ({
  week, season: 2026, date, status, completed: status === "Final",
});

test("calendar week is purely time-based and bounded", () => {
  assert.equal(getCalendarWeek(Date.UTC(2026, 8, 8)), 1);
  assert.equal(getCalendarWeek(WEEK8_TUESDAY), 8);
  assert.equal(getCalendarWeek(Date.UTC(2026, 10, 3, 12)), 9);
  assert.equal(getCalendarWeek(Date.UTC(2027, 5, 1)), 18);
  assert.equal(getCalendarWeek(Date.UTC(2026, 0, 1)), 1);
});

test("default remains the current week while the final game is in progress", () => {
  const games = [
    ...Array.from({ length: 12 }, (_, i) => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "In Progress", WEEK8_MONDAY_NIGHT),
    game(8, "Final", WEEK8_MONDAY_NIGHT),
  ];
  // Tuesday 12:00 UTC: Monday-night game still in progress.
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 3, 12)), 8);
});

test("default remains the current week while any game has not started", () => {
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "Scheduled", WEEK8_MONDAY_NIGHT),
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 2, 12)), 8);
});

test("default rolls forward only when every current-week game is final", () => {
  const games = Array.from({ length: 14 }, () => game(8, "Final", WEEK8_MONDAY_NIGHT));
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 3, 12)), 9);
});

test("next-week predictions already persisted do not force the UI forward", () => {
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "Scheduled", WEEK8_MONDAY_NIGHT),
    game(9, "Scheduled", "2026-11-06T01:15:00Z"),
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 2, 12)), 8);
});

test("completed-game filtering uses the resultGame wrapper", () => {
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    { week: 8, season: 2026, date: WEEK8_MONDAY_NIGHT, status: "Scheduled",
      resultGame: { status: "Final", completed: true } },
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 3, 12)), 9);
});

test("Brisbane/AEST boundary: Monday-night game keeps the default on the current week", () => {
  // 2026-11-03T01:15Z is 2026-11-03T11:15 AEST (Brisbane, no DST).
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "In Progress", WEEK8_MONDAY_NIGHT),
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 3, 1, 30)), 8);
});

test("America/Los_Angeles clock: Sunday evening still defaults to the current week", () => {
  // 2026-11-01T18:00Z is 2026-11-01T11:00 PDT (Los Angeles, DST).
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "Scheduled", WEEK8_MONDAY_NIGHT),
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 1, 19)), 8);
});

test("no schedule state falls back to the calendar week", () => {
  assert.equal(getDefaultWeek([], Date.UTC(2026, 10, 3, 12)), 9);
  assert.equal(getDefaultWeek(null, Date.UTC(2026, 10, 3, 12)), 9);
});

test("international game with an early kickoff still holds the default until final", () => {
  const games = [
    ...Array.from({ length: 13 }, () => game(8, "Final", WEEK8_SUNDAY)),
    game(8, "Scheduled", "2026-11-01T14:30:00Z"), // international Sunday morning
  ];
  assert.equal(getDefaultWeek(games, Date.UTC(2026, 10, 1, 15)), 8);
});
