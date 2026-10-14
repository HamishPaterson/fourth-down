import test from "node:test";
import assert from "node:assert/strict";
import { createWeeklyMultiCurrentHandler } from "./weeklyMulti.js";
import { gradePlayerLeg, settleLockedLegs } from "./weeklyMultiSettlement.js";

const THURSDAY = Date.UTC(2026, 9, 8, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PREVIOUS_LOCK = THURSDAY - 7 * DAY;

const stat = (name, team, fields, gameId = 1) => ({
  player: { first_name: name.split(" ")[0], last_name: name.split(" ").slice(1).join(" ") },
  team: { abbreviation: team },
  game: { id: gameId },
  ...fields,
});
const leg = (market, selection, extra = {}) => ({ market, selection, awayCode: "LAC", homeCode: "BAL", kickoff: new Date(PREVIOUS_LOCK + 3 * DAY).toISOString(), ...extra });
const rows = [
  stat("Justin Herbert", "LAC", { passing_yards: 250, passing_touchdowns: 2, passing_attempts: 38, passing_completions: 25 }),
  stat("J.K. Dobbins", "LAC", { rushing_yards: 80, rushing_attempts: 17, rushing_touchdowns: 1, receptions: 3, receiving_yards: 20, receiving_touchdowns: 0 }),
  stat("Ladd McConkey", "LAC", { receptions: 6, receiving_yards: 70, receiving_touchdowns: 0 }),
  stat("Lamar Jackson", "BAL", { rushing_yards: 40, rushing_touchdowns: 0, receiving_touchdowns: 0 }),
];
const grade = (market, selection, line) => gradePlayerLeg(leg(market, selection, { line }), rows);

test("all nine player prop types settle against the locked line", () => {
  assert.equal(grade("Passing yards", "Justin Herbert Over 249.5 passing yards", 249.5), "won");
  assert.equal(grade("Rushing yards", "J.K. Dobbins Under 79.5 rushing yards", 79.5), "lost");
  assert.equal(grade("Receptions", "Ladd McConkey Over 5.5 receptions", 5.5), "won");
  assert.equal(grade("Receiving yards", "Ladd McConkey Over 70.5 receiving yards", 70.5), "lost");
  assert.equal(grade("Passing touchdowns", "Justin Herbert Over 1.5 passing touchdowns", 1.5), "won");
  assert.equal(grade("Passing attempts", "Justin Herbert Over 38 passing attempts", 38), "push");
  assert.equal(grade("Completions", "Justin Herbert Under 26.5 completions", 26.5), "won");
  assert.equal(grade("Rushing attempts", "J.K. Dobbins Over 17.5 rushing attempts", 17.5), "lost");
  assert.equal(grade("Rush + receiving yards", "J.K. Dobbins Over 99.5 rushing + receiving yards", 99.5), "won");
});

test("canonical market keys settle the same way as display labels", () => {
  assert.equal(grade("player_rush_reception_yds", "J.K. Dobbins Over 100.5 rushing + receiving yards", 100.5), "lost");
  assert.equal(grade("player_reception_yds", "Ladd McConkey Over 69.5 receiving yards", 69.5), "won");
});

test("settlement uses the locked line, not a newer market line", () => {
  const locked = leg("Passing yards", "Justin Herbert Over 249.5 passing yards", { line: 249.5, currentLine: 300.5 });
  assert.equal(gradePlayerLeg(locked, rows), "won");
});

test("model-only Anytime TD settles on a rushing or receiving touchdown with no odds", () => {
  const td = (name) => ({ ...leg("Anytime touchdown", `${name} anytime TD`), decimalOdds: null, modelOnly: true });
  assert.equal(gradePlayerLeg(td("J.K. Dobbins"), rows), "won");
  assert.equal(gradePlayerLeg(td("Ladd McConkey"), rows), "lost");
  assert.equal(gradePlayerLeg(td("Unknown Player"), rows), "pending");
  assert.equal(gradePlayerLeg(td("J.K. Dobbins"), []), "pending");
});

test("missing stat fields never fabricate a result", () => {
  assert.equal(grade("Receptions", "Justin Herbert Over 0.5 receptions", 0.5), "pending");
  assert.equal(gradePlayerLeg(leg("Passing yards", "Justin Herbert Over 250.5 passing yards", { line: undefined }), [stat("Justin Herbert", "LAC", {})]), "pending");
});

const game = (status) => ({ id: 1, status, visitor_team: { abbreviation: "LAC" }, home_team: { abbreviation: "BAL" } });
const settle = (record, status, fetchStats = async () => rows) =>
  settleLockedLegs(record, { fetchGames: async () => [game(status)], fetchStats, normaliseCode: (code) => String(code).toUpperCase() });

test("player legs stay pending (and the multi unresolved) until the game is final", async () => {
  let statCalls = 0;
  const record = { lock_at: new Date(PREVIOUS_LOCK).toISOString(), legs: [leg("Passing yards", "Justin Herbert Over 249.5 passing yards", { line: 249.5 })] };
  const live = await settle(record, "In Progress", async () => { statCalls += 1; return rows; });
  assert.deepEqual(live, { legResults: ["pending"], unresolved: true });
  assert.equal(statCalls, 0);
  const done = await settle(record, "Final");
  assert.deepEqual(done, { legResults: ["won"], unresolved: false });
});

test("settlement lookup failure keeps the multi unresolved and visible", async () => {
  const record = { lock_at: new Date(PREVIOUS_LOCK).toISOString(), legs: [leg("Passing yards", "Justin Herbert Over 249.5 passing yards", { line: 249.5 })] };
  const result = await settle(record, "Final", async () => { throw new Error("provider down"); });
  assert.equal(result.unresolved, true);
});

function currentHandler(record, { status = "In Progress", now } = {}) {
  const queries = [];
  const handler = createWeeklyMultiCurrentHandler({
    getNow: () => new Date(now),
    fetchGames: async (from) => from === PREVIOUS_LOCK
      ? [game(status)]
      : [{ season: 2026, week: 6, date: new Date(THURSDAY + HOUR).toISOString(), postseason: false }],
    fetchStats: async () => rows,
    createClient: () => ({
      from(table) {
        queries.push(table);
        return {
          select() { return this; },
          eq(column, value) { this.value = value; return this; },
          async maybeSingle() { return { data: this.value === new Date(PREVIOUS_LOCK).toISOString() ? record : null, error: null }; },
          insert() { queries.push("write"); }, update() { queries.push("write"); }, delete() { queries.push("write"); },
        };
      },
    }),
  });
  return { handler, queries };
}
const read = async (handler) => {
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: "GET", query: {} }, res);
  return res.body;
};

const savedRecord = () => ({
  season: 2026, week: 5, lock_at: new Date(PREVIOUS_LOCK).toISOString(), status: "locked", partial: false,
  legs: [leg("Passing yards", "Justin Herbert Over 249.5 passing yards", { line: 249.5, decimalOdds: 1.9 })],
});

test("an unresolved previous-week multi stays visible after Wednesday 00:00 UTC", async () => {
  const record = savedRecord();
  const snapshot = JSON.stringify(record);
  for (const now of [THURSDAY - DAY, THURSDAY - 12 * HOUR, THURSDAY - 1]) {
    const { handler, queries } = currentHandler(record, { now });
    const body = await read(handler);
    assert.equal(body.locked, true);
    assert.equal(body.placeholder, undefined);
    assert.equal(body.week, 5);
    assert.equal(body.record, record);
    assert.deepEqual(body.legResults, ["pending"]);
    assert.equal(queries.includes("write"), false);
  }
  assert.equal(JSON.stringify(record), snapshot);
});

test("the new-week placeholder cannot hide an unresolved previous-week multi", async () => {
  const { handler } = currentHandler(savedRecord(), { now: THURSDAY - DAY });
  const body = await read(handler);
  assert.notEqual(body.status, "before lock");
  assert.equal(body.locked, true);
});

test("once every leg is settled the Wednesday display moves to the new week's placeholder", async () => {
  const { handler } = currentHandler(savedRecord(), { now: THURSDAY - DAY, status: "Final" });
  const body = await read(handler);
  assert.equal(body.status, "before lock");
  assert.equal(body.week, 6);
});

test("settled player legs are returned for display without altering locked legs or values", async () => {
  const record = savedRecord();
  const before = JSON.stringify(record.legs);
  const { handler } = currentHandler(record, { now: PREVIOUS_LOCK + 5 * DAY, status: "Final" });
  const body = await read(handler);
  assert.deepEqual(body.legResults, ["won"]);
  assert.equal(JSON.stringify(body.record.legs), before);
});

test("new-week snapshots cannot alter the held previous-week multi", async () => {
  const record = savedRecord();
  const before = JSON.stringify(record);
  const { handler, queries } = currentHandler(record, { now: THURSDAY - 6 * HOUR });
  await read(handler);
  await read(handler);
  assert.equal(JSON.stringify(record), before);
  assert.equal(queries.every((table) => table === "weekly_best_multis"), true);
});
