import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { InMemoryOddsRepository, deduplicateQuotes } from "./inMemoryRepository.js";
import {
  assessCompleteness,
  isCompleteResponse,
} from "./completeness.js";
import {
  canSpendCredits,
  estimateProviderCredits,
  readCreditConfiguration,
} from "./creditLedger.js";
import {
  DEFAULT_CORE_MARKETS,
  PARLAY_MARKET_MAP,
  createParlayProvider,
  normalizeAmericanPrice,
} from "./parlay.js";
import { isEligibleBettingQuote, PLAYER_MATCH, resolvePlayerIdentity } from "./playerResolver.js";
import {
  createLockedQuoteSnapshot,
  createProviderRegistry,
  normalizeEventIdentity,
  quoteSnapshotKey,
  selectProviderResult,
} from "./contracts.js";

const FIXED_NOW = new Date("2026-10-22T01:00:00.000Z");
const FIXED_EVENT = {
  canonical_event_id: "event-123",
  season: 2026,
  week: 7,
  commence_time: "2026-10-23T00:15:00.000Z",
  home_team: "Chicago Bears",
  away_team: "New England Patriots",
};
const PLAYERS = [
  { gsisId: "00-0039918", playerName: "Caleb Williams", team: "CHI" },
  { gsisId: "00-0039999", playerName: "Caleb Williams Jr.", team: "NYG" },
  { gsisId: "00-0040001", playerName: "C. Williams", team: "CHI" },
  { gsisId: "00-0040002", playerName: "A.J. Brown", team: "PHI" },
];

function response(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completeHeaders() {
  return {
    "x-result-has-more": "false",
    "x-result-truncated": "false",
    "x-result-degraded": "false",
  };
}

function makeProvider({ fetchImpl, repository = new InMemoryOddsRepository(), aliases, creditConfiguration } = {}) {
  return {
    repository,
    provider: createParlayProvider({
      fetchImpl,
      repository,
      aliases,
      now: () => new Date(FIXED_NOW),
      timeoutMs: 1000,
      creditConfiguration: creditConfiguration || { monthlyLimit: 100, automaticBudget: 50 },
    }),
  };
}

test("American prices convert deterministically and invalid values are rejected", () => {
  assert.deepEqual(normalizeAmericanPrice(150), {
    americanOdds: 150,
    decimalOdds: 2.5,
    impliedProbability: 0.4,
  });
  assert.deepEqual(normalizeAmericanPrice(-200), {
    americanOdds: -200,
    decimalOdds: 1.5,
    impliedProbability: 2 / 3,
  });
  for (const invalid of [null, undefined, "", "abc", NaN, Infinity, 0, 99, -99, 1.5]) {
    assert.equal(normalizeAmericanPrice(invalid), null);
  }
});

test("provider exposes stable capabilities, default core markets, and the explicit primary selection", () => {
  const repository = new InMemoryOddsRepository();
  const provider = createParlayProvider({ repository, fetchImpl: async () => response([]) });
  assert.equal(provider.id, "parlay");
  assert.equal(provider.primary, true);
  assert.deepEqual([...DEFAULT_CORE_MARKETS], ["h2h", "spreads", "totals"]);
  assert.deepEqual(Object.keys(provider.capabilities).sort(), [
    "fetchCoreOdds",
    "fetchPlayerProps",
    "listEvents",
    "normalizeCoreOdds",
    "normalizePlayerProps",
    "reportCreditCost",
  ].sort());
  assert.equal(provider.reportCreditCost({ endpoint: "events" }), 0);
  assert.equal(provider.reportCreditCost({ endpoint: "props" }), 3);
});

test("event endpoint normalizes provider and canonical matchup identity without leaking credentials", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  let request;
  const { provider, repository } = makeProvider({
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return response([FIXED_EVENT], { "x-request-id": "request-1" });
    },
  });
  const fetched = await provider.listEvents({ season: 2026, week: 7 });
  const normalized = provider.normalizeEvents(fetched, { season: 2026, week: 7 });
  assert.equal(request.url, "https://parlay-api.com/v1/sports/americanfootball_nfl/events");
  assert.equal(request.init.headers["X-API-Key"], "test-only-secret");
  assert.equal(request.init.redirect, "error");
  assert.equal(fetched.requestId, "request-1");
  assert.equal(normalized.events[0].provider, "parlay");
  assert.equal(normalized.events[0].providerEventId, "event-123");
  assert.equal(normalized.events[0].season, 2026);
  assert.equal(normalized.events[0].week, 7);
  assert.equal(normalized.events[0].homeTeam, FIXED_EVENT.home_team);
  assert.equal(normalized.events[0].awayTeam, FIXED_EVENT.away_team);
  assert.match(normalized.events[0].canonicalMatchupIdentity, /^nfl:2026:7:/);
  assert.equal((await repository.readCreditLedger()).length, 1);
  assert.equal(JSON.stringify(fetched).includes("test-only-secret"), false);
});

test("unmapped events are not assigned the requested season and week", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const normalizedEvents = provider.normalizeEvents({
    events: [{ ...FIXED_EVENT, season: null, week: "" }],
  }, { season: 2026, week: 7 });
  assert.deepEqual(normalizedEvents.events, []);
  assert.deepEqual(normalizedEvents.diagnostics.unmappedEvents, ["event-123"]);

  const normalizedProps = provider.normalizePlayerProps({
    rows: [{
      ...FIXED_EVENT,
      season: null,
      week: "",
      market_key: "player_receptions",
      bookmaker: "book-a",
      player: "Caleb Williams",
      line: 4.5,
      over_price: -110,
      under_price: -110,
    }],
  }, { season: 2026, week: 7, players: PLAYERS });
  assert.deepEqual(normalizedProps.quotes, []);
  assert.deepEqual(normalizedProps.diagnostics.unmappedEvents, [
    { providerEventId: "event-123", rowCount: 1 },
  ]);
});

test("all established raw prop markets map exactly and retain raw provider market", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const rows = Object.keys(PARLAY_MARKET_MAP).map((market_key) => ({
    ...FIXED_EVENT,
    market_key,
    bookmaker: "book-a",
    player: "Caleb Williams",
    line: 0.5,
    over_price: 120,
    under_price: -110,
    last_update: "2026-10-22T00:59:00.000Z",
    age_seconds: 60,
  }));
  const normalized = provider.normalizePlayerProps(
    { rows, fetchedAt: FIXED_NOW.toISOString() },
    { season: 2026, week: 7, players: PLAYERS }
  );
  assert.equal(normalized.quotes.length, Object.keys(PARLAY_MARKET_MAP).length * 2);
  for (const row of rows) {
    const quote = normalized.quotes.find((item) => item.rawProviderMarket === row.market_key);
    assert.equal(quote.market, PARLAY_MARKET_MAP[row.market_key]);
    assert.equal(quote.rawProviderMarket, row.market_key);
    assert.equal(quote.provider, "parlay");
    assert.equal(quote.providerEventId, "event-123");
    assert.equal(quote.bookmaker, "book-a");
    assert.equal(quote.playerId, "00-0039918");
    assert.equal(quote.team, "CHI");
    assert.equal(quote.eligibleForBetting, true);
    assert.equal(quote.freshnessStatus, "fresh");
    assert.equal(quote.rawPrice.value, row.over_price);
  }
});

test("unknown market lookalikes remain separate unless explicitly registered as an alias", () => {
  const row = {
    ...FIXED_EVENT,
    market_key: "player_receiving_yds",
    bookmaker: "book-a",
    player: "Caleb Williams",
    line: 10,
    over_price: -110,
    under_price: -110,
  };
  const defaultProvider = makeProvider({ fetchImpl: async () => response([]) }).provider;
  const unmapped = defaultProvider.normalizePlayerProps({ rows: [row] }, { season: 2026, week: 7 });
  assert.equal(unmapped.quotes.length, 0);
  assert.deepEqual(unmapped.diagnostics.unmappedMarkets, [
    { rawProviderMarket: "player_receiving_yds", rowCount: 1 },
  ]);

  const aliasProvider = makeProvider({
    fetchImpl: async () => response([]),
    aliases: { player_receiving_yds: "receiving_yards" },
  }).provider;
  const aliasQuote = aliasProvider.normalizePlayerProps(
    { rows: [row] },
    { season: 2026, week: 7, players: PLAYERS }
  ).quotes[0];
  assert.equal(aliasQuote.market, "receiving_yards");
  assert.equal(aliasQuote.rawProviderMarket, "player_receiving_yds");
});

test("standard props convert over and under; Anytime TD represents Yes and No and never invents a side", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const rows = [
    {
      ...FIXED_EVENT, market_key: "player_anytime_td", bookmaker: "book-a",
      player: "Caleb Williams", line: 0.5, over_price: 380, under_price: null,
    },
    {
      ...FIXED_EVENT, market_key: "player_receptions", bookmaker: "book-b",
      player: "Caleb Williams", line: 4.5, over_price: -110, under_price: 105,
    },
    {
      ...FIXED_EVENT, market_key: "player_anytime_td", bookmaker: "book-a",
      player: "Caleb Williams", line: 1.5, over_price: 120, under_price: -140,
    },
  ];
  const quotes = provider.normalizePlayerProps(
    { rows },
    { season: 2026, week: 7, players: PLAYERS }
  ).quotes;
  const anytime = quotes.filter((quote) => quote.market === "anytime_td");
  assert.equal(anytime.length, 1);
  assert.deepEqual([anytime[0].selection, anytime[0].side, anytime[0].americanOdds], ["Yes", "yes", 380]);
  assert.equal(quotes.some((quote) => quote.market === "anytime_td" && quote.side === "no"), false);
  const receptions = quotes.filter((quote) => quote.market === "receptions");
  assert.deepEqual(receptions.map((quote) => [quote.side, quote.americanOdds]).sort(), [
    ["over", -110],
    ["under", 105],
  ]);
  assert.equal(receptions.find((quote) => quote.side === "over").impliedProbability, 110 / 210);
});

test("provider player_reference is preserved as opaque provenance and never assumed to be GSIS", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const result = provider.normalizePlayerProps(
    {
      rows: [{
        ...FIXED_EVENT,
        market_key: "player_receptions",
        bookmaker: "book-a",
        player: "Unlisted Player",
        player_reference: "00-0039918",
        line: 3.5,
        over_price: -110,
        under_price: null,
      }],
    },
    { season: 2026, week: 7, players: PLAYERS }
  );
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].providerPlayerReference, "00-0039918");
  assert.equal(result.quotes[0].playerId, null);
  assert.equal(result.quotes[0].playerIdentityStatus, PLAYER_MATCH.UNRESOLVED);
  assert.equal(isEligibleBettingQuote(result.quotes[0]), false);
});

test("DFS-only, invalid, null, and unsupported odds structures produce no fabricated quotes", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const common = {
    ...FIXED_EVENT,
    market_key: "player_receptions",
    bookmaker: "book-a",
    player: "Caleb Williams",
    line: 4.5,
  };
  const rows = [
    { ...common, dfs_normalized: true, over_price: -110, under_price: -110 },
    { ...common, over_price: null, under_price: null, selection_by_side: { over: { payout_multiplier: 1.2 } } },
    { ...common, over_price: -99, under_price: Infinity },
    { ...common, odds_type: "demon", over_price: 115, under_price: null },
  ];
  const quotes = provider.normalizePlayerProps(
    { rows },
    { season: 2026, week: 7, players: PLAYERS }
  ).quotes;
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].americanOdds, 115);
  assert.equal(quotes[0].rawPrice.oddsType, "demon");
  assert.equal(quotes[0].side, "over");
  assert.equal(quotes[0].eligibleForBetting, true);
  assert.equal(isEligibleBettingQuote(quotes[0]), true);
});

test("core event and h2h, spread, and total outcomes normalize without provider market leakage", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const rows = [
    {
      ...FIXED_EVENT,
      bookmakers: [{
        key: "book-a",
        markets: [
          { key: "h2h", outcomes: [{ name: "New England Patriots", price: 125 }, { name: "Chicago Bears", price: -140 }] },
          { key: "spreads", outcomes: [{ name: "New England Patriots", price: -110, point: 3.5 }, { name: "Chicago Bears", price: -110, point: -3.5 }] },
          { key: "totals", outcomes: [{ name: "Over", price: -105, point: 42.5 }, { name: "Under", price: -115, point: 42.5 }] },
        ],
      }],
    },
  ];
  const result = provider.normalizeCoreOdds(
    { rows, fetchedAt: FIXED_NOW.toISOString() },
    { season: 2026, week: 7 }
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].providerEventId, "event-123");
  assert.deepEqual(new Set(result.quotes.map((quote) => quote.market)), new Set(["h2h", "spreads", "totals"]));
  assert.ok(result.quotes.every((quote) => quote.bookmaker === "book-a" && quote.rawProviderMarket));
  assert.ok(result.quotes.find((quote) => quote.market === "totals" && quote.side === "under" && quote.line === 42.5));
  assert.equal(result.quotes.find((quote) => quote.market === "h2h" && quote.selection === "Chicago Bears").team, "CHI");
});

test("player resolver prioritizes compatible stable IDs and exact event name before supported abbreviations", () => {
  assert.equal(resolvePlayerIdentity({
    providerPlayerId: "00-0039918",
    providerIdType: "gsis",
    playerName: "Untrusted Display",
    eventTeams: ["CHI", "NE"],
    players: PLAYERS,
  }).status, PLAYER_MATCH.MATCHED_STABLE_ID);
  assert.equal(resolvePlayerIdentity({
    providerPlayerId: "provider-id",
    playerName: "Caleb Williams",
    eventTeams: ["CHI", "NE"],
    players: PLAYERS,
  }).status, PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT);
  const abbreviated = resolvePlayerIdentity({
    playerName: "C.Williams",
    eventTeams: ["CHI", "NE"],
    players: [{ gsisId: "00-0039918", playerName: "Caleb Williams", team: "CHI" }],
  });
  assert.equal(abbreviated.status, PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT);
  assert.equal(abbreviated.playerId, "00-0039918");
});

test("player resolver preserves suffixes, rejects ambiguity, mismatch, and unresolved identities", () => {
  const matchingSuffix = resolvePlayerIdentity({
    playerName: "Caleb Williams Jr.",
    eventTeams: ["NYG", "DAL"],
    players: [{ gsisId: "00-0039999", playerName: "Caleb Williams Jr.", team: "NYG" }],
  });
  assert.equal(matchingSuffix.status, PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT);

  const abbreviatedSuffix = resolvePlayerIdentity({
    playerName: "C.Williams Jr.",
    eventTeams: ["NYG", "DAL"],
    players: [{ gsisId: "00-0039999", playerName: "Caleb Williams Jr.", team: "NYG" }],
  });
  assert.equal(abbreviatedSuffix.status, PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT);

  const suffixed = resolvePlayerIdentity({
    playerName: "Caleb Williams",
    eventTeams: ["NYG", "DAL"],
    players: [{ gsisId: "00-0039999", playerName: "Caleb Williams Jr.", team: "NYG" }],
  });
  assert.equal(suffixed.status, PLAYER_MATCH.UNRESOLVED);

  const ambiguous = resolvePlayerIdentity({
    playerName: "J. Smith",
    eventTeams: ["CHI", "NE"],
    players: [
      { playerName: "John Smith", team: "CHI" },
      { playerName: "James Smith", team: "NE" },
    ],
  });
  assert.equal(ambiguous.status, PLAYER_MATCH.AMBIGUOUS);

  const mismatch = resolvePlayerIdentity({
    playerName: "Caleb Williams",
    eventTeams: ["CHI", "NE"],
    playerTeam: "NYG",
    players: [{ gsisId: "00-0039918", playerName: "Caleb Williams", team: "CHI" }],
  });
  assert.equal(mismatch.status, PLAYER_MATCH.TEAM_MISMATCH);
  assert.equal(resolvePlayerIdentity({ playerName: "Nobody", eventTeams: ["CHI", "NE"], players: PLAYERS }).status,
    PLAYER_MATCH.UNRESOLVED);
});

test("player matching does not accept a stable identifier outside the event-team context", () => {
  const result = resolvePlayerIdentity({
    providerPlayerId: "00-0039918",
    providerIdType: "gsis_id",
    playerName: "Caleb Williams",
    eventTeams: ["NYG", "DAL"],
    players: PLAYERS,
  });
  assert.equal(result.status, PLAYER_MATCH.TEAM_MISMATCH);
});

test("event teams remain authoritative for supplied teams, artifact teams, names, and stable IDs", async (t) => {
  const chicago = { gsisId: "fixture-chi", playerName: "Caleb Williams", team: "CHI" };
  const newEngland = { gsisId: "fixture-ne", playerName: "Drake Maye", team: "NE" };
  const philadelphia = { gsisId: "fixture-phi", playerName: "A.J. Brown", team: "PHI" };
  const cases = [
    {
      name: "A: out-of-event supplied team cannot be rescued by an exact name",
      input: { playerName: "A.J. Brown", playerTeam: "PHI", players: [philadelphia] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "B: normalized supplied home team agrees with the artifact",
      input: { playerName: "Caleb Williams", playerTeam: "Chicago Bears", players: [chicago] },
      status: PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT,
    },
    {
      name: "C: supplied away team agrees with the artifact",
      input: { playerName: "Drake Maye", playerTeam: "NE", players: [newEngland] },
      status: PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT,
    },
    {
      name: "D: valid supplied team cannot rescue an out-of-event artifact player",
      input: { playerName: "A.J. Brown", playerTeam: "CHI", players: [philadelphia] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "E: missing supplied team allows a unique home-team exact match",
      input: { playerName: "Caleb Williams", players: [chicago] },
      status: PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT,
    },
    {
      name: "F: missing supplied team allows a unique away-team exact match",
      input: { playerName: "Drake Maye", players: [newEngland] },
      status: PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT,
    },
    {
      name: "G: missing supplied team never permits an out-of-event exact match",
      input: { playerName: "A.J. Brown", players: [philadelphia] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "H: normalized name cannot rescue an out-of-event artifact player",
      input: { playerName: "C. Williams", players: [{ ...chicago, team: "PHI" }] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "I: a genuine stable ID cannot rescue an out-of-event artifact player",
      input: { providerPlayerId: "fixture-phi", providerIdType: "gsis", players: [philadelphia] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "J: multiple normalized event-compatible candidates remain ambiguous",
      input: {
        playerName: "J. Smith",
        players: [{ playerName: "John Smith", team: "CHI" }, { playerName: "James Smith", team: "NE" }],
      },
      status: PLAYER_MATCH.AMBIGUOUS,
    },
    {
      name: "unknown player remains unresolved",
      input: { playerName: "Unknown Player", players: [chicago, newEngland] },
      status: PLAYER_MATCH.UNRESOLVED,
    },
    {
      name: "valid normalized event match remains eligible",
      input: { playerName: "C. Williams", playerTeam: "CHI", players: [chicago] },
      status: PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT,
    },
    {
      name: "supplied team and artifact team must agree even within the event",
      input: { playerName: "Drake Maye", playerTeam: "CHI", players: [newEngland] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "stable ID must agree with the supplied event-compatible team",
      input: { providerPlayerId: "fixture-ne", providerIdType: "gsis", playerTeam: "CHI", players: [newEngland] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "stable ID without event context cannot become eligible",
      input: { providerPlayerId: "fixture-chi", providerIdType: "gsis", eventTeams: [], players: [chicago] },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
    {
      name: "suffix normalization cannot expand event eligibility",
      input: {
        playerName: "C. Williams Jr.",
        players: [{ ...chicago, playerName: "Caleb Williams Jr.", team: "PHI" }],
      },
      status: PLAYER_MATCH.TEAM_MISMATCH,
    },
  ];
  for (const { name, input, status } of cases) {
    await t.test(name, () => {
      const result = resolvePlayerIdentity({ eventTeams: ["CHI", "NE"], ...input });
      assert.equal(result.status, status);
      const eligible = status.startsWith("MATCHED_");
      assert.equal(isEligibleBettingQuote({
        playerName: input.playerName || result.playerName || "Fixture Player",
        playerIdentityStatus: result.status,
        eligibleForBetting: true,
      }), eligible);
      if (eligible) {
        assert.ok(["CHI", "NE"].includes(result.team));
      } else {
        assert.equal(result.playerId, null);
        assert.equal(result.team, null);
      }
    });
  }
});

test("Parlay normalization keeps an out-of-event supplied player team ineligible", () => {
  const { provider } = makeProvider({ fetchImpl: async () => response([]) });
  const result = provider.normalizePlayerProps({
    rows: [{
      ...FIXED_EVENT,
      market_key: "player_receptions",
      bookmaker: "book-a",
      player: "A.J. Brown",
      player_team: "PHI",
      line: 4.5,
      over_price: -110,
      under_price: -110,
    }],
  }, { season: 2026, week: 7, players: PLAYERS });
  assert.equal(result.quotes.length, 2);
  for (const quote of result.quotes) {
    assert.equal(quote.playerIdentityStatus, PLAYER_MATCH.TEAM_MISMATCH);
    assert.equal(quote.playerId, null);
    assert.equal(quote.eligibleForBetting, false);
    assert.equal(isEligibleBettingQuote(quote), false);
  }
});

test("quote keys preserve bookmaker, raw market, player, selection, and alternate line identity", () => {
  const base = {
    provider: "parlay",
    season: 2026,
    week: 7,
    providerEventId: "event-123",
    bookmaker: "book-a",
    market: "receiving_yards",
    rawProviderMarket: "player_receiving_yards",
    playerName: "Player One",
    selection: "over",
    side: "over",
    line: 45.5,
  };
  const keys = [
    quoteSnapshotKey(base),
    quoteSnapshotKey({ ...base, bookmaker: "book-b" }),
    quoteSnapshotKey({ ...base, line: 50.5 }),
    quoteSnapshotKey({ ...base, rawProviderMarket: "player_rec_yds" }),
  ];
  assert.equal(new Set(keys).size, 4);
  assert.equal(deduplicateQuotes([base, { ...base, americanOdds: -120 }]).length, 1);
});

test("completeness requires all three headers and never upgrades truncated, degraded, or paged data", () => {
  assert.equal(assessCompleteness(completeHeaders()).status, "COMPLETE");
  assert.equal(isCompleteResponse(assessCompleteness(completeHeaders())), true);
  assert.equal(assessCompleteness({ ...completeHeaders(), "x-result-has-more": "true" }).status, "MORE_PAGES_AVAILABLE");
  assert.equal(assessCompleteness({ ...completeHeaders(), "x-result-truncated": "true" }).status, "SOURCE_TRUNCATED");
  assert.equal(assessCompleteness({ ...completeHeaders(), "x-result-degraded": "true" }).status, "SOURCE_DEGRADED");
  assert.equal(assessCompleteness({ "x-result-has-more": "false" }).status, "UNKNOWN");
  assert.equal(isCompleteResponse(assessCompleteness({ "x-result-has-more": "false" })), false);
});

test("props pages are sequential, retain prior rows, and record each successful page cost", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  const calls = [];
  const { provider, repository } = makeProvider({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ offset: parsed.searchParams.get("offset"), init });
      return calls.length === 1
        ? response([{ ...FIXED_EVENT, market_key: "player_receptions" }], {
          ...completeHeaders(), "x-result-has-more": "true", "x-next-offset": "10000",
        })
        : response([{ ...FIXED_EVENT, canonical_event_id: "event-456", market_key: "player_pass_yds" }], completeHeaders());
    },
  });
  const result = await provider.fetchPlayerProps({
    season: 2026,
    week: 7,
    maxPages: 2,
    markets: ["player_receptions"],
  });
  assert.deepEqual(calls.map((call) => call.offset), ["0", "10000"]);
  assert.ok(calls.every((call) => call.init.headers["X-API-Key"] === "test-only-secret"));
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].market_key, "player_receptions");
  assert.equal(result.rows[1].market_key, "player_pass_yds");
  const ledger = await repository.readCreditLedger();
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map((entry) => entry.actualCredits), [null, null]);
  assert.deepEqual(ledger.map((entry) => entry.budgetCredits), [3, 3]);
  assert.equal(ledger[1].monthlyRunningTotal, 6);
});

test("props pagination stops on repeated offsets and malformed next offsets", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  for (const nextOffset of ["0", "not-an-offset"]) {
    let calls = 0;
    const { provider } = makeProvider({
      fetchImpl: async () => {
        calls += 1;
        return response([], {
          ...completeHeaders(),
          "x-result-has-more": "true",
          "x-next-offset": nextOffset,
        });
      },
    });
    const result = await provider.fetchPlayerProps({ season: 2026, week: 7, maxPages: 3 });
    assert.equal(calls, 1);
    assert.equal(result.complete, false);
    assert.match(result.error, /pagination cursor/);
  }
});

test("props pagination enforces maximum pages without requesting an extra page", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  let calls = 0;
  const { provider } = makeProvider({
    fetchImpl: async (url) => {
      calls += 1;
      return response([{ offset: new URL(url).searchParams.get("offset") }], {
        ...completeHeaders(),
        "x-result-has-more": "true",
        "x-next-offset": String(calls * 10000),
      });
    },
  });
  const result = await provider.fetchPlayerProps({ season: 2026, week: 7, maxPages: 2 });
  assert.equal(calls, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.rows.length, 2);
  assert.match(result.error, /Maximum props page count/);
});

test("credit budget is checked before every paid page and automatic exhaustion makes no call", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  let calls = 0;
  const { provider, repository } = makeProvider({
    creditConfiguration: { monthlyLimit: 100, automaticBudget: 3 },
    fetchImpl: async () => {
      calls += 1;
      return response([{ firstPage: true }], {
        ...completeHeaders(),
        "x-result-has-more": "true",
        "x-next-offset": "10000",
      });
    },
  });
  const result = await provider.fetchPlayerProps({ season: 2026, week: 7, maxPages: 3 });
  assert.equal(calls, 1);
  assert.equal(result.budgetBlocked, true);
  assert.match(result.error, /automatic_budget_exhausted/);
  assert.equal(result.rows.length, 1);
  const ledger = await repository.readCreditLedger();
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1].success, false);
  assert.equal(ledger[1].budgetCredits, 0);
});

test("manual paid requests may exceed automatic budget but never monthly limit", async () => {
  const now = new Date("2026-10-22T01:00:00.000Z");
  const config = { monthlyLimit: 6, automaticBudget: 0 };
  assert.equal(canSpendCredits({ ledger: [], expectedCredits: 3, automatic: false, configuration: config, now }).allowed, true);
  assert.equal(canSpendCredits({ ledger: [], expectedCredits: 3, automatic: true, configuration: config, now }).reason,
    "automatic_budget_exhausted");
  const entries = [{ provider: "parlay", timestamp: now.toISOString(), automatic: false, actualCredits: 6 }];
  assert.equal(canSpendCredits({ ledger: entries, expectedCredits: 3, automatic: false, configuration: config, now }).reason,
    "monthly_limit_exhausted");
});

test("credit costs follow the documented Parlay formula and unset limits fail closed", () => {
  assert.equal(estimateProviderCredits({ provider: "parlay", endpoint: "events" }), 0);
  assert.equal(estimateProviderCredits({ provider: "parlay", endpoint: "props" }), 3);
  assert.equal(estimateProviderCredits({ provider: "parlay", endpoint: "odds", markets: ["h2h", "totals", "h2h"], regions: ["us"] }), 2);
  assert.equal(estimateProviderCredits({ provider: "parlay", endpoint: "odds", markets: [], regions: [] }), 1);
  assert.deepEqual(readCreditConfiguration({}), { monthlyLimit: 0, automaticBudget: 0 });
});

test("paid core request failures are explicit, are not retried, and do not expose key material", async () => {
  process.env.PARLAY_API_KEY = "do-not-print-this";
  let calls = 0;
  const { provider, repository } = makeProvider({
    fetchImpl: async () => {
      calls += 1;
      return response({ message: "denied" }, {}, 429);
    },
  });
  await assert.rejects(provider.fetchCoreOdds({ season: 2026, week: 7 }), /HTTP 429/);
  assert.equal(calls, 1);
  const ledger = await repository.readCreditLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].success, false);
  assert.equal(ledger[0].actualCredits, null);
  assert.equal(ledger[0].budgetCredits, 3);
  assert.equal(JSON.stringify(ledger).includes("do-not-print-this"), false);
});

test("fetch failures cannot expose a key or authorization header through the error or its cause", async () => {
  process.env.PARLAY_API_KEY = "request-secret";
  const { provider } = makeProvider({
    fetchImpl: async () => {
      throw new Error("Authorization: Bearer private-token x-api-key: request-secret");
    },
  });
  await assert.rejects(
    provider.fetchCoreOdds({ season: 2026, week: 7 }),
    (error) => {
      const diagnostics = `${error.message}\n${error.cause?.message || ""}\n${error.cause?.stack || ""}`;
      assert.equal(diagnostics.includes("request-secret"), false);
      assert.equal(diagnostics.includes("private-token"), false);
      return true;
    }
  );
});

test("a later-page 429 stops without retry and returns successful prior pages for diagnostics", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  const offsets = [];
  const { provider, repository } = makeProvider({
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      offsets.push(offset);
      return offset === "0"
        ? response([{ ...FIXED_EVENT, market_key: "player_receptions" }], {
          ...completeHeaders(), "x-result-has-more": "true", "x-next-offset": "10000",
        })
        : response({ message: "rate limited" }, {}, 429);
    },
  });
  const result = await provider.fetchPlayerProps({ season: 2026, week: 7, maxPages: 3 });
  assert.deepEqual(offsets, ["0", "10000"]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].market_key, "player_receptions");
  assert.equal(result.complete, false);
  assert.match(result.error, /HTTP 429/);
  assert.equal(result.pageCount, 2);
  const ledger = await repository.readCreditLedger();
  assert.deepEqual(ledger.map((entry) => entry.success), [true, false]);
});

test("paid Parlay fetches fail closed without an injected credit ledger", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  let calls = 0;
  const provider = createParlayProvider({
    fetchImpl: async () => { calls += 1; return response([]); },
    creditConfiguration: { monthlyLimit: 100, automaticBudget: 100 },
  });
  await assert.rejects(provider.fetchPlayerProps({ season: 2026, week: 7 }), /credit ledger repository/);
  await assert.rejects(provider.fetchCoreOdds({ season: 2026, week: 7 }), /credit ledger repository/);
  assert.equal(calls, 0);
});

test("core odds are budget-checked, use only requested core markets, and ledger the successful cost", async () => {
  process.env.PARLAY_API_KEY = "test-only-secret";
  let requestUrl;
  const { provider, repository } = makeProvider({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return response([], completeHeaders(), 200);
    },
  });
  const result = await provider.fetchCoreOdds({
    season: 2026,
    week: 7,
    markets: ["h2h", "spreads", "totals"],
    regions: ["us"],
  });
  assert.equal(requestUrl.pathname, "/v1/sports/americanfootball_nfl/odds");
  assert.equal(requestUrl.searchParams.get("markets"), "h2h,spreads,totals");
  assert.equal(requestUrl.searchParams.get("regions"), "us");
  assert.equal(result.expectedCredits, 3);
  const ledger = await repository.readCreditLedger();
  assert.equal(ledger[0].expectedCredits, 3);
  assert.equal(ledger[0].actualCredits, null);
  assert.equal(ledger[0].budgetCredits, 3);
});

test("event and quote models carry provider provenance and quote lock snapshots are immutable", () => {
  const quote = {
    provider: "parlay",
    providerEventId: "event-123",
    season: 2026,
    week: 7,
    matchup: { identity: "nfl:2026:7:ne@chi" },
    bookmaker: "book-a",
    market: "receptions",
    rawProviderMarket: "player_receptions",
    selection: "over",
    side: "over",
    playerId: "00-0039918",
    playerName: "Caleb Williams",
    line: 4.5,
    americanOdds: -110,
    decimalOdds: 1 + 100 / 110,
    impliedProbability: 110 / 210,
    providerTimestamp: "2026-10-22T00:59:00.000Z",
    fetchedAt: FIXED_NOW.toISOString(),
  };
  const locked = createLockedQuoteSnapshot(quote, { modelProbability: 0.6, edge: 0.1 });
  quote.americanOdds = 200;
  assert.equal(locked.americanOdds, -110);
  assert.equal(locked.provider, "parlay");
  assert.equal(locked.cacheFetchedAt, FIXED_NOW.toISOString());
  assert.equal(locked.side, "over");
  assert.equal(locked.edge, 0.1);
  assert.equal(Object.isFrozen(locked), true);
});

test("provider fallback priority is deterministic and never replaces a usable primary quote", () => {
  const registry = createProviderRegistry({
    primary: "parlay",
    fallbacks: ["theoddsapi", "propline"],
    providers: ["parlay", "theoddsapi", "propline"].map((id) => ({ id })),
  });
  const primary = { provider: "parlay", status: "success", hasValidQuotes: true, price: -105 };
  const fallback = { provider: "theoddsapi", status: "success", hasValidQuotes: true, price: -110 };
  assert.equal(selectProviderResult([fallback, primary], registry).selectedProvider, "parlay");
  const incompletePrimary = { provider: "parlay", status: "incomplete", hasValidQuotes: true, price: -105 };
  assert.equal(selectProviderResult([incompletePrimary, fallback], registry).selectedProvider, "theoddsapi");
  assert.equal(selectProviderResult([fallback], registry).status, "unavailable");
  const exhaustedPrimary = { provider: "parlay", status: "budget_exhausted", reason: "budget_exhausted" };
  assert.equal(selectProviderResult([exhaustedPrimary, fallback], registry).status, "unavailable");
  assert.equal(selectProviderResult([
    exhaustedPrimary,
    { ...fallback, fallbackAllowed: true, actualCredits: 0 },
  ], registry).selectedProvider, "theoddsapi");
  assert.equal(selectProviderResult([], registry).status, "unavailable");
});

test("canonical matchup identity is stable by home/away, week, season, and kickoff", () => {
  const identity = normalizeEventIdentity({
    season: 2026,
    week: 7,
    kickoff: FIXED_EVENT.commence_time,
    homeTeam: FIXED_EVENT.home_team,
    awayTeam: FIXED_EVENT.away_team,
  });
  assert.match(identity, /^nfl:2026:7:NE@CHI:/);
  assert.throws(() => normalizeEventIdentity({
    season: 2026, week: 7, kickoff: "invalid", homeTeam: "CHI", awayTeam: "CHI",
  }), /valid season, week, kickoff, or team identity/);
});
