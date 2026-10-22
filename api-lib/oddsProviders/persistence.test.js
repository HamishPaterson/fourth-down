import assert from "node:assert/strict";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPersistentOddsRepository } from "./supabaseRepository.js";
import { createPersistentRefreshService, validateGeneration, planProviderRefresh } from "./persistentRefresh.js";
import { createOddsCacheReader } from "./cacheReader.js";
import { createProviderRefreshOperation } from "./refreshOperation.js";
import { createParlayProvider, PARLAY_MARKET_MAP } from "./parlay.js";
import { createLockedQuoteSnapshot, normalizeEventIdentity, requireRefreshReason } from "./contracts.js";

const COMPLETE = { status: "COMPLETE", hasMore: false, truncated: false, degraded: false };
const NOW = new Date().toISOString();
const KEY = { provider: "parlay", season: 2026, week: 7, resource: "props" };
const TEAMS = ["CHI", "NE", "BUF", "MIA", "SF", "SEA", "DAL", "PHI", "NYG", "WAS",
  "GB", "MIN", "DET", "ATL", "TB", "CAR", "LAR", "ARI", "LAC", "DEN", "LV", "KC",
  "HOU", "IND", "PIT", "BAL", "NO", "CIN"];
const EVENTS = Array.from({ length: 14 }, (_, index) => ({
  provider: "parlay", providerEventId: `event-${index}`, season: 2026, week: 7,
  kickoff: `2026-10-${String(23 + index % 3).padStart(2, "0")}T00:15:00.000Z`,
  homeTeam: TEAMS[index * 2], awayTeam: TEAMS[index * 2 + 1], fetchedAt: NOW,
})).map((event) => ({ ...event, canonicalMatchupIdentity: normalizeEventIdentity(event) }));
const PLAYERS = EVENTS.map((event, index) => ({
  gsisId: index === 0 ? "fixture-chi" : `fixture-${index}`,
  playerName: index === 0 ? "Caleb Williams" : `Fixture Player ${index}`,
  team: event.homeTeam,
}));
const markets = Object.keys(PARLAY_MARKET_MAP);
const props = (events = EVENTS) => events.flatMap((event) => markets.map((market_key) => ({
  canonical_event_id: event.providerEventId, market_key, bookmaker: "book-a",
  player: PLAYERS.find((player) => player.team === event.homeTeam).playerName, player_team: event.homeTeam, line: 0.5,
  over_price: -110, under_price: 120, updated_at: NOW,
})));
const core = () => EVENTS.map((event) => ({
  canonical_event_id: event.providerEventId, bookmakers: [{
    key: "book-a", markets: ["h2h", "spreads", "totals"].map((key) => ({
      key, outcomes: [{ name: key === "totals" ? "Over" : event.homeTeam, price: -110, point: key === "h2h" ? null : 0.5 }],
    })),
  }], updated_at: NOW,
}));
const headers = (extra = {}) => ({
  "x-credit-cost": "3",
  "x-result-has-more": "false", "x-result-truncated": "false", "x-result-degraded": "false", ...extra,
});
const response = (rows, extra = {}, status = 200) =>
  new Response(JSON.stringify(rows), { status, headers: headers(extra) });

// Supabase-shaped transport backed only by a local embedded PostgreSQL fixture.
const rpcQueues = new WeakMap();
function localClient(db, calls = []) {
  return {
    rpc(name, args) {
      const work = async () => {
        calls.push({ name, ...args });
        await db.exec("savepoint fixture_rpc");
        try {
          const result = await db.query(`select public.${name}($1,$2) as result`, [args.p_action, args.p]);
          await db.exec("release savepoint fixture_rpc");
          return { data: result.rows[0].result, error: null };
        } catch (error) {
          await db.exec("rollback to savepoint fixture_rpc; release savepoint fixture_rpc");
          return { data: null, error: { message: error.message } };
        }
      };
      const result = (rpcQueues.get(db) || Promise.resolve()).then(work);
      rpcQueues.set(db, result.then(() => {}, () => {}));
      return result;
    },
    from(table) {
      assert.ok(["odds_provider_scopes", "odds_provider_refreshes", "odds_provider_usage", "odds_provider_budgets"].includes(table));
      const conditions = [];
      const values = [];
      const orders = [];
      let limit;
      let offset = 0;
      const query = {
        select() { return query; },
        eq(column, value) { values.push(value); conditions.push(`"${column}"=$${values.length}`); return query; },
        gte(column, value) { values.push(value); conditions.push(`"${column}">=$${values.length}`); return query; },
        order(column, { ascending = true } = {}) { orders.push(`"${column}" ${ascending ? "asc" : "desc"}`); return query; },
        limit(value) { limit = value; return query; },
        range(start, end) { offset = start; limit = end - start + 1; return query; },
        async maybeSingle() {
          const result = await execute();
          return { ...result, data: result.data?.[0] || null };
        },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      async function execute() {
        const sql = `select * from public.${table}${conditions.length ? ` where ${conditions.join(" and ")}` : ""}` +
          `${orders.length ? ` order by ${orders.join(",")}` : ""}${limit ? ` limit ${limit} offset ${offset}` : ""}`;
        try { return { data: (await db.query(sql, values)).rows, error: null }; }
        catch (error) { return { data: null, error: { message: error.message } }; }
      }
      return query;
    },
  };
}

function setup(db, { fetchImpl = async () => response(props()), configuration = { monthlyLimit: 100, automaticBudget: 80 } } = {}) {
  const calls = [];
  const repository = createPersistentOddsRepository({ client: localClient(db, calls) });
  let providerCalls = 0;
  const providerFactory = ({ repository: creditRepository }) => createParlayProvider({
    repository: creditRepository, creditConfiguration: configuration,
    fetchImpl: async (...args) => { providerCalls += 1; return fetchImpl(...args); },
  });
  const service = createPersistentRefreshService({ repository, providerFactory });
  const refresh = (overrides = {}) => service.refresh({
    key: KEY, events: EVENTS, players: PLAYERS, reason: "INITIAL_PROVIDER_VALIDATION", ...overrides,
  });
  return { repository, providerFactory, service, refresh, calls, providerCalls: () => providerCalls };
}

test("Phase 2 isolated PostgreSQL persistence and fixture-only provider integration", async (t) => {
  const db = new PGlite();
  const originalKey = process.env.PARLAY_API_KEY;
  process.env.PARLAY_API_KEY = "fixture-only-not-a-real-key";
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    const migration = await readFile(new URL("../../supabase/odds_provider_cache.sql", import.meta.url), "utf8");
    assert.doesNotMatch(migration, /\b(drop|truncate)\b/i);
    await db.exec(migration);

    async function isolated(name, run) {
      await t.test(name, async () => {
        await db.exec("begin");
        try { await run(); } finally { await db.exec("rollback"); }
      });
    }

    async function creditContext(key = KEY) {
      const fixture = setup(db);
      const scope = { ...key, ...await fixture.repository.acquireLease(key) };
      const refreshId = randomUUID();
      await fixture.repository.startRefresh(scope, { refreshId, expectedEventIds: [], requiredMarkets: [] });
      return { ...fixture, scope, refreshId, credits: fixture.repository.bindRefresh(scope, refreshId) };
    }
    function usage(overrides = {}) {
      return {
        configuration: { monthlyLimit: 30, automaticBudget: 30 },
        expectedCredits: 3, automatic: true, endpoint: "props", reason: "SCHEDULED_REFRESH", ...overrides,
      };
    }
    const prohibitedReasons = [
      ["free-form", "operator says refresh now"],
      ["Authorization", "Authorization: Bearer SYNTHETIC-REJECTED"],
      ["Bearer", "Bearer SYNTHETIC-REJECTED"],
      ["API-key", "PARLAY_API_KEY=SYNTHETIC-REJECTED"],
      ["multiline", "SCHEDULED_REFRESH\r\nCookie: SYNTHETIC-REJECTED"],
      ["cookie", "Cookie: session=SYNTHETIC-REJECTED"],
      ["connection-string", "postgres://synthetic:placeholder@localhost/database"],
      ["query-secret", "https://example.invalid/?api_key=SYNTHETIC-REJECTED"],
    ];

    for (const reason of ["SCHEDULED_REFRESH", "MANUAL_ADMIN_REFRESH", "INITIAL_PROVIDER_VALIDATION", "RECOVERY_REFRESH"]) {
      await isolated(`allowlisted ${reason} is accepted through operation, domain, repository and SQL`, async () => {
        const fixture = setup(db);
        const operation = createProviderRefreshOperation({
          secret: () => "fixture-admin", repositoryFactory: () => fixture.repository,
          providerFactory: fixture.providerFactory,
          contextLoader: async () => ({ events: EVENTS, players: PLAYERS }),
        });
        const result = await operation({
          method: "POST", authorization: "Bearer fixture-admin",
          body: { season: 2026, week: 7, resource: "props", mode: "persist", reason },
        });
        assert.equal(result.result.status, "promoted", result.result.error);
        assert.equal((await fixture.repository.readCreditLedger())[0].reason_code, reason);
      });
    }

    for (const [label, reason] of prohibitedReasons) {
      await isolated(`${label} reason is rejected at every boundary before storing supplied text`, async () => {
        const context = await creditContext();
        let loaded = false;
        const operation = createProviderRefreshOperation({
          secret: () => "fixture-admin",
          contextLoader: async () => { loaded = true; throw new Error("should not run"); },
        });
        const result = await operation({
          method: "POST", authorization: "Bearer fixture-admin",
          body: { season: 2026, week: 7, resource: "props", mode: "persist", reason },
        });
        assert.equal(result.status, 400);
        assert.equal(loaded, false);
        assert.throws(() => requireRefreshReason(reason), /INVALID_REFRESH_REASON/);
        assert.throws(() => context.credits.reserveCredits(usage({ reason })), /INVALID_REFRESH_REASON/);
        assert.throws(() => context.repository.appendCreditEntry({
          ...KEY, endpoint: "events", expectedCredits: 0, reason,
        }), /INVALID_REFRESH_REASON/);
        await assert.rejects(context.refresh({ reason }), /INVALID_REFRESH_REASON/);
        const raw = await localClient(db).rpc("odds_provider_control", {
          p_action: "reserve", p: {
            ...context.scope, refreshId: context.refreshId, reservationId: randomUUID(),
            expectedCredits: 3, automatic: true, endpoint: "props",
            reasonCode: reason, monthlyLimit: 30, automaticBudget: 30,
          },
        });
        assert.match(raw.error.message, /Invalid refresh reason code/);
        // Prove the table CHECK itself rejects invalid codes, not only the RPC.
        await db.exec("savepoint unsafe_reason");
        await assert.rejects(db.query(`insert into public.odds_provider_usage
          (reservation_id,provider,period,endpoint,season,week,reason_code,automatic,
            expected_credits,budget_credits,monthly_running_total)
          values($1,'parlay','2026-10','props',2026,7,$2,true,3,3,3)`, [randomUUID(), reason]),
        /check constraint/);
        await db.exec("rollback to savepoint unsafe_reason; release savepoint unsafe_reason");
        const stored = (await db.query(`select row_to_json(t) as record from public.odds_provider_usage t
          union all select row_to_json(t) from public.odds_provider_refreshes t
          union all select row_to_json(t) from public.odds_provider_scopes t`)).rows;
        assert.equal(JSON.stringify(stored).includes(reason), false);
        assert.equal((await context.repository.readCreditLedger()).length, 0);
        assert.equal(context.providerCalls(), 0);
      });
    }

    await isolated("raw remote failure text is never persisted in generations, ledger or diagnostics", async () => {
      const marker = "Authorization: Bearer SYNTHETIC-REMOTE-FAILURE\r\nCookie: placeholder";
      const fixture = setup(db, { fetchImpl: async () => { throw new Error(marker); } });
      const result = await fixture.refresh();
      assert.equal(result.error, "PROVIDER_REQUEST_FAILED");
      assert.equal(result.cache.diagnostic.failure_code, "PROVIDER_REQUEST_FAILED");
      const stored = (await db.query(`select row_to_json(t) as record from public.odds_provider_usage t
        union all select row_to_json(t) from public.odds_provider_refreshes t`)).rows;
      assert.equal(JSON.stringify(stored).includes(marker), false);
      assert.equal(JSON.stringify(stored).includes("SYNTHETIC-REMOTE-FAILURE"), false);
      assert.equal((await fixture.repository.readCreditLedger())[0].result_status, "CHARGE_UNKNOWN");
      assert.throws(() => fixture.repository.failRefresh({}, randomUUID(), marker), /INVALID_REFRESH_FAILURE/);
    });

    await isolated("3/3 reservation, observed 4: actual 4, overrun 1, COST_OVERRUN, SUSPENDED, later paid calls blocked", async () => {
      const context = await creditContext();
      const request = usage({ configuration: { monthlyLimit: 3, automaticBudget: 3 } });
      const reservation = await context.credits.reserveCredits(request);
      assert.equal(reservation.allowed, true);
      const reconciled = await context.credits.reconcileReservation({
        reservationId: reservation.reservationId, observedCredits: 4,
        requestAttempted: true, success: true, httpStatus: 200,
      });
      assert.equal(Number(reconciled.expected_credits), 3);
      assert.equal(Number(reconciled.observed_credits), 4);
      assert.equal(Number(reconciled.budget_credits), 4);
      assert.equal(Number(reconciled.overrun_credits), 1);
      assert.equal(Number(reconciled.monthly_running_total), 4);
      assert.equal(reconciled.result_status, "COST_OVERRUN");
      assert.equal((await context.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
      for (const automatic of [true, false]) {
        const next = await context.credits.reserveCredits(usage({ automatic }));
        assert.equal(next.allowed, false);
        assert.equal(next.reason, "provider_month_suspended");
      }
      const freeProvider = context.providerFactory({ repository: context.repository });
      await freeProvider.listEvents(KEY);
      assert.equal(context.providerCalls(), 1);
      const ledger = await context.repository.readCreditLedger();
      assert.equal(ledger.length, 2);
      assert.equal(ledger[1].result_status, "FREE");
      assert.equal(Number(ledger[1].budget_credits), 0);
      assert.equal((await context.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
    });

    for (const [label, observed, status, charge] of [
      ["lower", 1, "RECONCILED", 1], ["equal", 3, "RECONCILED", 3],
      ["unknown", null, "CHARGE_UNKNOWN", 3],
    ]) {
      await isolated(`${label} actual charge is reconciled honestly and concurrent replay does not double count`, async () => {
        const context = await creditContext();
        const reservation = await context.credits.reserveCredits(usage());
        const payload = { reservationId: reservation.reservationId,
          observedCredits: observed, requestAttempted: true, success: true, httpStatus: 200 };
        await Promise.all([context.credits.reconcileReservation(payload), context.credits.reconcileReservation(payload)]);
        const ledger = await context.repository.readCreditLedger();
        assert.equal(ledger.length, 1);
        assert.equal(Number(ledger[0].budget_credits), charge);
        assert.equal(ledger[0].observed_credits === null ? null : Number(ledger[0].observed_credits), observed);
        assert.equal(Number(ledger[0].overrun_credits), 0);
        assert.equal(ledger[0].result_status, status);
        if (observed === null) {
          assert.equal((await context.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
          assert.equal((await context.credits.reserveCredits(usage())).allowed, false);
          assert.equal((await context.credits.reserveCredits(usage({ automatic: false }))).allowed, false);
          // Later exact evidence can reconcile pending usage; suspension never silently clears.
          await context.credits.reconcileReservation({ ...payload, observedCredits: 2 });
          assert.equal(Number((await context.repository.readCreditLedger())[0].budget_credits), 2);
          assert.equal((await context.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
        }
      });
    }

    for (const [label, configuration] of [
      ["automatic", { monthlyLimit: 30, automaticBudget: 2 }],
      ["monthly", { monthlyLimit: 2, automaticBudget: 30 }],
    ]) {
      await isolated(`reservation exceeding ${label} limit cannot dispatch`, async () => {
        const fixture = setup(db, { configuration });
        assert.equal((await fixture.refresh()).status, "failed");
        assert.equal(fixture.providerCalls(), 0);
        assert.equal((await fixture.repository.readCreditLedger()).length, 0);
      });
    }

    await isolated("overrun circuit breaker blocks a later props page and manual refresh without losing current COMPLETE cache", async () => {
      let version = 0;
      const fixture = setup(db, { fetchImpl: async () => {
        version += 1;
        return response(props(), version === 1 ? {} : {
          "x-credit-cost": "4", "x-result-has-more": "true", "x-next-offset": "10000",
        });
      } });
      const first = await fixture.refresh();
      const overrun = await fixture.refresh({ maxPages: 2 });
      assert.equal(overrun.status, "failed");
      assert.equal(overrun.cache.generation, first.refreshId);
      assert.equal(fixture.providerCalls(), 2);
      assert.equal((await fixture.refresh({ automatic: false })).status, "failed");
      assert.equal(fixture.providerCalls(), 2);
    });

    await isolated("unknown successful page charge suspends before the next page rather than assuming the documented price", async () => {
      const fixture = setup(db, { fetchImpl: async () => new Response(JSON.stringify(props()), { headers: {
        "x-result-has-more": "true", "x-next-offset": "10000",
        "x-result-truncated": "false", "x-result-degraded": "false",
      } }) });
      assert.equal((await fixture.refresh({ maxPages: 2 })).status, "failed");
      assert.equal(fixture.providerCalls(), 1);
      const ledger = await fixture.repository.readCreditLedger();
      assert.equal(ledger[0].result_status, "CHARGE_UNKNOWN");
      assert.equal(Number(ledger[0].budget_credits), 3);
    });

    await isolated("a reservation acquired before another scope suspends cannot subsequently dispatch", async () => {
      const a = await creditContext();
      const b = await creditContext({ ...KEY, resource: "core" });
      const ra = await a.credits.reserveCredits(usage());
      const rb = await b.credits.reserveCredits(usage({ endpoint: "odds" }));
      await a.credits.reconcileReservation({
        reservationId: ra.reservationId, observedCredits: 4, requestAttempted: true, success: true,
      });
      await assert.rejects(b.credits.beforePaidRequest(rb.reservationId), /dispatch failed/);
      await b.credits.reconcileReservation({
        reservationId: rb.reservationId, observedCredits: null, requestAttempted: false, success: false,
      });
      const rows = await a.repository.readCreditLedger();
      assert.equal(rows[1].result_status, "PRE_DISPATCH_FAILURE");
      assert.equal(Number(rows[1].budget_credits), 0);
    });

    await isolated("an in-flight dispatched request blocks other paid reservations and dispatches until reconciled", async () => {
      const a = await creditContext();
      const b = await creditContext({ ...KEY, resource: "core" });
      const ra = await a.credits.reserveCredits(usage());
      const rb = await b.credits.reserveCredits(usage({ endpoint: "odds" }));
      await a.credits.beforePaidRequest(ra.reservationId);
      for (const automatic of [true, false]) {
        const next = await b.credits.reserveCredits(usage({ endpoint: "odds", automatic }));
        assert.equal(next.allowed, false);
        assert.equal(next.reason, "provider_charge_unresolved");
      }
      await assert.rejects(b.credits.beforePaidRequest(rb.reservationId), /dispatch failed/);
      await a.credits.reconcileReservation({
        reservationId: ra.reservationId, observedCredits: 3, requestAttempted: true, success: true,
      });
      assert.equal((await b.credits.beforePaidRequest(rb.reservationId)).dispatchAllowed, true);
      assert.equal((await a.repository.readCreditLedger())[1].result_status, "DISPATCHED");
    });

    for (const recovery of ["new reservation", "already reserved dispatch"]) {
      await isolated(`interrupted dispatch becomes CHARGE_UNKNOWN and SUSPENDED before ${recovery}`, async () => {
        const fixture = setup(db);
        const complete = await fixture.refresh();
        const a = await creditContext();
        const b = await creditContext({ ...KEY, resource: "core" });
        const ra = await a.credits.reserveCredits(usage());
        const rb = await b.credits.reserveCredits(usage({ endpoint: "odds" }));
        await a.credits.beforePaidRequest(ra.reservationId);
        await db.query("update public.odds_provider_scopes set lease_until=clock_timestamp()-interval '1 second' where scope_key=$1",
          [a.scope.scopeKey]);
        if (recovery === "new reservation") {
          const replacement = await creditContext();
          assert.notEqual(replacement.scope.ownerToken, a.scope.ownerToken);
          assert.equal((await replacement.credits.reserveCredits(usage())).allowed, false);
        } else {
          await assert.rejects(b.credits.beforePaidRequest(rb.reservationId), /dispatch failed/);
        }
        const pending = (await a.repository.readCreditLedger()).find((row) => row.reservation_id === ra.reservationId);
        assert.equal(pending.result_status, "CHARGE_UNKNOWN");
        assert.equal(pending.observed_credits, null);
        assert.equal(Number(pending.budget_credits), 3);
        assert.equal((await a.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
        for (const automatic of [true, false]) {
          assert.equal((await b.credits.reserveCredits(usage({ endpoint: "odds", automatic }))).allowed, false);
        }
        const free = a.providerFactory({ repository: a.repository });
        await free.listEvents(KEY);
        assert.equal(a.providerCalls(), 1);
        assert.equal((await a.repository.readCache(KEY)).generation, complete.refreshId);
        await a.credits.reconcileReservation({
          reservationId: ra.reservationId, observedCredits: 3, requestAttempted: true, success: true,
        });
        assert.equal((await a.repository.readBudgetState(KEY)).paid_state, "SUSPENDED");
      });
    }

    await isolated("overrun replay is idempotent, invalid negative charges rejected, constraints enforce consistent usage", async () => {
      const context = await creditContext();
      const reservation = await context.credits.reserveCredits(usage());
      await assert.rejects(context.credits.reconcileReservation({
        reservationId: reservation.reservationId, observedCredits: -1, requestAttempted: true, success: true,
      }), /reconcile failed/);
      const payload = {
        reservationId: reservation.reservationId, observedCredits: 4, requestAttempted: true, success: true,
      };
      await Promise.all([context.credits.reconcileReservation(payload), context.credits.reconcileReservation(payload)]);
      assert.equal((await context.repository.readCreditLedger()).length, 1);
      assert.equal(Number((await context.repository.readCreditLedger())[0].budget_credits), 4);
      for (const assignment of [
        "budget_credits=-1", "observed_credits=-1", "expected_credits=-1", "overrun_credits=-1",
        "overrun_credits=0", "result_status='ARBITRARY'", "result_status='CHARGE_UNKNOWN'",
      ]) {
        await db.exec("savepoint invalid_usage");
        await assert.rejects(db.exec(`update public.odds_provider_usage set ${assignment}`), /check constraint/);
        await db.exec("rollback to savepoint invalid_usage; release savepoint invalid_usage");
      }
    });

    await isolated("provider/month suspensions are isolated and never automatically reset", async () => {
      const context = await creditContext();
      const reservation = await context.credits.reserveCredits(usage());
      await context.credits.reconcileReservation({
        reservationId: reservation.reservationId, observedCredits: 4, requestAttempted: true, success: true,
      });
      const other = await creditContext({ ...KEY, provider: "future-provider" });
      assert.equal(await other.repository.readBudgetState({ provider: "future-provider" }), null);
      // No future-provider paid integration is enabled; reconciliation remains provider-isolated.
      const foreign = await localClient(db).rpc("odds_provider_control", {
        p_action: "reconcile", p: { provider: "future-provider", refreshId: other.refreshId,
          reservationId: reservation.reservationId, observedCredits: 0, requestAttempted: false, success: false },
      });
      assert.ok(foreign.error);
      const period = new Date().toISOString().slice(0, 7);
      const previous = period === "2026-10" ? "2026-09" : "2000-01";
      await db.query(`update public.odds_provider_budgets set period=$1`, [previous]);
      // Database time still governs the next reservation's month.
      const next = await context.credits.reserveCredits(usage());
      assert.equal(next.allowed, true);
      assert.equal((await context.repository.readBudgetState({ provider: "parlay", period: previous })).paid_state, "SUSPENDED");
      assert.equal((await context.repository.readBudgetState({ provider: "parlay", period })).paid_state, "ACTIVE");
      const reset = await localClient(db).rpc("odds_provider_control", {
        p_action: "reset", p: { ...context.scope, refreshId: context.refreshId },
      });
      assert.ok(reset.error);
    });

    await isolated("suspension table RLS, constraints and RPC permissions exclude browsers", async () => {
      const context = await creditContext();
      const reserved = await context.credits.reserveCredits(usage());
      await context.credits.reconcileReservation({
        reservationId: reserved.reservationId, observedCredits: null, requestAttempted: true, success: false,
      });
      for (const assignment of ["paid_state='ACTIVE'", "suspension_code='ARBITRARY'", "suspended_at=null"]) {
        await db.exec("savepoint invalid_budget");
        await assert.rejects(db.exec(`update public.odds_provider_budgets set ${assignment}`), /check constraint/);
        await db.exec("rollback to savepoint invalid_budget; release savepoint invalid_budget");
      }
      for (const role of ["anon", "authenticated"]) {
        const permissions = await db.query(`select has_table_privilege($1,'public.odds_provider_budgets','SELECT') as read,
          has_table_privilege($1,'public.odds_provider_budgets','UPDATE') as write,
          has_function_privilege($1,'public.odds_provider_control(text,jsonb)','EXECUTE') as execute`, [role]);
        assert.deepEqual(permissions.rows[0], { read: false, write: false, execute: false });
      }
    });

    await isolated("14 Week 7 events and all nine props markets persist then atomically promote", async () => {
      const fixture = setup(db);
      const result = await fixture.refresh();
      assert.equal(result.status, "promoted", result.error);
      assert.equal(result.cache.snapshot.events.length, 14);
      assert.equal(result.cache.snapshot.quotes.length, 252);
      assert.equal(result.cache.snapshot.quotes[0].refreshId, result.refreshId);
      assert.equal(fixture.providerCalls(), 1);
      const rows = await db.query("select * from public.odds_provider_quotes");
      assert.equal(rows.rows.length, 252);
      assert.equal(rows.rows[0].raw_provider_market, "player_anytime_td");
      assert.ok(rows.rows[0].kickoff);
      const usage = await fixture.repository.readCreditLedger();
      assert.equal(Number(usage[0].budgetCredits), 3);
      assert.equal(usage[0].refresh_id, result.refreshId);
      assert.equal(usage[0].result_status, "RECONCILED");
    });

    await isolated("core h2h/spreads/totals cost three credits and persist separately", async () => {
      const fixture = setup(db, { fetchImpl: async (url) => {
        assert.match(String(url), /markets=h2h%2Cspreads%2Ctotals/);
        return response(core());
      } });
      const result = await fixture.refresh({ key: { ...KEY, resource: "core" } });
      assert.equal(result.status, "promoted", result.error);
      assert.equal(result.cache.snapshot.quotes.length, 42);
      assert.equal(Number((await fixture.repository.readCreditLedger())[0].expected_credits), 3);
    });

    await isolated("candidate is invisible until promotion; persisted corruption cannot be promoted", async () => {
      const fixture = setup(db);
      const initial = await fixture.refresh();
      const scope = { ...KEY, ...await fixture.repository.acquireLease(KEY) };
      const refreshId = randomUUID();
      await fixture.repository.startRefresh(scope, {
        refreshId, expectedEventIds: EVENTS.map((e) => e.providerEventId), requiredMarkets: Object.values(PARLAY_MARKET_MAP),
      });
      const candidate = validateGeneration({ ...initial.cache.snapshot, refreshId },
        { expectedEvents: EVENTS, requiredMarkets: Object.values(PARLAY_MARKET_MAP) });
      await fixture.repository.writeCandidate(scope, refreshId, candidate);
      assert.equal((await fixture.repository.readCache(KEY)).generation, initial.refreshId);
      await assert.rejects(fixture.repository.promote(scope, refreshId, { ...candidate, fetchedAt: NOW + "bad" }),
        /Odds persistence promote failed/);
    });

    for (const [name, extra] of [
      ["has-more", { "x-result-has-more": "true", "x-next-offset": "10000" }],
      ["truncated", { "x-result-truncated": "true" }],
      ["degraded", { "x-result-degraded": "true" }],
      ["malformed offset", { "x-result-has-more": "true", "x-next-offset": "bad" }],
      ["repeated offset", { "x-result-has-more": "true", "x-next-offset": "0" }],
    ]) {
      await isolated(`${name} cannot replace the last COMPLETE generation`, async () => {
        let fail = false;
        const fixture = setup(db, { fetchImpl: async () => response(props(), fail ? extra : {}) });
        const good = await fixture.refresh();
        fail = true;
        const bad = await fixture.refresh({ maxPages: 2 });
        assert.equal(bad.status, "failed");
        assert.equal(bad.cache.generation, good.refreshId);
        assert.equal(bad.cache.stale, true);
      });
    }

    await isolated("10,000-row has-more page is not promoted as COMPLETE", async () => {
      const source = props();
      const rows = Array.from({ length: 10000 }, (_, i) => source[i % source.length]);
      const fixture = setup(db, { fetchImpl: async () =>
        response(rows, { "x-result-has-more": "true", "x-next-offset": "10000" }) });
      const result = await fixture.refresh();
      assert.equal(result.status, "failed");
      assert.equal(result.cache.snapshot, null);
      assert.equal(fixture.providerCalls(), 1);
    });

    await isolated("two paid pages reserve separately, retain rows, and promote only the complete set", async () => {
      let page = 0;
      const rows = props();
      const fixture = setup(db, { fetchImpl: async (url) => {
        page += 1;
        assert.equal(new URL(url).searchParams.get("offset"), page === 1 ? "0" : "10000");
        return page === 1 ? response(rows.slice(0, 63), {
          "x-result-has-more": "true", "x-next-offset": "10000",
        }) : response(rows.slice(63));
      } });
      const result = await fixture.refresh({ maxPages: 2 });
      assert.equal(result.status, "promoted", result.error);
      assert.equal(result.cache.snapshot.quotes.length, 252);
      const usage = await fixture.repository.readCreditLedger();
      assert.equal(usage.length, 2);
      assert.equal(usage.reduce((sum, row) => sum + Number(row.budgetCredits), 0), 6);
    });

    await isolated("mid-pagination budget exhaustion makes no next call and preserves cache", async () => {
      let paged = false;
      const fixture = setup(db, {
        configuration: { monthlyLimit: 6, automaticBudget: 6 },
        fetchImpl: async () => response(props(), paged ? { "x-result-has-more": "true", "x-next-offset": "10000" } : {}),
      });
      const first = await fixture.refresh();
      paged = true;
      const result = await fixture.refresh({ maxPages: 2 });
      assert.equal(result.status, "failed");
      assert.equal(result.cache.generation, first.refreshId);
      assert.equal(fixture.providerCalls(), 2);
      assert.equal((await fixture.repository.readCreditLedger()).length, 2);
    });

    for (const [name, mutate] of [
      ["partial event coverage", (rows) => rows.filter((row) => row.canonical_event_id !== "event-13")],
      ["unresolved player", (rows) => [{ ...rows[0], player: "Unknown Player" }, ...rows.slice(1)]],
      ["team mismatch", (rows) => [{ ...rows[0], player_team: "PHI" }, ...rows.slice(1)]],
      ["invalid odds", (rows) => [{ ...rows[0], over_price: 20 }, ...rows.slice(1)]],
      ["DFS-only", (rows) => [{ ...rows[0], dfs_normalized: true }, ...rows.slice(1)]],
    ]) {
      await isolated(`${name} rejects promotion`, async () => {
        const fixture = setup(db, { fetchImpl: async () => response(mutate(props())) });
        const result = await fixture.refresh();
        assert.equal(result.status, "failed", name);
        assert.equal(result.cache.snapshot, null);
      });
    }

    await isolated("same payload and duplicate source rows are idempotent; bookmakers and alternates remain distinct", async () => {
      const rows = props();
      rows.push(rows[0], { ...rows[0], bookmaker: "book-b" }, { ...rows[1], line: 1.5 });
      const fixture = setup(db, { fetchImpl: async () => response(rows) });
      const first = await fixture.refresh();
      const second = await fixture.refresh();
      assert.equal(first.status, "promoted", first.error);
      assert.equal(second.status, "promoted", second.error);
      assert.notEqual(first.refreshId, second.refreshId);
      assert.equal(first.cache.snapshot.quotes.length, 256);
      assert.equal(second.cache.snapshot.quotes.length, 256);
      assert.equal((await db.query("select count(*) from public.odds_provider_scopes where current_refresh_id is not null")).rows[0].count, 1);
      assert.equal((await db.query("select count(*) from public.odds_provider_quotes")).rows[0].count, 512);
    });

    await isolated("changed price promotes a new immutable generation; older provider timestamps cannot replace it", async () => {
      let version = 0;
      const fixture = setup(db, { fetchImpl: async () => {
        version += 1;
        return response(props().map((row) => ({
          ...row, over_price: version === 1 ? -110 : -120,
          updated_at: version === 3 ? "2020-01-01T00:00:00.000Z" : NOW,
        })));
      } });
      const first = await fixture.refresh();
      const lock = createLockedQuoteSnapshot({
        ...first.cache.snapshot.quotes[0], cacheFetchedAt: NOW,
      }, { modelProbability: 0.7, edge: 0.1 });
      const second = await fixture.refresh();
      assert.equal(second.status, "promoted", second.error);
      assert.equal(second.cache.snapshot.quotes[0].americanOdds, -120);
      assert.equal(lock.americanOdds, -110);
      assert.equal(lock.refreshId, first.refreshId);
      assert.equal(lock.cacheFetchedAt, NOW);
      const distinctCacheTime = new Date(Date.parse(NOW) + 1000).toISOString();
      assert.equal(createLockedQuoteSnapshot({
        ...first.cache.snapshot.quotes[0], cacheFetchedAt: distinctCacheTime,
      }).cacheFetchedAt, distinctCacheTime);
      assert.ok(Object.isFrozen(lock));
      const older = await fixture.refresh();
      assert.equal(older.status, "failed");
      assert.equal(older.cache.generation, second.refreshId);
    });

    await isolated("distributed lease rejects another instance, expires, fences the old owner, and releases only by owner", async () => {
      const a = setup(db).repository;
      const b = setup(db).repository;
      const owner = { ...KEY, ...await a.acquireLease(KEY) };
      assert.equal((await b.acquireLease(KEY)).acquired, false);
      assert.equal((await b.releaseLease({ ...owner, ownerToken: randomUUID() })).released, false);
      await db.query("update public.odds_provider_scopes set lease_until=clock_timestamp()-interval '1 second'");
      const next = { ...KEY, ...await b.acquireLease(KEY) };
      assert.equal(next.acquired, true);
      await assert.rejects(a.renewLease(owner), /Odds persistence renew failed/);
      assert.equal((await a.releaseLease(owner)).released, false);
      assert.equal((await b.releaseLease(next)).released, true);
    });

    await isolated("two refresh service instances cannot duplicate provider calls for the same scope", async () => {
      let unblock;
      let entered;
      const waiting = new Promise((resolve) => { unblock = resolve; });
      const started = new Promise((resolve) => { entered = resolve; });
      const first = setup(db, { fetchImpl: async () => { entered(); await waiting; return response(props()); } });
      const second = setup(db);
      const pending = first.refresh();
      await started;
      const concurrent = await second.refresh();
      assert.equal(concurrent.status, "locked");
      assert.equal(second.providerCalls(), 0);
      unblock();
      assert.equal((await pending).status, "promoted");
    });

    await isolated("atomic reservations across different scopes prevent concurrent budget overspending", async () => {
      const fixture = setup(db);
      async function bound(key) {
        const scope = { ...key, ...await fixture.repository.acquireLease(key) };
        const refreshId = randomUUID();
        await fixture.repository.startRefresh(scope, { refreshId, expectedEventIds: [], requiredMarkets: [] });
        return fixture.repository.bindRefresh(scope, refreshId);
      }
      const a = await bound(KEY);
      const b = await bound({ ...KEY, resource: "core" });
      const usage = { configuration: { monthlyLimit: 3, automaticBudget: 3 },
        expectedCredits: 3, automatic: true, endpoint: "props", reason: "SCHEDULED_REFRESH" };
      const results = await Promise.all([a.reserveCredits(usage), b.reserveCredits({ ...usage, endpoint: "odds" })]);
      assert.equal(results.filter((result) => result.allowed).length, 1);
      assert.equal(Number((await fixture.repository.readCreditLedger())[0].budgetCredits), 3);
      const allowed = results.find((result) => result.allowed);
      const winner = results[0].allowed ? a : b;
      await winner.reconcileReservation({
        reservationId: allowed.reservationId, observedCredits: 1, requestAttempted: true,
        success: true, resultStatus: "success",
      });
      assert.equal(Number((await fixture.repository.readCreditLedger())[0].budgetCredits), 1);
      await winner.reconcileReservation({
        reservationId: allowed.reservationId, observedCredits: 0, requestAttempted: false,
        success: false, resultStatus: "released_pre_request",
      });
      assert.equal(Number((await fixture.repository.readCreditLedger())[0].budgetCredits), 1);
    });

    for (const [name, fetchImpl, expectedCost] of [
      ["known uncharged provider failure", async () => response([], { "x-credit-cost": "0" }, 429), 0],
      ["known charged provider failure", async () => response([], { "x-credit-cost": "2" }, 500), 2],
      ["unknown charge provider failure", async () => { throw new Error("fixture network failure"); }, 3],
    ]) {
      await isolated(`${name} is recorded without paid retry`, async () => {
        const fixture = setup(db, { fetchImpl });
        assert.equal((await fixture.refresh()).status, "failed");
        assert.equal(fixture.providerCalls(), 1);
        const ledger = await fixture.repository.readCreditLedger();
        assert.equal(Number(ledger[0].budgetCredits), expectedCost);
        assert.equal(ledger[0].success, false);
      });
    }

    await isolated("pre-request failure releases the reservation without making a call", async () => {
      const fixture = setup(db);
      delete process.env.PARLAY_API_KEY;
      try {
        assert.equal((await fixture.refresh()).status, "failed");
        assert.equal(fixture.providerCalls(), 0);
        const ledger = await fixture.repository.readCreditLedger();
        assert.equal(Number(ledger[0].budgetCredits), 0);
        assert.equal(ledger[0].result_status, "PRE_DISPATCH_FAILURE");
      } finally { process.env.PARLAY_API_KEY = "fixture-only-not-a-real-key"; }
    });

    await isolated("zero limits fail closed; manual requests still obey the total monthly limit", async () => {
      const fixture = setup(db, { configuration: { monthlyLimit: 0, automaticBudget: 0 } });
      assert.equal((await fixture.refresh()).status, "failed");
      assert.equal(fixture.providerCalls(), 0);
      const manual = setup(db, { configuration: { monthlyLimit: 3, automaticBudget: 0 } });
      assert.equal((await manual.refresh({ automatic: true })).status, "failed");
      assert.equal((await manual.refresh({ automatic: false })).status, "promoted");
      assert.equal((await manual.refresh({ automatic: false })).status, "failed");
      assert.equal(manual.providerCalls(), 1);
    });

    await isolated("missing or invalid reservation configuration fails closed before provider dispatch", async () => {
      const fixture = setup(db, { configuration: { monthlyLimit: undefined, automaticBudget: undefined } });
      assert.equal((await fixture.refresh()).status, "failed");
      assert.equal(fixture.providerCalls(), 0);
      assert.equal((await fixture.repository.readCreditLedger()).length, 0);
    });

    await isolated("unbound persistent repository cannot bypass reservations", async () => {
      const fixture = setup(db);
      const provider = fixture.providerFactory({ repository: fixture.repository });
      await assert.rejects(provider.fetchPlayerProps(KEY), /refresh-bound reservation/);
      assert.equal(fixture.providerCalls(), 0);
    });

    await isolated("free events use bounded fetch and diagnostics but no paid reservation", async () => {
      const fixture = setup(db, { fetchImpl: async () => response(EVENTS) });
      const provider = fixture.providerFactory({ repository: fixture.repository });
      const result = await provider.listEvents(KEY);
      assert.equal(result.events.length, 14);
      assert.equal(fixture.calls.filter((call) => call.p_action === "reserve").length, 0);
      assert.equal(Number((await fixture.repository.readCreditLedger())[0].budgetCredits), 0);
    });

    await isolated("cache-only reader filters event, market, player and reports stale state without calling a provider", async () => {
      const fixture = setup(db);
      await fixture.refresh();
      const before = fixture.providerCalls();
      const reader = createOddsCacheReader({ repository: fixture.repository, now: () => new Date(Date.parse(NOW) + 10000000) });
      const result = await reader.read({ ...KEY, eventId: "event-0", market: "receptions", playerId: "fixture-chi" });
      assert.equal(result.quotes.length, 2);
      assert.equal(result.stale, true);
      assert.equal(result.quotes[0].provider, "parlay");
      assert.equal(result.quotes[0].freshnessStatus, "stale");
      assert.equal(result.quotes[0].snapshotGeneration, result.generation);
      assert.equal(fixture.providerCalls(), before);
      const missing = await reader.read({ ...KEY, week: 8 });
      assert.equal(missing.status, "missing");
      assert.equal(fixture.providerCalls(), before);
    });

    await isolated("future providers have separate scopes and logical quotes without schema changes", async () => {
      const fixture = setup(db);
      const good = await fixture.refresh();
      const key = { ...KEY, provider: "future-provider" };
      const scope = { ...key, ...await fixture.repository.acquireLease(key) };
      const refreshId = randomUUID();
      const snapshot = structuredClone(good.cache.snapshot);
      snapshot.provider = key.provider;
      snapshot.refreshId = refreshId;
      snapshot.events.forEach((event) => { event.provider = key.provider; });
      snapshot.quotes.forEach((quote) => { quote.provider = key.provider; });
      const validated = validateGeneration(snapshot, { expectedEvents: EVENTS, requiredMarkets: Object.values(PARLAY_MARKET_MAP) });
      await fixture.repository.startRefresh(scope, { refreshId, expectedEventIds: EVENTS.map((e) => e.providerEventId),
        requiredMarkets: Object.values(PARLAY_MARKET_MAP) });
      await fixture.repository.writeCandidate(scope, refreshId, validated);
      await fixture.repository.promote(scope, refreshId, validated);
      assert.equal((await fixture.repository.readCache(KEY)).generation, good.refreshId);
      assert.equal((await fixture.repository.readCache(key)).generation, refreshId);
    });

    await isolated("protected operation rejects unauthorized/implicit requests; plan and dry-run never write", async () => {
      const fixture = setup(db);
      let repositories = 0;
      let contexts = 0;
      const operation = createProviderRefreshOperation({
        secret: () => "fixture-admin",
        repositoryFactory: () => { repositories += 1; return fixture.repository; },
        providerFactory: fixture.providerFactory,
        contextLoader: async () => {
          contexts += 1;
          return { events: EVENTS, players: PLAYERS, fixture: { rows: props(), fetchedAt: NOW, completeness: COMPLETE } };
        },
      });
      const body = { season: 2026, week: 7, resource: "props", reason: "MANUAL_ADMIN_REFRESH", mode: "dry-run" };
      assert.equal((await operation({ method: "GET", body })).status, 405);
      assert.equal((await operation({ method: "POST", body, authorization: "Bearer wrong" })).status, 401);
      assert.equal(contexts, 0);
      const dry = await operation({ method: "POST", authorization: "Bearer fixture-admin", body });
      assert.equal(dry.result.status, "dry_run");
      assert.equal(repositories, 0);
      assert.equal(fixture.providerCalls(), 0);
      assert.equal(fixture.calls.length, 0);
      const plan = await operation({ method: "POST", authorization: "Bearer fixture-admin", body: { ...body, mode: "plan" } });
      assert.equal(plan.plan.maximumCredits, 3);
      assert.equal(contexts, 1);
      const persist = await operation({ method: "POST", authorization: "Bearer fixture-admin", body: { ...body, mode: "persist" } });
      assert.equal(persist.result.status, "promoted", persist.result.error);
      assert.equal(repositories, 1);
    });

    await isolated("database permissions reject non-service execution and hide new tables", async () => {
      await db.exec("set local role anon");
      const client = localClient(db);
      const result = await client.rpc("odds_provider_control", { p_action: "acquire", p: KEY });
      assert.match(result.error.message, /permission denied/);
      await db.exec("reset role");
    });

    await isolated("missing completeness evidence never promotes even with valid rows", async () => {
      const fixture = setup(db, { fetchImpl: async () => new Response(JSON.stringify(props())) });
      const result = await fixture.refresh();
      assert.equal(result.status, "failed");
      assert.equal(result.cache.snapshot, null);
    });

    await isolated("expired lease between pages stops the next paid request", async () => {
      const fixture = setup(db, { fetchImpl: async () => {
        await db.query("update public.odds_provider_scopes set lease_until=clock_timestamp()-interval '1 second'");
        return response(props(), { "x-result-has-more": "true", "x-next-offset": "10000" });
      } });
      const result = await fixture.refresh({ maxPages: 2 });
      assert.equal(result.status, "failed");
      assert.equal(fixture.providerCalls(), 1);
      assert.equal(result.error, "PROVIDER_REQUEST_FAILED");
      assert.equal((await fixture.repository.readCreditLedger()).length, 1);
    });

    await isolated("service-role can execute fenced RPCs but cannot write quote tables directly", async () => {
      const fixture = setup(db);
      await db.exec("set local role service_role");
      assert.equal((await fixture.repository.acquireLease(KEY)).acquired, true);
      const permissions = await db.query(
        "select has_table_privilege(current_user,'public.odds_provider_quotes','INSERT') as allowed");
      assert.equal(permissions.rows[0].allowed, false);
      await db.exec("reset role");
    });

    await isolated("persisted generation validator rejects malformed prices and conflicting duplicate quotes", async () => {
      const fixture = setup(db);
      const result = await fixture.refresh();
      const snapshot = structuredClone(result.cache.snapshot);
      const context = { expectedEvents: EVENTS, requiredMarkets: Object.values(PARLAY_MARKET_MAP) };
      snapshot.quotes[0].decimalOdds = 1;
      assert.throws(() => validateGeneration(snapshot, context), /Malformed quote/);
      snapshot.quotes[0] = { ...result.cache.snapshot.quotes[0], rawPrice: { value: 200 } };
      assert.throws(() => validateGeneration(snapshot, context), /Malformed quote/);
      snapshot.quotes = [...result.cache.snapshot.quotes, {
        ...result.cache.snapshot.quotes[0], providerTimestamp: "2026-01-01T00:00:00.000Z",
      }];
      assert.throws(() => validateGeneration(snapshot, context), /Conflicting duplicate/);
    });

    await isolated("SQL promotion rejects partial event/market coverage even outside the refresh service", async () => {
      const fixture = setup(db);
      const result = await fixture.refresh();
      const scope = { ...KEY, ...await fixture.repository.acquireLease(KEY) };
      const refreshId = randomUUID();
      const candidate = structuredClone(result.cache.snapshot);
      candidate.refreshId = refreshId;
      candidate.quotes = candidate.quotes.filter((quote) => quote.providerEventId !== "event-13");
      candidate.quotes.forEach((quote) => { quote.refreshId = refreshId; });
      await fixture.repository.startRefresh(scope, {
        refreshId, expectedEventIds: EVENTS.map((event) => event.providerEventId),
        requiredMarkets: Object.values(PARLAY_MARKET_MAP),
      });
      await fixture.repository.writeCandidate(scope, refreshId, candidate);
      await assert.rejects(fixture.repository.promote(scope, refreshId, candidate), /Odds persistence promote failed/);
      assert.equal((await fixture.repository.readCache(KEY)).generation, result.refreshId);
    });

    assert.equal(planProviderRefresh({ resource: "props", maxPages: 4 }).maximumCredits, 12);
  } finally {
    if (originalKey === undefined) delete process.env.PARLAY_API_KEY;
    else process.env.PARLAY_API_KEY = originalKey;
    await db.close();
  }
});
