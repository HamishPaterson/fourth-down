import test from "node:test";
import assert from "node:assert/strict";
import { MARKETS, createClient, inSeason, proposeMulti, refreshMarket, refreshOdds, refreshPredictions } from "./weekly-production.mjs";
import { verifyWeeklyData } from "./verify-weekly-data.mjs";
import { buildQbrRows, buildTeamRows, identityResolver, serialize, updateEspn } from "./update-espn.mjs";
import espn from "../src/services/espnSnapshotData.js";

const script = (replies) => { const calls = []; const call = async (route, options) => { calls.push({ route, options }); return replies[Math.min(calls.length - 1, replies.length - 1)]; }; return { call, calls }; };
const waits = () => { const list = []; return { list, sleep: async (ms) => { list.push(ms); } }; };

test("a partial market resumes where it stopped, more than a minute later", async () => {
  const { call, calls } = script([{ status: 200, body: { status: "partial", nextOffset: 5500, retryAfterSeconds: 44, rowCount: 56 } }, { status: 200, body: { status: "ok", rowCount: 64 } }]);
  const w = waits();
  assert.equal((await refreshMarket(call, "point_spread", w)).status, "ok");
  assert.equal(calls[1].route, "/api/nfl/odds?refreshMarket=point_spread&resumeOffset=5500");
  assert.ok(w.list[0] >= 62000);
});

test("cooldowns are respected, retries are bounded and bad credentials stop the job", async () => {
  const limited = script([{ status: 429, body: { status: "rate_limited", retryAfterSeconds: 120 } }]), w = waits();
  assert.equal((await refreshMarket(limited.call, "player_receptions", w)).status, "rate_limited");
  assert.equal(limited.calls.length, 4);
  assert.ok(w.list.every((ms) => ms >= 122000));
  await assert.rejects(refreshMarket(script([{ status: 401, body: {} }]).call, "moneyline", waits()), /credentials/);
});

test("markets are spaced by a minute; one lost market is reported, but lost moneylines stop the job", async () => {
  const w = waits();
  const results = await refreshOdds(async (route) => ({ status: 200, body: { status: /receptions/.test(route) ? "error" : "ok", rowCount: 1 } }), w);
  assert.equal(results.length, MARKETS.length);
  assert.ok(w.list.every((ms) => ms >= 62000));
  await assert.rejects(refreshOdds(async () => ({ status: 500, body: { status: "error" } }), waits()), /Moneyline odds/);
});

test("prediction refresh survives timeouts, stops at complete, and refuses the wrong week", async () => {
  const ok = (remaining) => ({ status: 200, body: { week: 13, processed: 2, remaining, complete: remaining === 0 } });
  const run = script([ok(2), { status: 504, body: { error: "non-JSON response" } }, { status: 0, body: { error: "timeout" } }, ok(0)]);
  assert.equal((await refreshPredictions(run.call, 13, waits())).complete, true);
  assert.equal(run.calls.length, 4);
  assert.deepEqual(run.calls[0].options.body, { dryRun: false, prepareWeeklyLock: true });
  const limited = script([{ status: 502, body: { reason: "BALLDONTLIE schedule wait exceeds request deadline" } }, ok(0)]), w = waits();
  assert.equal((await refreshPredictions(limited.call, 13, w)).complete, true);
  assert.deepEqual(w.list, [62000]);
  await assert.rejects(refreshPredictions(script([{ status: 502, body: { reason: "broken" } }]).call, 13, waits()), /broken/);
  await assert.rejects(refreshPredictions(script([ok(0)]).call, 12, waits()), /expected Week 12/);
  await assert.rejects(refreshPredictions(script([ok(4)]).call, 13, { ...waits(), maxCalls: 3 }), /did not complete/);
});

test("the job only ever asks for a dry-run Multi and never sends an approval", async () => {
  const { call, calls } = script([{ status: 200, body: { status: "prepared", readiness: { selection: { legs: [
    { awayCode: "SEA", homeCode: "SF", selection: "SF", market: "Moneyline", decimalOdds: 1.58, tempered: { probability: .71 } }] } } } }]);
  const result = await proposeMulti(call);
  assert.deepEqual(calls, [{ route: "/api/weekly-multi/prepare?dryRun=1", options: undefined }]);
  assert.equal(result.legs[0].pick, "SF (Moneyline)");
});

test("the client sends the secret only as a bearer header and reports transport failures", async () => {
  let seen;
  const call = createClient({ base: "https://example.test", secret: "s3cret", fetchImpl: async (url, options) => { seen = { url, options }; return { status: 200, text: async () => "{}" }; } });
  await call("/x");
  assert.equal(seen.url, "https://example.test/x");
  assert.equal(seen.options.headers.authorization, "Bearer s3cret");
  assert.throws(() => createClient({ base: "x" }), /CRON_SECRET/);
  assert.equal((await createClient({ base: "x", secret: "y", fetchImpl: async () => { throw new Error("y"); } })("/")).status, 0);
});

test("season guard covers Week 2 to Week 18 only", () => {
  assert.equal(inSeason(new Date("2026-09-15T06:59:59Z")), false);
  assert.equal(inSeason(new Date("2026-12-01T07:30:00Z")), true);
  assert.equal(inSeason(new Date("2027-01-12T07:00:00Z")), false);
});

test("every input must be for the week being published", () => {
  const good = { week: 13, team: { teamMetricsAuditsByWeek: { 13: { referenceWeek: 12 } } },
    players: { latestCompletedWeek: 12, playerMetricsByWeek: { 13: {} } }, external: { maxCompletedWeek: 12 },
    ratings: { predictionWeek: 13, latestCompletedWeek: 12 },
    espn: { predictionWeek: 13, fpiRows: Array(32), efficiencyRows: Array(32) } };
  assert.deepEqual(verifyWeeklyData(good), []);
  assert.deepEqual(verifyWeeklyData({ ...good, week: 14 }), ["NFLverse team metrics", "NFLverse player metrics", "player ratings", "external factors", "ESPN"]);
  assert.deepEqual(verifyWeeklyData({ ...good, external: { maxCompletedWeek: 11 } }), ["external factors"]);
  assert.deepEqual(verifyWeeklyData({ ...good, ratings: { predictionWeek: 12, latestCompletedWeek: 11 } }), ["player ratings"]);
});

// ESPN payloads rebuilt from the stored rows, so the parser must reproduce them exactly.
const FPI = ["fpi", "epaoffense", "epadefense", "epaspecialteams", "fpirank", "avgsosrank", "sosremainingrank", "avgingamewprank", "rankchange7days", "numwins", "numlosses", "numties"];
const EFF = ["totefficiency", "totefficiencyrank", "offefficiency", "offefficiencyrank", "defefficiency", "defefficiencyrank", "stefficiency", "stefficiencyrank"];
const QBR = ["schedAdjQBR", "qbpaa", "actionPlays", "cwepaTotal", "cwepaPassesCondensed", "cwepaRuns", "cwepaSackedCondensed", "cwepaPenalties", "qbr"];
const teamPayload = () => ({ lastUpdated: "2026-11-24T07:00Z", requestedSeason: { year: 2026 },
  categories: [{ name: "fpi", names: FPI }, { name: "efficiencies", names: EFF }],
  teams: espn.fpiRows.map((row) => { const e = espn.efficiencyRows.find((x) => x[0] === row[0]), trend = row[4] === "--" ? 0 : Number(row[4].split(" ")[1]) * (row[4].startsWith("UP") ? 1 : -1);
    return { team: { abbreviation: row[0] }, categories: [
      { name: "fpi", values: [row[5] + row[6] + row[7], row[5], row[6], row[7], row[3], row[8], row[9], row[10], trend, ...row[1].split("-").map(Number)] },
      { name: "efficiencies", values: e.slice(2) }] }; }) });
const games = espn.fpiRows.reduce((sum, row) => sum + row[1].split("-").reduce((a, b) => a + Number(b), 0), 0) / 2;
const options = { season: 2026, completedGames: games, notBefore: Date.parse("2026-11-24T04:15Z") };

test("ESPN team rows keep records, ranks, trends and efficiencies", () => {
  const rows = buildTeamRows(teamPayload(), options);
  const strip = (list) => list.map((row) => [...row.slice(0, 2), ...row.slice(3)]);
  assert.deepEqual(strip(rows.fpiRows), strip([...espn.fpiRows].sort((a, b) => a[3] - b[3])));
  assert.deepEqual(rows.efficiencyRows, [...espn.efficiencyRows].sort((a, b) => a[3] - b[3]));
});

for (const [label, mutate, pattern, extra] of [
  ["ratings older than the last game", (p) => { p.lastUpdated = "2026-11-23T07:00Z"; }, /last updated/],
  ["records missing a game", (p) => {}, /records cover/, { completedGames: games + 1 }],
  ["another season", (p) => { p.requestedSeason.year = 2025; }, /wrong season/],
  ["a missing column", (p) => { p.categories[0].names = p.categories[0].names.map((n) => (n === "epadefense" ? "renamed" : n)); }, /missing fpi column epadefense/],
  ["a non-numeric value", (p) => { p.teams[0].categories[1].values[0] = null; p.teams[0].categories[1].values[0] = "x"; }, /invalid efficiencies/],
  ["components that do not add up", (p) => { p.teams[0].categories[0].values[0] += 3; }, /do not add up/],
]) test(`ESPN update refuses ${label}`, () => {
  const payload = teamPayload(); mutate(payload);
  assert.throws(() => buildTeamRows(payload, { ...options, ...extra }), pattern);
});

const athlete = (id, name, values) => ({ athlete: { id, displayName: name }, categories: [{ name: "general", totals: values.map(String) }] });
const qbrPayload = (count, start = 0) => ({ categories: [{ name: "general", names: QBR }],
  athletes: Array.from({ length: count }, (_, i) => athlete(String(start + i), `QB ${start + i}`, [60 + i, 1, 300, 10, 8, 2, -3, 1, 61])) });
const resolveId = (id) => `00-${id.padStart(7, "0")}`;

test("qualified QBs use season QBR only; others carry only their latest week", () => {
  const rows = buildQbrRows(qbrPayload(25), qbrPayload(20, 10), { referenceWeek: 12, resolveId });
  assert.equal(rows.qbrRows.length, 25);
  assert.deepEqual(rows.weeklyQbrRows.map((row) => row[0]), ["00-0000025", "00-0000026", "00-0000027", "00-0000028", "00-0000029"]);
  assert.equal(rows.weeklyQbrRows[0][2], null);
  assert.equal(rows.weeklyQbrRows[0].at(-1), 12);
});

test("an unidentified qualified QB stops the update; an unidentified one-week QB is skipped and named", () => {
  const without = (missing) => (id) => (id === missing ? null : resolveId(id));
  assert.throws(() => buildQbrRows(qbrPayload(25), qbrPayload(20, 10), { referenceWeek: 12, resolveId: without("3") }), /QB 3/);
  const rows = buildQbrRows(qbrPayload(25), qbrPayload(20, 10), { referenceWeek: 12, resolveId: without("27") });
  assert.deepEqual(rows.unresolvedWeekly, ["QB 27"]);
  assert.throws(() => buildQbrRows(qbrPayload(5), qbrPayload(20), { referenceWeek: 12, resolveId }), /only 5 season/);
});

test("identities come from depth charts and conflicting ones are refused", () => {
  const artifact = (second) => ({ metricsByWeek: { 2: { A: { expectedLineup: { roster: [{ playerId: "9", gsisId: "00-0000001", name: "X" }] } } },
    3: { A: { expectedLineup: { roster: [{ playerId: "9", gsisId: second, name: "X" }] } } } } });
  assert.equal(identityResolver(artifact("00-0000001"), 3)("9"), "00-0000001");
  assert.equal(identityResolver(artifact("00-0000001"), 3)("8"), null);
  assert.throws(() => identityResolver(artifact("00-0000002"), 3), /conflicting identity/);
});

test("ESPN never runs before NFLverse, and nothing is written on failure", async () => {
  await assert.rejects(updateEspn({ season: 2026, predictionWeek: 13, teamArtifact: {}, fetchImpl: () => assert.fail("no request"), output: "unused" }), /NFLverse Week 13/);
  assert.match(serialize(espn), /GENERATED by scripts\/update-espn/);
});
