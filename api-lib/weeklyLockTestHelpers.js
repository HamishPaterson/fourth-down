import { predictionFeatureFixture } from "./personnelTestHelpers.js";
import { CURRENT_MODEL_KEY, CURRENT_MODEL_VERSION } from "../src/services/modelIdentity.js";

export const FUTURE_LOCK = "2026-10-29T00:00:00.000Z";
export const PREPARED_AT = "2026-10-28T23:00:00.000Z";
export const PAIRS = [["NE", "CHI"], ["PIT", "NO"], ["SF", "ATL"], ["CLE", "TEN"], ["IND", "MIN"]];

export function lockFixture() {
  const games = PAIRS.map(([away, home]) => ({ away, home, kickoff: "2026-10-30T00:15:00Z" }));
  const plan = { id: "00000000-0000-4000-8000-000000000001", season: 2026, week: 8,
    lock_at: FUTURE_LOCK, source: "server-prepared", prepared_at: PREPARED_AT,
    expected_game_count: games.length, games };
  const predictions = games.map((game, index) => {
    const features = predictionFeatureFixture(game.away, game.home, 2026, 8, game.kickoff);
    const bet = { market: "Moneyline", category: "Game", selection: game.away, sportsbook: "Book",
      price: 100, decimalOdds: 2, modelProbability: .7, updatedAt: PREPARED_AT, quoteId: `q${index}` };
    return {
      id: `prediction-${index}`, season: 2026, week: 8, awayCode: game.away, homeCode: game.home,
      kickoff: game.kickoff, generatedAt: PREPARED_AT, authoritative: true,
      lockProvenance: { version: 1, source: "server-prepared", predictionId: `prediction-${index}`,
        generationCutoff: FUTURE_LOCK, inputs: [{ source: "playByPlay", observedAt: PREPARED_AT }], marketDependencies: [] },
      modelKey: CURRENT_MODEL_KEY, modelVersion: CURRENT_MODEL_VERSION, ...features,
      fourthDownPick: game.away, fourthDownAwayScore: 24, fourthDownHomeScore: 20,
      fourthDownAwayWinProbability: .7, fourthDownHomeWinProbability: .3, confidenceScore: .7,
      predictionPayload: { modelLayers: { opponentNetwork: features.predictionPayloadFeatures.opponentNetwork },
        matchupIntelligence: features.predictionPayloadFeatures },
      playerProjections: { available: true, away: { players: [] }, home: { players: [] } },
      dataQuality: { sources: { odds: { available: true } }, personnelTiming: { cutoff: game.kickoff } },
      bestBets: { assessed: 1, recommendations: [bet], candidates: [bet] },
    };
  });
  const odds = { cacheStatus: "stale-fallback", refreshedAt: "2026-10-27T10:00:00Z",
    events: games.map((game, index) => ({
      id: `game${index}`, away_team: game.away, home_team: game.home, commence_time: game.kickoff,
      bookmakers: [{ key: "book", title: "Book", last_update: PREPARED_AT, markets: [
        { key: "h2h", outcomes: [{ name: game.away, price: 100, updatedAt: PREPARED_AT,
          quoteSource: { id: `q${index}`, provider: "SharpAPI", timestamp: PREPARED_AT, fetchedAt: PREPARED_AT } }] },
        { key: "spreads", outcomes: [{ name: game.away, price: -110, point: -2.5, updatedAt: PREPARED_AT,
          quoteSource: { id: `spread${index}`, provider: "SharpAPI", timestamp: PREPARED_AT, fetchedAt: PREPARED_AT } }] },
        { key: "totals", outcomes: [{ name: "Over", point: 44.5, price: -110, updatedAt: "2026-10-27T10:00:00Z" }] },
      ] }],
    })) };
  return { plan, predictions, odds, now: new Date(FUTURE_LOCK) };
}

export function lockDatabase(fixture = lockFixture(), { failTable, existing = [] } = {}) {
  const tables = {
    weekly_multi_lock_plans: fixture.plan ? [structuredClone(fixture.plan)] : [],
    prediction_snapshots: fixture.predictions.map((row) => ({ id: row.id, season: row.season, week: row.week,
      data_quality: { snapshot: structuredClone(row) } })),
    weekly_best_multis: structuredClone(existing),
    weekly_multi_lock_manifests: [], weekly_multi_lock_executions: [],
  };
  const writes = [];
  return {
    tables, writes,
    from(table) {
      let insert;
      const filters = [];
      const execute = async (single = false) => {
        if (table === failTable) return { data: null, error: { code: "TEST_FAILURE", message: "secret-remote-error" } };
        if (insert) {
          if (table === "weekly_best_multis" && tables[table].some((row) => row.lock_at === insert.lock_at)) {
            return { data: null, error: { code: "23505" } };
          }
          tables[table].push(structuredClone(insert));
          writes.push({ table, row: structuredClone(insert) });
          return { data: single ? insert : [insert], error: null };
        }
        const rows = tables[table].filter((row) => filters.every(([key, value]) => row[key] === value));
        return { data: single ? rows[0] || null : rows, error: null };
      };
      return {
        select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
        insert(value) { insert = value; return this; },
        single() { return execute(true); }, maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
    },
  };
}

export function lockResponse() {
  return { statusCode: 200, body: null, setHeader() {},
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
