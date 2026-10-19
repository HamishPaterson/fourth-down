import test from "node:test";
import assert from "node:assert/strict";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import { buildBestBets, BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { buildWeeklyMultiSelection } from "./weeklyMulti.js";
import { refreshSavedBestBets, saveAuthoritativePrediction } from "./serverPredictions.js";
import { snapshotToDatabase, databaseToSnapshot } from "../api/nfl/game-stats.js";
import { retainPrediction } from "./predictionEligibility.js";
import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "../src/services/gamePredictionService.js";
import { handleOddsRequest } from "../api/nfl/odds.js";
import { mergeStoredOdds } from "./weeklyMulti.js";
import { createWeeklyMultiPreparationHandler } from "./weeklyMultiPreparation.js";
import { activePersonnelRecord, personnelViewFixture, predictionFeatureFixture } from "./personnelTestHelpers.js";
import { fixedTestNow, useFixedTestClock } from "./testClock.js";

useFixedTestClock();
const NOW = fixedTestNow();
const KICKOFF = "2026-10-18T17:00:00Z";
const QUOTE = "2026-10-14T20:00:00Z";
const PAIRS = [["SEA","DEN"],["HOU","JAX"],["CHI","ATL"],["BAL","CLE"],["PIT","TB"],["TEN","IND"],
  ["CAR","PHI"],["NO","NYG"],["NYJ","NE"],["ARI","LAR"],["BUF","LV"],["LAC","KC"],["DAL","GB"],["WSH","SF"]];
const context = { season: 2026, week: 6, lockAt: "2026-10-15T00:00:00Z" };

function fixture([away, home] = PAIRS[0]) {
  const prediction = {
    away: { code: away, score: 30, expectedPoints: 30 },
    home: { code: home, score: 20, expectedPoints: 20 },
    awayWinProbability: .8, homeWinProbability: .2, confidenceScore: .8,
  };
  const players = Array.from({ length: 10 }, (_, index) => ({
    playerName: `Eligible Player${index}`, playerId: `${away}-player-${index}`,
    personnelId: `${away}-player-${index}`, team: away, position: "WR",
    receivingYards: 100 + index, rushingYards: 60, roleConfidence: .9, dataQuality: .9,
    anytimeTouchdownProbability: .8, personnel: { eligible: true },
  }));
  const markets = [
    { key: "h2h", outcomes: [{ name: away, price: 100 }, { name: home, price: -110 }] },
    { key: "spreads", outcomes: [{ name: away, point: 3.5, price: -110 }, { name: home, point: -3.5, price: -110 }] },
    { key: "totals", outcomes: [{ name: "Over", point: 40.5, price: -110 }, { name: "Under", point: 40.5, price: -110 }] },
    ...players.map(p => ({ key: "player_reception_yds", outcomes: [
      { name: "Over", playerName: p.playerName, point: 40.5, price: -110 },
      { name: "Under", playerName: p.playerName, point: 40.5, price: -110 },
    ] })),
  ];
  const oddsEvent = { id: away, away_team: away, home_team: home, commence_time: KICKOFF,
    bookmakers: [{ key: "book", title: "Book", last_update: QUOTE,
      markets: markets.map(m => ({ ...m, last_update: QUOTE })) }] };
  const cutoff = dataset.metricsByWeek[6][away].expectedLineup.cutoff;
  const feature = predictionFeatureFixture(away, home, 2026, 6, cutoff, {
    away: players.map((player) => activePersonnelRecord(player.personnelId, away)),
  });
  const dataQuality = { playByPlay: true, teamForm: true, personnel: true,
    sources: { odds: { available: true }, opponentNetwork: { available: true } }, personnelTiming: { cutoff } };
  prediction.matchupIntelligence = feature.predictionPayloadFeatures;
  prediction.modelLayers = { opponentNetwork: feature.predictionPayloadFeatures.opponentNetwork };
  return { ...feature, game: { away, home, season: 2026, week: 6 }, prediction, playerProjections: players,
    personnelViews: feature.personnelViews, oddsEvent, dataQuality,
    teamMetrics: { away: { team: away, ...dataset.metricsByWeek[6][away] },
      home: { team: home, ...dataset.metricsByWeek[6][home] } },
    asOf: new Date(Date.parse(cutoff) - 1000).toISOString(), quoteAsOf: NOW };
}

function snapshot(input, bestBets = buildBestBets(input)) {
  return { ...context, awayCode: input.game.away, homeCode: input.game.home, kickoff: KICKOFF,
    fourthDownPick: input.game.away, fourthDownAwayScore: 30, fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: .8, fourthDownHomeWinProbability: .2, confidenceScore: .8,
    modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY, authoritative: true,
    predictionFeatureVersion: input.predictionFeatureVersion,
    opponentNetworkStatus: input.opponentNetworkStatus,
    personnelVersion: input.personnelVersion,
    personnelViews: input.personnelViews,
    predictionPayload: input.prediction, playerProjections: { available: true, away: { players: input.playerProjections } },
    dataQuality: input.dataQuality, bestBets, generatedAt: NOW.toISOString(), game: input.game };
}

test("all 14 Week 6 games evaluate team and player markets using verified dated lineups", () => {
  for (const pair of PAIRS) {
    const input = fixture(pair), result = buildBestBets({ ...input, audit: true });
    assert.ok(result.candidates.length > 0, `${pair.join("@")} ${JSON.stringify({
      diagnostics: result.marketDiagnostics,
      rejections: result.assessments?.filter((row) => row.rejectionReasons?.length).map((row) => ({
        player: row.playerName, reasons: row.rejectionReasons,
      })).slice(0, 3),
      dataQuality: input.dataQuality,
    })}`);
    assert.ok(result.candidates.some(b => b.market === "Moneyline"));
    assert.ok(result.candidates.some(b => b.market === "Spread"));
    assert.ok(result.candidates.some(b => b.market === "Game total"));
    assert.ok(result.candidates.some(b => b.market === "Receiving yards"));
    assert.ok(result.assessments.length >= 26);
    assert.equal(input.dataQuality.personnel, true);
  }
});

test("missing, future, wrong-week or mismatched lineup evidence cannot bypass personnel readiness", () => {
  for (const defect of ["missing", "future", "week", "team", "cutoff"]) {
    const input = fixture();
    input.dataQuality.personnel = false;
    input.teamMetrics = structuredClone(input.teamMetrics);
    if (defect === "missing") delete input.teamMetrics.home;
    if (defect === "future") input.teamMetrics.away.expectedLineup.snapshotAt =
      new Date(Date.parse(input.dataQuality.personnelTiming.cutoff) + 15 * 60000).toISOString();
    if (defect === "week") input.teamMetrics.away.expectedLineup.predictionWeek = 7;
    if (defect === "team") input.teamMetrics.away.team = "KC";
    if (defect === "cutoff") input.dataQuality.personnelTiming.cutoff = "2026-10-17T00:00:00Z";
    assert.equal(buildBestBets(input).candidates.length, 0, defect);
  }
});

test("lineup observations are inclusive at cutoff and reject one millisecond or fifteen minutes after it", () => {
  for (const [offset, eligible] of [[-1, true], [0, true], [1, false], [15 * 60000, false]]) {
    const input = fixture();
    input.dataQuality.personnel = false;
    input.teamMetrics = structuredClone(input.teamMetrics);
    const cutoff = Date.parse(input.dataQuality.personnelTiming.cutoff);
    input.asOf = new Date(cutoff).toISOString();
    input.teamMetrics.away.expectedLineup.snapshotAt = new Date(cutoff + offset).toISOString();
    assert.equal(buildBestBets(input).candidates.length > 0, eligible, `${offset}ms`);
  }
});

test("missing core data and existing role/quality floors continue to withhold candidates", () => {
  for (const key of ["teamForm", "playByPlay"]) {
    const input = fixture(); input.dataQuality[key] = false;
    assert.equal(buildBestBets(input).candidates.length, 0);
  }
  const input = fixture();
  for (const p of input.playerProjections) p.roleConfidence = .54;
  assert.ok(buildBestBets(input).candidates.every(b => b.category === "Game"));
  for (const p of input.playerProjections) { p.roleConfidence = .9; p.dataQuality = .49; }
  assert.ok(buildBestBets(input).candidates.every(b => b.category === "Game"));
});

test("scenario quotes exercise candidate eligibility at Out, Questionable and Unknown statuses", () => {
  const input = fixture(["HOU", "JAX"]);
  const target = input.playerProjections[0];
  const record = input.personnelViews.away.players.find((player) => player.canonicalId === target.personnelId);
  assert.ok(record);
  const baselineBets = buildBestBets(input);
  const candidateKey = (candidate) => `${candidate.personnelId}:${candidate.market}:${candidate.selection}`;
  const baselineKeys = baselineBets.candidates.map(candidateKey).sort();
  const targetCandidates = baselineBets.candidates.filter((candidate) =>
    candidate.personnelId === target.personnelId);
  assert.ok(targetCandidates.length > 0, "quoted player markets qualify at baseline");
  const probabilityAndValue = targetCandidates.map(({ modelProbability, expectedValue, edge }) => ({
    modelProbability, expectedValue, edge,
  }));

  for (const status of ["Out", "Doubtful", "Unknown"]) {
    record.status = status;
    record.statusKnown = status !== "Unknown";
    record.projectedAvailable = status !== "Out" && status !== "Doubtful";
    record.propEligible = false;
    const bets = buildBestBets(input);
    assert.equal(bets.candidates.some((candidate) => candidate.personnelId === target.personnelId), false, status);
    assert.deepEqual(bets.candidates.map(candidateKey).sort(),
      baselineKeys.filter((key) => !targetCandidates.some((candidate) => candidateKey(candidate) === key)).sort(),
      `${status} removes only that player's baseline candidate(s)`);
    const saved = snapshot(input, bets);
    const selection = buildWeeklyMultiSelection([saved], { cacheStatus: "fresh", events: [input.oddsEvent] }, context, NOW);
    assert.equal(selection.legs.some((leg) => leg.personnelId === target.personnelId), false, status);
  }

  Object.assign(record, {
    status: "Questionable", statusKnown: true, projectedAvailable: true, propEligible: true,
  });
  const questionableBets = buildBestBets(input);
  const questionableCandidates = questionableBets.candidates.filter((candidate) =>
    candidate.personnelId === target.personnelId);
  assert.deepEqual(questionableCandidates.map(({ modelProbability, expectedValue, edge }) => ({
    modelProbability, expectedValue, edge,
  })), probabilityAndValue, "Best Bets applies no second medical probability deduction");
  assert.deepEqual(questionableBets.candidates.map(candidateKey).sort(), baselineKeys);
  const onlyTargetBets = { ...questionableBets, candidates: questionableCandidates, recommendations: questionableCandidates };
  const questionableSelection = buildWeeklyMultiSelection(
    [snapshot(input, onlyTargetBets)],
    { cacheStatus: "fresh", events: [input.oddsEvent] }, context, NOW,
  );
  for (const bet of questionableCandidates) {
    const leg = questionableSelection.legs.find((candidate) => candidate.personnelId === target.personnelId &&
      candidate.market === bet.market && candidate.selection === bet.selection);
    assert.ok(leg, "Questionable candidate enters the ordinary Weekly Multi consideration path");
    assert.ok(Math.abs(leg.modelProbability - bet.modelProbability) <= 0.0001);
    assert.ok(Math.abs(leg.expectedValue - bet.expectedValue) <= 0.0001);
  }
  assert.deepEqual(questionableCandidates.map(candidateKey),
    baselineBets.candidates.filter((candidate) => candidate.personnelId === target.personnelId).map(candidateKey));
});

test("Nico Collins availability Unknown preserves his HOU identity and emits an availability diagnostic", () => {
  const input = fixture(["HOU", "JAX"]);
  const target = input.playerProjections[0];
  const previousName = target.playerName;
  const oldId = target.personnelId;
  const nicoId = dataset.metricsByWeek[6].HOU.expectedLineup.roster
    .find((player) => player.name === "Nico Collins").gsisId;
  const nicoRecord = input.personnelViews.away.players
    .find((player) => player.canonicalId === oldId);
  target.playerName = "Nico Collins";
  target.playerId = nicoId;
  target.personnelId = nicoId;
  target.team = "HOU";
  target.position = "WR";
  nicoRecord.canonicalId = nicoId;
  nicoRecord.name = "Nico Collins";
  nicoRecord.team = "HOU";
  nicoRecord.position = "WR";
  nicoRecord.status = "Unknown";
  nicoRecord.statusKnown = false;
  nicoRecord.projectedAvailable = true;
  nicoRecord.propEligible = false;
  for (const market of input.oddsEvent.bookmakers[0].markets) {
    for (const outcome of market.outcomes) {
      if (outcome.playerName === previousName) outcome.playerName = "Nico Collins";
    }
  }

  const result = buildBestBets({ ...input, audit: true });
  assert.equal(nicoRecord.name, "Nico Collins");
  assert.equal(nicoRecord.team, "HOU");
  assert.equal(nicoRecord.position, "WR");
  assert.equal(nicoRecord.status, "Unknown");
  assert.equal(nicoRecord.statusKnown, false);
  assert.equal(result.candidates.some((candidate) => candidate.personnelId === nicoId), false);
  assert.ok(result.assessments.some((assessment) =>
    assessment.playerName === "Nico Collins" &&
    assessment.rejectionReasons.includes("unknown_availability")));
});

test("Best Bets rejects a supported projection when its team is outside the game context", () => {
  const input = fixture(["NYG", "KC"]);
  const foreignId = "00-0041251";
  const target = input.playerProjections[0];
  const oldName = target.playerName;
  Object.assign(target, {
    playerName: "Jalon Daniels", playerId: foreignId, personnelId: foreignId,
    team: "TB", position: "QB", passingYards: 200, roleConfidence: .9, dataQuality: .9,
  });
  input.personnelViews.tampa = {
    team: "TB",
    players: [activePersonnelRecord(foreignId, "TB")],
  };
  for (const market of input.oddsEvent.bookmakers[0].markets) {
    for (const outcome of market.outcomes) {
      if (outcome.playerName === oldName) outcome.playerName = "Jalon Daniels";
    }
  }
  const result = buildBestBets({ ...input, audit: true });
  assert.equal(result.candidates.some((candidate) => candidate.personnelId === foreignId), false);
  assert.ok(result.assessments.some((assessment) =>
    assessment.playerName === "Jalon Daniels" &&
    assessment.rejectionReasons.includes("player_team_mismatch")));
});

test("NE moneyline never borrows New York Jets price through a substring", () => {
  const input = fixture(["NYJ", "NE"]);
  input.prediction.awayWinProbability = .15;
  input.prediction.homeWinProbability = .85;
  input.oddsEvent.bookmakers[0].markets[0].outcomes = [
    { name: "New York Jets", price: 280 }, { name: "New England Patriots", price: -350 },
  ];
  const bets = buildBestBets({ ...input, audit: true });
  const ne = bets.assessments.find(b => b.market === "Moneyline" && b.selection === "NE");
  assert.equal(ne.price, -350);
  assert.ok(ne.decimalOdds < 1.3);
  assert.equal(bets.assessments.find(b => b.selection === "NYJ").price, 280);
});

test("full qualified pool survives database round-trip beyond UI player and team limits", () => {
  const input = fixture(), bets = buildBestBets(input);
  assert.equal(bets.recommendations.length, 7);
  assert.equal(bets.candidates.length, 13);
  assert.equal(bets.candidateVersion, BEST_BETS_CANDIDATE_VERSION);
  const saved = databaseToSnapshot(snapshotToDatabase(snapshot(input, bets)));
  assert.deepEqual(saved.bestBets.candidates, bets.candidates);
  assert.equal(saved.bestBets.candidates.filter(b => b.category === "Game").length, 3);
});

test("best five distinct games win without receiving/rushing family quotas", () => {
  const inputs = PAIRS.slice(0, 6).map(pair => fixture(pair));
  const snapshots = inputs.map((input, index) => {
    const s = snapshot(input);
    const market = index < 3 ? "Receiving yards" : "Rushing yards";
    const key = index < 3 ? "player_reception_yds" : "player_rush_yds";
    const bet = { ...s.bestBets.candidates.find(b => b.market === "Receiving yards"),
      market, modelProbability: .9 - index * .03 };
    s.bestBets = { candidates: [bet], recommendations: [] };
    input.oddsEvent.bookmakers[0].markets = [{ key, outcomes: [
      { name: "Over", playerName: "Eligible Player0", point: bet.line, price: -110 },
    ] }];
    s.bestBets.candidates[0].selection = "Eligible Player0 Over 40.5 receiving yards";
    return s;
  });
  const payload = { cacheStatus: "fresh", events: inputs.map(i => i.oddsEvent) };
  const result = buildWeeklyMultiSelection(snapshots, payload, context, NOW);
  assert.equal(result.legs.length, 5);
  assert.equal(result.complete, true);
  assert.equal(new Set(result.legs.map(b => b.matchupKey)).size, 5);
  assert.equal(result.legs.filter(b => b.marketFamily === "receiving-props").length, 3);
  assert.equal(result.legs.filter(b => b.marketFamily === "rushing-props").length, 2);
  assert.deepEqual(buildWeeklyMultiSelection([...snapshots].reverse(), payload, context, NOW).legs, result.legs);
});

test("team markets coexist with props and Game total and signed spreads match stored markets", () => {
  const inputs = PAIRS.slice(0, 5).map(pair => fixture(pair));
  const markets = ["Moneyline", "Spread", "Game total", "Receiving yards", "Receiving yards"];
  const snapshots = inputs.map((input, index) => {
    const s = snapshot(input);
    s.bestBets = { recommendations: [], candidates: s.bestBets.candidates.filter(b => b.market === markets[index]).slice(0, 1) };
    return s;
  });
  const result = buildWeeklyMultiSelection(snapshots, { events: inputs.map(i => i.oddsEvent) }, context, NOW);
  assert.equal(result.legs.length, 5);
  assert.equal(result.legs.filter(b => b.marketFamily === "receiving-props").length, 2);
});

test("55% floor and positive priced edge remain hard limits; invalid prices cannot create bets", () => {
  const input = fixture();
  for (const value of [null, undefined, 0, Infinity, NaN]) {
    const bad = structuredClone(input);
    for (const m of bad.oddsEvent.bookmakers[0].markets) for (const o of m.outcomes) o.price = value;
    assert.equal(buildBestBets(bad).candidates.length, 0);
  }
  const s = snapshot(input);
  for (const probability of [.5499, .5]) {
    const bet = s.bestBets.candidates.find(b => b.market === "Moneyline");
    s.bestBets = { candidates: [{ ...bet, modelProbability: probability }], recommendations: [] };
    const result = buildWeeklyMultiSelection([s], { events: [input.oddsEvent] }, context, NOW);
    assert.equal(result.legs.length, 0);
    assert.equal(result.threshold, .55);
  }
});

test("candidate-only repair preserves saved scores/version/time and cannot modify frozen records", () => {
  const input = fixture(), old = snapshot(input);
  delete old.bestBets.candidateVersion;
  delete old.bestBets.candidates;
  const repaired = refreshSavedBestBets(old, { events: [input.oddsEvent] }, NOW);
  for (const key of ["predictionPayload", "playerProjections", "generatedAt", "modelVersion",
    "fourthDownAwayScore", "fourthDownHomeScore"]) assert.deepEqual(repaired[key], old[key]);
  assert.ok(repaired.bestBets.candidates.length > repaired.bestBets.recommendations.length);
  assert.equal(retainPrediction(old, repaired, NOW, true), false);
  assert.equal(retainPrediction(old, repaired, NOW, false), true);
  assert.equal(retainPrediction({ ...old, frozenAt: NOW.toISOString() }, repaired, NOW, true), true);
  assert.equal(retainPrediction(old, { ...repaired, fourthDownAwayScore: 31 }, NOW, true), true);
  assert.throws(() => refreshSavedBestBets({ ...old, kickoff: "2026-10-14T00:00:00Z" },
    { events: [input.oddsEvent] }, NOW), /pre-kickoff/);
});

test("server persistence accepts candidate-only upgrades once and retains the entire qualified pool", async () => {
  const input = fixture(), old = snapshot(input);
  delete old.bestBets.candidateVersion;
  const upgraded = refreshSavedBestBets(old, { events: [input.oddsEvent] }, NOW);
  let row = { ...snapshotToDatabase(old), id: "saved", updated_at: "old" }, writes = 0;
  const client = { from() { return {
    select() { return this; }, eq() { return this; }, is() { return this; },
    update(value) { row = { ...row, ...value }; writes++; return this; },
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
  }; } };
  await saveAuthoritativePrediction(client, upgraded, NOW);
  await saveAuthoritativePrediction(client, upgraded, NOW);
  assert.equal(writes, 1);
  assert.deepEqual(databaseToSnapshot(row).bestBets.candidates, upgraded.bestBets.candidates);
});

test("stored Baltimore props retain canonical kickoff across books and market ordering, without cross-matching games", async () => {
  const row = (market_type, event_start_time, extra = {}) => ({
    event_id: "bal-cle", away_team: "Baltimore Ravens", home_team: "Cleveland Browns",
    market_type, event_start_time, sportsbook: "Book", odds_american: -110,
    selection: "Over", selection_type: "over", player_name: "Lamar Jackson",
    line: 220.5, timestamp: QUOTE, ...extra,
  });
  const snapshots = [
    { market: "moneyline", fetched_at: QUOTE, rows: [row("moneyline", KICKOFF, { selection_type: "home" })] },
    { market: "point_spread", fetched_at: QUOTE, rows: [row("point_spread", KICKOFF, { selection_type: "home", line: -3.5 })] },
    { market: "total_points", fetched_at: QUOTE, rows: [row("total_points", KICKOFF, { line: 40.5 })] },
    { market: "player_pass_yds", fetched_at: QUOTE, rows: [row("player_passing_yards", "2026-10-18T17:01:00Z")] },
    { market: "player_completions", fetched_at: QUOTE, rows: [row("player_passing_completions", KICKOFF, { line: 20.5 })] },
  ];
  const client = { from() { return { select() { return this; }, eq() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: snapshots, error: null }).then(resolve, reject); } }; } };
  async function read(url) {
    let result;
    await handleOddsRequest({ method: "GET", url }, {
      setHeader() {}, status() { return this; }, json(body) { result = body; },
    }, { client, now: NOW.getTime() });
    return result;
  }
  const merged = mergeStoredOdds(await read("/api/nfl/odds"), await read("/api/nfl/odds?props=1&source=snapshot"));
  assert.equal(Date.parse(merged.events[0].commence_time), Date.parse(KICKOFF));
  assert.ok(merged.events[0].bookmakers[0].markets.some(m => m.key === "player_pass_yds"));
  assert.ok(merged.events[0].bookmakers[0].markets.some(m => m.key === "player_completions"));
  const other = await read("/api/nfl/odds");
  other.events[0].commence_time = "2026-10-25T17:00:00Z";
  assert.equal(mergeStoredOdds(other, await read("/api/nfl/odds?props=1&source=snapshot")).events[0].bookmakers[0].markets.length,
    other.events[0].bookmakers[0].markets.length);
});

test("available verified-QB passing markets are evaluated and absent projections are not fabricated", () => {
  const input = fixture(["BUF", "LV"]);
  const qb = { playerName: "Josh Allen", position: "QB", team: "BUF", passingYards: 280,
    playerId: "buf-josh-allen", personnelId: "buf-josh-allen",
    personnel: { eligible: true }, passingTouchdowns: 2.5, completions: 28,
    roleConfidence: .9, dataQuality: .9 };
  input.playerProjections.push(qb);
  input.personnelViews.away.players.push(activePersonnelRecord(qb.personnelId, "BUF"));
  for (const [key, line] of [["player_pass_yds",220.5],["player_pass_tds",1.5],["player_completions",20.5]]) {
    input.oddsEvent.bookmakers[0].markets.push({ key, last_update: QUOTE,
      outcomes: [{ playerName: "Josh Allen", name: "Over", point: line, price: -110 }] });
  }
  assert.equal(buildBestBets(input).candidates.filter(b => b.category === "Passing props").length, 3);
  qb.passingYards = null; qb.passingTouchdowns = null; qb.completions = null;
  const result = buildBestBets({ ...input, audit: true });
  assert.equal(result.candidates.filter(b => b.category === "Passing props").length, 0);
  assert.ok(result.assessments.filter(b => b.playerName === "Josh Allen").every(b =>
    b.rejectionReasons.includes("missing_projection")));
  input.prediction = {};
  assert.ok(buildBestBets(input).candidates.every(b => b.category !== "Game"));
});

test("preparation audits all 14 saved games without regenerating scores or writing during dry run", async () => {
  const inputs = PAIRS.map(pair => fixture(pair));
  const stored = inputs.map(input => {
    const s = snapshot(input); delete s.bestBets.candidateVersion; delete s.bestBets.candidates;
    return snapshotToDatabase(s);
  });
  const refreshed = [];
  const client = { from(table) { return {
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: null, error: null }),
    then(resolve, reject) {
      assert.equal(table, "prediction_snapshots");
      return Promise.resolve({ data: stored, error: null }).then(resolve, reject);
    },
  }; } };
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-secret";
  let body;
  try {
    await createWeeklyMultiPreparationHandler({
      getNow: () => NOW, createClient: () => client, report() {},
      resolveContext: async () => ({ ...context, available: true, eligible: true,
        games: PAIRS.map(([away, home]) => ({ season: 2026, week: 6, date: KICKOFF,
          visitor_team: { abbreviation: away }, home_team: { abbreviation: home } })) }),
      readOdds: async () => ({ cacheStatus: "fresh", events: inputs.map(i => i.oddsEvent) }),
      refreshBestBets(s, odds, now) { refreshed.push(s.awayCode); return refreshSavedBestBets(s, odds, now); },
      generatePrediction: async () => assert.fail("Saved scores must not regenerate"),
      savePrediction: async () => assert.fail("Dry run must not persist"),
    })({ method: "GET", headers: { authorization: "Bearer test-secret" },
      query: { weeklyMultiMode: "lock", dryRun: "1" } },
    { setHeader() {}, status(code) { assert.equal(code, 200); return this; }, json(value) { body = value; } });
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
  }
  assert.equal(new Set(refreshed).size, 14);
  assert.equal(body.reusedPredictions, 14);
  assert.equal(body.generatedPredictions, 0);
  assert.equal(body.legCount, 5);
});
