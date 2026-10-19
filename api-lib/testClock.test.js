import test from "node:test";
import assert from "node:assert/strict";
import { validateOddsEvents } from "../src/services/quoteValidation.js";
import { FIXED_TEST_TIME, fixedTestNow, mockTestClock } from "./testClock.js";

const runtimeDate = Date;
const eventAt = (timestamp) => ({
  id: "clock-fixture", away_team: "SEA", home_team: "DEN",
  bookmakers: [{ key: "book", last_update: timestamp, markets: [{
    key: "h2h", outcomes: [{ name: "SEA", price: 100 }],
  }] }],
});

test("quote validation defaults to the operation's runtime clock; explicit now is operation-local", () => {
  const now = Date.now();
  const event = eventAt(new Date(now - 30 * 3600000 - 60000).toISOString());
  const implicit = validateOddsEvents([event]);
  const explicit = validateOddsEvents([event], { now: new Date(now) });
  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.quarantined.length, 1);
  const overridden = validateOddsEvents([event], { now: new Date(now - 120000) });
  assert.equal(overridden.quarantined.length, 0);
  assert.equal(validateOddsEvents([event]).quarantined.length, 1);
  assert.equal(Date, runtimeDate);
});

test("fixed UTC clock controls Date.now and new Date only in this test context", (t) => {
  mockTestClock(t);
  assert.equal(Date.now(), Date.parse(FIXED_TEST_TIME));
  assert.equal(new Date().toISOString(), fixedTestNow().toISOString());
  assert.equal(validateOddsEvents([eventAt("2026-10-14T20:00:00Z")]).quarantined.length, 0);
});

test("Node restores the runtime Date after the preceding mocked test", () => {
  assert.equal(Date, runtimeDate);
});
