import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  NFL_TEAMS, prepareNetworkGames, solveOpponentNetwork, getRecentTeamGames,
  networkGameWeight, findCommonOpponents, teamPerformanceAgainst, calculateCommonOpponentEdge,
  createOpponentNetworkHandler, loadWeeklyOpponentNetwork,
} from "../api/nfl/opponent-network.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { getFullGamePrediction, clearFullGamePredictionCache } from "../src/services/gamePredictionService.js";

const close = (actual, expected, tolerance = .001) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sourceGame = (id, away = "SF", home = "KC", awayScore = 17, homeScore = 27, week = 1) => ({
  id, season: 2026, week, status: "Final", postseason: false,
  visitor_team: { abbreviation: away }, home_team: { abbreviation: home },
  visitor_team_score: awayScore, home_team_score: homeScore,
});
function seasonGames() {
  const rotation = [...NFL_TEAMS];
  const games = [];
  for (let week = 1; week <= 5; week += 1) {
    for (let index = 0; index < 16; index += 1) {
      games.push(sourceGame(`${week}-${index}`, rotation[index], rotation[31 - index],
        10 + (index * 7 + week) % 27, 14 + (index * 3 + week * 2) % 25, week));
    }
    rotation.splice(1, 0, rotation.pop());
  }
  return games;
}
const jsonResponse = (body, ok = true) => ({
  ok, status: ok ? 200 : 503,
  json: async () => body, text: async () => JSON.stringify(body),
});
async function invoke(query = {}, method = "GET") {
  const response = {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
  };
  await createOpponentNetworkHandler({ loadNetwork: (season, week) =>
    loadWeeklyOpponentNetwork(season, week, { sleep: async () => {} }) })(
    { method, query: { season: "2026", week: "6", away: "SF", home: "KC", ...query } }, response);
  return response;
}
const originalFetch = global.fetch;
const originalKey = process.env.BALLDONTLIE_API_KEY;
beforeEach(() => {
  process.env.BALLDONTLIE_API_KEY = "test-only";
  clearFullGamePredictionCache();
  global.fetch = async () => jsonResponse({ data: seasonGames(), meta: {} });
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.BALLDONTLIE_API_KEY;
  else process.env.BALLDONTLIE_API_KEY = originalKey;
});
function finiteValues(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(finiteValues);
}

test("endpoint passes node --check and executes the existing response contract", async () => {
  execFileSync(process.execPath, ["--check", "api\\nfl\\opponent-network.js"]);
  const response = await invoke();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dataStatus, "available");
  assert.equal(response.body.gamesUsed, 80);
  assert.match(response.headers["Cache-Control"], /s-maxage=1800/);
  finiteValues(response.body);
});

test("all 32 teams have finite, nonconstant ratings and four actual recent relationships", () => {
  const games = prepareNetworkGames(seasonGames(), 2026, 6);
  const ratings = solveOpponentNetwork(games, 6);
  assert.deepEqual(Object.keys(ratings).sort(), [...NFL_TEAMS].sort());
  assert.equal(games.length, 80);
  assert.ok(new Set(Object.values(ratings).map((rating) => rating.overall)).size > 1);
  finiteValues(ratings);
  for (const team of NFL_TEAMS) {
    const recent = getRecentTeamGames(games, team);
    assert.equal(recent.length, 4);
    assert.equal(ratings[team].games, 4);
    assert.ok(recent.every((game) => game.week >= 2 && (game.away === team || game.home === team)));
    for (const game of recent) {
      assert.equal(game.weight, networkGameWeight(game, 6));
      assert.ok(game.weight > 0 && game.weight <= 1);
      const source = seasonGames().find((row) => row.id === game.id);
      assert.equal(source.visitor_team.abbreviation, game.away);
      assert.equal(source.home_team.abbreviation, game.home);
      assert.equal(source.visitor_team_score, game.awayScore);
      assert.equal(source.home_team_score, game.homeScore);
    }
  }
  close(Object.values(ratings).reduce((sum, rating) => sum + rating.offense, 0), 0, .032);
  close(Object.values(ratings).reduce((sum, rating) => sum + rating.defense, 0), 0, .032);
});

test("only completed requested-season regular games strictly before the target week enter", () => {
  const valid = sourceGame("eligible");
  const invalid = [
    { ...valid, id: "future", week: 6 }, { ...valid, id: "later", week: 8 },
    { ...valid, id: "old-season", season: 2025 },
    { ...valid, id: "missing-season", season: null },
    { ...valid, id: "post", postseason: true }, { ...valid, id: "post-string", postseason: "true" },
    { ...valid, id: "pre-week", week: 0 }, { ...valid, id: "pre-type", season_type: 1 },
    { ...valid, id: "post-type", game_type: "WC" },
    { ...valid, id: "pre", game_type: "PRE" },
    { ...valid, id: "scheduled", status: "Scheduled" },
    { ...valid, id: "incomplete", status: "Incomplete" },
    { ...valid, id: "live", status: "In Progress" },
  ];
  assert.deepEqual(prepareNetworkGames([valid, ...invalid], 2026, 6).map((game) => game.id), ["eligible"]);
  for (const status of ["Final/OT", "Completed", "closed", "post"]) {
    assert.equal(prepareNetworkGames([{ ...valid, status }], 2026, 6).length, 1);
  }
});

test("provider IDs, missing IDs, aliases, reverse orientation and duplicate pages cannot double count games", async () => {
  const source = sourceGame("game", "WAS", "LA");
  const canonical = sourceGame("different-id", "WSH", "LAR");
  const reverse = sourceGame(null, "LAR", "WSH", 27, 17);
  const games = prepareNetworkGames([source, { ...source }, canonical, reverse], 2026, 6);
  assert.equal(games.length, 1);
  assert.equal(games[0].away, "WSH");
  assert.equal(games[0].home, "LAR");
  assert.deepEqual(solveOpponentNetwork(games, 6),
    solveOpponentNetwork(prepareNetworkGames([source], 2026, 6), 6));
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    const cursor = new URL(url).searchParams.get("cursor");
    return jsonResponse({ data: [sourceGame("same")], meta: { next_cursor: cursor ? null : 1 } });
  };
  const response = await invoke();
  assert.equal(calls, 2);
  assert.equal(response.body.gamesUsed, 1);
});

test("conflicting duplicates, self-links, unresolved aliases and invalid scores fail explicitly", () => {
  const valid = sourceGame("g");
  assert.throws(() => prepareNetworkGames([valid, { ...valid, home_team_score: 31 }], 2026, 6), /Conflicting duplicate/);
  assert.throws(() => prepareNetworkGames([valid, sourceGame("g", "DAL", "NYG")], 2026, 6), /Conflicting duplicate/);
  for (const game of [
    sourceGame("self", "SF", "SF"), sourceGame("unknown", "XYZ", "KC"),
    sourceGame("null", "SF", "KC", null), sourceGame("nan", "SF", "KC", NaN),
    sourceGame("infinity", "SF", "KC", Infinity), sourceGame("blank", "SF", "KC", " "),
    sourceGame("fractional", "SF", "KC", 1.5), sourceGame("boolean", "SF", "KC", false),
  ]) assert.throws(() => prepareNetworkGames([game], 2026, 6), /Invalid teams or scores/);
  const aliases = { JAC: "JAX", WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
  for (const [alias, canonical] of Object.entries(aliases)) {
    assert.equal(prepareNetworkGames([sourceGame(alias, alias, "KC")], 2026, 6)[0].away, canonical);
  }
  assert.equal(prepareNetworkGames([sourceGame("zero", "SF", "KC", 0, 0)], 2026, 6).length, 1);
});

test("sparse/disconnected schedules stay finite; byes create no edges and isolated teams stay neutral", () => {
  const games = prepareNetworkGames([sourceGame("one")], 2026, 2);
  const ratings = solveOpponentNetwork(games, 2);
  assert.equal(Object.keys(ratings).length, 32);
  assert.ok(ratings.KC.overall > ratings.SF.overall);
  assert.equal(ratings.KC.games, 1);
  assert.deepEqual(ratings.BUF, { offense: 0, defense: 0, overall: 0, scheduleStrength: 0, games: 0 });
  assert.equal(getRecentTeamGames(games, "BUF").length, 0);
  assert.equal(getRecentTeamGames(games, "KC").length, 1);
  finiteValues(ratings);
  const disconnected = solveOpponentNetwork(prepareNetworkGames([
    sourceGame("one"), sourceGame("two", "BUF", "NYJ", 31, 7),
  ], 2026, 2), 2);
  assert.ok(disconnected.KC.overall > disconnected.SF.overall);
  assert.ok(disconnected.BUF.overall > disconnected.NYJ.overall);
  finiteValues(disconnected);
});

test("recency and volatility weights match the documented reconstruction", () => {
  const tied = { week: 5, homeScore: 22, awayScore: 22 };
  for (const [week, expected] of [[5, 1], [4, .95], [3, .85], [2, .75], [1, .65]]) {
    close(networkGameWeight({ ...tied, week }, 6), expected);
  }
  assert.ok(networkGameWeight({ ...tied, homeScore: 50 }, 6) < networkGameWeight(tied, 6));
});

test("alternative provider field names preserve score orientation and canonical teams", () => {
  const games = prepareNetworkGames([{
    id: "alternate", season: 2026, week: 1, completed: true, season_type: "REG",
    away_team_abbreviation: "SD", home_team_abbreviation: "OAK",
    away_score: "0", home_score: "24",
  }], 2026, 2);
  assert.equal(games[0].away, "LAC");
  assert.equal(games[0].home, "LV");
  assert.equal(games[0].awayScore, 0);
  assert.equal(games[0].homeScore, 24);
});

test("network preserves performance direction and propagates stronger opponent results", () => {
  const rows = [
    sourceGame("a", "SF", "KC", 17, 27, 1),
    sourceGame("b", "KC", "BUF", 24, 24, 2),
    sourceGame("c", "BUF", "SF", 24, 24, 3),
  ];
  const rate = (games) => solveOpponentNetwork(prepareNetworkGames(games, 2026, 4), 4);
  const before = rate(rows);
  const better = rate(rows.map((game) => game.id === "a" ? { ...game, home_team_score: 34 } : game));
  assert.ok(better.KC.overall > before.KC.overall);
  const worse = rate(rows.map((game) => game.id === "a" ? { ...game, home_team_score: 10 } : game));
  assert.ok(worse.KC.overall < before.KC.overall);
  const level = [
    sourceGame("a", "KC", "BUF", 22, 22, 1),
    sourceGame("b", "BUF", "DAL", 22, 22, 2),
    sourceGame("c", "DAL", "NYJ", 22, 22, 3),
    sourceGame("d", "NYJ", "KC", 22, 22, 3),
  ];
  const levelRatings = rate(level);
  // Change only the opponent's third-party result, not KC's own game.
  const strongerOpponent = rate(level.map((game) => game.id === "b" ? { ...game, visitor_team_score: 38 } : game));
  assert.ok(strongerOpponent.BUF.overall > levelRatings.BUF.overall);
  assert.ok(strongerOpponent.KC.scheduleStrength > levelRatings.KC.scheduleStrength);
  assert.ok(strongerOpponent.KC.overall > levelRatings.KC.overall);
  const weakerOpponent = rate(level.map((game) => game.id === "b" ? { ...game, visitor_team_score: 6 } : game));
  assert.ok(weakerOpponent.BUF.overall < levelRatings.BUF.overall);
  assert.ok(weakerOpponent.KC.overall < levelRatings.KC.overall);
});

test("common opponents compare weighted margins with correct strength direction and existing cap", () => {
  const games = prepareNetworkGames([
    sourceGame("sf", "SF", "BUF", 20, 24, 1),
    sourceGame("kc", "KC", "BUF", 31, 24, 2),
  ], 2026, 3);
  const ratings = solveOpponentNetwork(games, 3);
  const common = findCommonOpponents(games, "SF", "KC", ratings, 3);
  assert.equal(common.length, 1);
  assert.equal(common[0].team, "BUF");
  assert.ok(common[0].homePerformance > common[0].awayPerformance);
  assert.equal(calculateCommonOpponentEdge(common), 1);
  assert.equal(calculateCommonOpponentEdge(common.map((row) => ({
    ...row, homePerformance: row.awayPerformance, awayPerformance: row.homePerformance,
  }))), -1);
  assert.equal(calculateCommonOpponentEdge([]), 0);
  const stronger = { ...ratings, BUF: { ...ratings.BUF, overall: ratings.BUF.overall + 4 } };
  close(teamPerformanceAgainst(games, "KC", "BUF", stronger, 3) -
    teamPerformanceAgainst(games, "KC", "BUF", ratings, 3), 4);
  close(calculateCommonOpponentEdge(findCommonOpponents(games, "SF", "KC", stronger, 3)), 1);
});

test("missing history and week one use an unavailable neutral layer", async () => {
  global.fetch = async () => { throw new Error("Week one must not fetch"); };
  const first = await invoke({ week: "1" });
  assert.equal(first.body.modelLayer.available, false);
  assert.equal(first.body.modelLayer.confidence, 0);
  global.fetch = async () => jsonResponse({ data: [], meta: {} });
  const empty = await invoke();
  assert.equal(empty.body.dataStatus, "neutral");
  assert.equal(empty.body.modelLayer.homePoints, 0);
  assert.equal(Object.keys(empty.body.ratings).length, 32);
  global.fetch = async () => jsonResponse({ data: [sourceGame("g", "BUF", "NYJ")], meta: {} });
  const missing = await invoke();
  assert.equal(missing.body.modelLayer.available, false);
  assert.equal(missing.body.modelLayer.homePoints, 0);
  finiteValues(missing.body);
});

test("endpoint failures and cyclic pagination return one explicit structured error", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    global.fetch = async () => jsonResponse({ error: "Provider unavailable" }, false);
    const failed = await invoke();
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.dataStatus, "unavailable");
    assert.match(failed.body.reason, /503/);
    global.fetch = async () => jsonResponse({ data: [sourceGame("g")], meta: { next_cursor: 1 } });
    const truncated = await invoke();
    assert.equal(truncated.statusCode, 502);
    assert.match(truncated.body.reason, /repeated cursor/);
    assert.equal(errors.length, 2);
    finiteValues(truncated.body);
  } finally {
    console.error = originalError;
  }
});

test("request guards retain method/key errors and reject invalid/self matchups", async () => {
  assert.equal((await invoke({}, "POST")).statusCode, 405);
  for (const query of [{ week: "0" }, { week: "20" }, { away: "XYZ" }, { away: "KC" }]) {
    assert.equal((await invoke(query)).statusCode, 400);
  }
  delete process.env.BALLDONTLIE_API_KEY;
  assert.equal((await invoke()).statusCode, 500);
});

async function orchestrate(rows, networkFailure = false) {
  let networkBody;
  global.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("https://api.balldontlie.io/")) return jsonResponse({ data: rows, meta: {} });
    if (path.startsWith("/api/nfl/opponent-network?")) {
      if (networkFailure) return jsonResponse({ error: "Network unavailable" }, false);
      networkBody = (await invoke(Object.fromEntries(new URL(path, "http://test").searchParams))).body;
      return jsonResponse(networkBody);
    }
    if (path.startsWith("/api/nfl/game-stats?") && !path.includes("action=")) {
      return jsonResponse({ modelLayers: { scoringBaseline: {
        active: true, awayExpected: 24, homeExpected: 25,
        gamesUsed: { away: 4, home: 4 }, confidence: .6,
      } } });
    }
    // Other data sources are held identical and empty; no external calls or writes.
    return jsonResponse({});
  };
  const result = await getFullGamePrediction({
    away: "SF", home: "KC", week: 6, weather: { dome: true },
    sourceDate: "2026-10-18T20:25:00.000Z",
  }, null, { season: 2026, forceRefresh: true });
  return { result, networkBody };
}

test("endpoint -> actual orchestration -> engine retains neutral/home/away network scores and probabilities", async () => {
  const rows = (homeScore, awayScore) => Array.from({ length: 4 }, (_, index) =>
    sourceGame(`week-${index}`, "SF", "KC", awayScore, homeScore, index + 1));
  const neutral = await orchestrate(rows(22, 22));
  const home = await orchestrate(rows(35, 10));
  const away = await orchestrate(rows(10, 35));
  const missing = await orchestrate([]);
  for (const { result, networkBody } of [neutral, home, away, missing]) {
    const layer = result.prediction.modelLayers.opponentNetwork;
    close(layer.homePoints, networkBody.modelLayer.homePoints);
    close(layer.awayPoints, networkBody.modelLayer.awayPoints);
    assert.equal(layer.available, networkBody.modelLayer.available);
    finiteValues(networkBody);
    for (const value of [result.prediction.continuousMargin, result.prediction.homeWinProbability,
      result.prediction.away.expectedPoints, result.prediction.home.expectedPoints]) {
      assert.ok(Number.isFinite(value));
    }
    assert.ok(Math.abs(layer.homePoints) <= .9);
    assert.ok(Math.abs(networkBody.modelLayer.rawHomePoints) <= 1);
  }
  const base = neutral.result.prediction;
  const homePrediction = home.result.prediction;
  const awayPrediction = away.result.prediction;
  console.log("Network handoff sensitivity:", JSON.stringify([neutral, home, away].map(({ result, networkBody }) => ({
    points: networkBody.modelLayer.homePoints, margin: result.prediction.continuousMargin,
    homeProbability: result.prediction.homeWinProbability,
  }))));
  assert.equal(neutral.networkBody.modelLayer.homePoints, 0);
  assert.equal(home.networkBody.modelLayer.homePoints, .8);
  assert.equal(away.networkBody.modelLayer.homePoints, -.8);
  assert.ok(homePrediction.continuousMargin > base.continuousMargin);
  assert.ok(homePrediction.homeWinProbability > base.homeWinProbability);
  assert.ok(homePrediction.home.expectedPoints > base.home.expectedPoints);
  assert.ok(awayPrediction.continuousMargin < base.continuousMargin);
  assert.ok(awayPrediction.homeWinProbability < base.homeWinProbability);
  assert.ok(awayPrediction.away.expectedPoints > base.away.expectedPoints);
  assert.equal(missing.result.prediction.continuousMargin, base.continuousMargin);
});

test("a rejected network request preserves the orchestration's existing neutral fallback", async () => {
  const baseline = await orchestrate([]);
  const failed = await orchestrate([], true);
  assert.equal(failed.result.prediction.modelLayers.opponentNetwork.available, false);
  assert.equal(failed.result.prediction.modelLayers.opponentNetwork.homePoints, 0);
  assert.equal(failed.result.prediction.modelLayers.opponentNetwork.confidence, 0);
  assert.equal(failed.result.prediction.continuousMargin, baseline.result.prediction.continuousMargin);
  assert.equal(failed.result.prediction.homeWinProbability, baseline.result.prediction.homeWinProbability);
  assert.equal(failed.result.dataQuality.opponentNetwork, false);
});

test("maximum confidence and point caps remain unchanged with common-opponent coverage", async () => {
  const rows = [];
  for (let week = 1; week <= 4; week += 1) {
    rows.push(sourceGame(`sf-${week}`, "SF", ["BUF", "DAL", "NYJ", "NO"][week - 1], 0, 70, week));
    rows.push(sourceGame(`kc-${week}`, "KC", ["BUF", "DAL", "NYJ", "NO"][week - 1], 70, 0, week));
  }
  global.fetch = async () => jsonResponse({ data: rows, meta: {} });
  const { body } = await invoke();
  assert.equal(body.modelLayer.confidence, .9);
  assert.equal(body.modelLayer.rawHomePoints, 1);
  assert.equal(body.modelLayer.homePoints, .9);
  finiteValues(body);
});

test("existing NFLverse metric-specific adjustments retain 32-team coverage and their separate scoring path", () => {
  assert.equal(dataset.season, 2026);
  const latest = Math.max(...Object.keys(dataset.metricsByWeek).map(Number));
  const metrics = dataset.metricsByWeek[latest];
  assert.equal(Object.keys(metrics).length, 32);
  for (const team of Object.values(metrics)) {
    assert.ok(team.opponentAdjusted);
    for (const key of ["epaPerPlay", "defensiveEpaPerPlay", "passingEpaPerPlay", "rushingEpaPerPlay", "explosivePlayRate"]) {
      assert.ok(Number.isFinite(team.opponentAdjusted[key]));
    }
  }
  const before = structuredClone(metrics.SF);
  const home = structuredClone(metrics.KC);
  const layers = compareTeams(before, home, latest);
  const changed = structuredClone(before);
  for (const key of ["passingEpaPerPlay", "rushingEpaPerPlay", "explosivePlayRate"]) changed.opponentAdjusted[key] += 100;
  assert.deepEqual(compareTeams(changed, home, latest), layers);
  changed.opponentAdjusted.epaPerPlay += 100;
  assert.notDeepEqual(compareTeams(changed, home, latest).opponentAdjustedEfficiency, layers.opponentAdjustedEfficiency);
});
