import test from "node:test";
import assert from "node:assert/strict";
import { fetchSchedule } from "./balldontlie-schedule.mjs";

const ok = (data, cursor = null) => new Response(JSON.stringify({
  data, meta: { next_cursor: cursor },
}), { status: 200 });
const limited = (retryAfter) => new Response(null, {
  status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
});

function harness(t, responses) {
  const previousKey = process.env.BALLDONTLIE_API_KEY;
  process.env.BALLDONTLIE_API_KEY = "test-secret-not-for-output";
  t.after(() => {
    if (previousKey === undefined) delete process.env.BALLDONTLIE_API_KEY;
    else process.env.BALLDONTLIE_API_KEY = previousKey;
  });
  const calls = [], waits = [], diagnostics = [];
  let active = 0;
  const options = {
    fetchImpl: async (url, init) => {
      assert.equal(++active, 1, "requests must be sequential");
      assert.equal(init.headers.Authorization, "test-secret-not-for-output");
      calls.push(url.toString());
      await Promise.resolve();
      active--;
      assert.ok(responses.length, "unexpected request");
      return responses.shift();
    },
    sleep: async (ms) => { waits.push(ms); },
    now: () => Date.parse("2026-10-15T00:00:00Z"),
    random: () => 0.5,
    warn: (message) => diagnostics.push(message),
  };
  return { run: () => fetchSchedule(2026, options), calls, waits, diagnostics };
}

test("normal pagination retains pages, requests sequentially and paces", async (t) => {
  const h = harness(t, [ok([{ id: 1 }], 100), ok([{ id: 2 }], 200), ok([{ id: 3 }])]);
  assert.deepEqual(await h.run(), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(h.calls.map((url) => new URL(url).searchParams.get("cursor")), [null, "100", "200"]);
  assert.deepEqual(h.waits, [12_500, 12_500]);
  assert.equal(new URL(h.calls[0]).searchParams.get("seasons[]"), "2026");
  assert.equal(new URL(h.calls[0]).searchParams.get("per_page"), "100");
});

test("later-page 429 honors seconds, retries same page and never refetches completed pages", async (t) => {
  const h = harness(t, [ok([{ id: 1 }], 100), limited("7"), ok([{ id: 2 }])]);
  assert.deepEqual(await h.run(), [{ id: 1 }, { id: 2 }]);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1], h.calls[2]);
  assert.notEqual(h.calls[0], h.calls[1]);
  assert.deepEqual(h.waits, [12_500, 7000]);
  assert.match(h.diagnostics[0], /page 2.*429.*retry 1\/3.*7000ms/);
  assert.doesNotMatch(h.diagnostics.join("\n"), /test-secret-not-for-output|authorization|BALLDONTLIE_API_KEY/i);
});

test("Retry-After HTTP-date is honored", async (t) => {
  const h = harness(t, [limited("Thu, 15 Oct 2026 00:00:09 GMT"), ok([])]);
  await h.run();
  assert.deepEqual(h.waits, [9000]);
});

test("past HTTP-date and zero seconds require no extra backoff", async (t) => {
  const h = harness(t, [limited("Wed, 14 Oct 2026 00:00:00 GMT"), limited("0"), ok([])]);
  await h.run();
  assert.deepEqual(h.waits, [0, 0]);
});

for (const header of [undefined, "invalid", "-1", " "]) {
  test(`missing/unusable Retry-After (${JSON.stringify(header)}) uses bounded exponential backoff`, async (t) => {
    const h = harness(t, [limited(header), limited(header), limited(header), ok([])]);
    await h.run();
    assert.deepEqual(h.waits, [1125, 2125, 4125]);
    assert.ok(h.waits.every((ms) => ms <= 8000));
    assert.ok(h.calls.every((url) => url === h.calls[0]));
  });
}

test("retry exhaustion fails explicitly after initial attempt plus three retries", async (t) => {
  const h = harness(t, Array.from({ length: 4 }, () => limited()));
  await assert.rejects(h.run(), /page 1 failed \(429\): exhausted 3 retries/);
  assert.equal(h.calls.length, 4);
  assert.equal(h.waits.length, 3);
  assert.doesNotMatch(h.diagnostics.join("\n"), /test-secret-not-for-output|authorization|BALLDONTLIE_API_KEY/i);
});

for (const cursors of [[100, 100], [100, 200, 100]]) {
  test(`repeated/cyclic cursor ${cursors.join(",")} fails before requesting it again`, async (t) => {
    const h = harness(t, cursors.map((cursor) => ok([], cursor)));
    await assert.rejects(h.run(), /repeated cursor/);
    assert.equal(h.calls.length, cursors.length);
  });
}

test("maximum-page guard fails without requesting page 21", async (t) => {
  const h = harness(t, Array.from({ length: 20 }, (_, i) => ok([], i + 1)));
  await assert.rejects(h.run(), /pagination incomplete after 20 pages/);
  assert.equal(h.calls.length, 20);
});

test("non-429 failures and malformed data fail without retry", async (t) => {
  const h = harness(t, [new Response(null, { status: 403 })]);
  await assert.rejects(h.run(), /page 1 failed \(403\)/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
  const invalid = harness(t, [new Response('{"data":null}')]);
  await assert.rejects(invalid.run(), /Invalid BALLDONTLIE schedule response/);
});
