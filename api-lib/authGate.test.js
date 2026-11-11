import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let server, Gate, state, loads = 0, calls = 0, fakeSession;
before(async () => {
  globalThis.authGateHooks = {
    useState(initial) { return [initial?.status ? state : initial, () => {}]; },
    useEffect() {}, useRef() { return { current: null }; },
  };
  globalThis.loadApprovedTestApp = async () => {
    loads++;
    return { default: () => createElement("div", null, "Approved Fourth Down") };
  };
  globalThis.createTestAuthClient = (_url, _key, options) => {
    assert.equal(options.auth.persistSession, true);
    assert.equal(options.auth.autoRefreshToken, true);
    return { auth: { getSession: async () => ({ data: { session: fakeSession }, error: null }) } };
  };
  server = await createServer({
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{
      name: "auth-gate-test-boundaries",
      transform(code, id) {
        const file = id.replace(/\\/g, "/");
        if (file.endsWith("/src/components/AuthGate.jsx")) {
          return code.replace('import { lazy, Suspense, useEffect, useRef, useState } from "react";',
            'import { lazy, Suspense } from "react"; const { useEffect, useRef, useState } = globalThis.authGateHooks;')
            .replace('import("../App.jsx")', "globalThis.loadApprovedTestApp()");
        }
        if (file.endsWith("/src/services/supabaseAuth.js")) {
          return code.replace('import { createClient } from "@supabase/supabase-js";',
            "const createClient = globalThis.createTestAuthClient;")
            .replace("import.meta.env?.VITE_SUPABASE_URL", '"https://auth.example.test"')
            .replace("import.meta.env?.VITE_SUPABASE_ANON_KEY", '"browser-anon-key"');
        }
      },
    }],
  });
  Gate = (await server.ssrLoadModule("/src/components/AuthGate.jsx")).default;
});
after(async () => {
  await server?.close();
  delete globalThis.authGateHooks;
  delete globalThis.loadApprovedTestApp;
  delete globalThis.createTestAuthClient;
});

for (const [status, text] of [["loading", "Checking your session"], ["signedOut", "Sign In"],
  ["pending", "Awaiting Approval"], ["error", "Approval unavailable"]]) {
  test(`${status} renders its gate without loading normal Fourth Down or starting requests`, (t) => {
    t.mock.method(globalThis, "fetch", () => { calls++; assert.fail("Gate must not request app data"); });
    state = { status, session: status === "pending" ? { user: { id: "pending" } } : null,
      error: "Approval unavailable" };
    const markup = renderToStaticMarkup(createElement(Gate));
    assert.match(markup, new RegExp(text));
    assert.equal(loads, 0);
    assert.equal(calls, 0);
    assert.doesNotMatch(markup, /name="approved"|Approve account/);
  });
}

test("approved state alone loads the application and offers sign out", async () => {
  state = { status: "approved", session: { user: { id: "approved", email: "approved@example.test" } } };
  let markup = renderToStaticMarkup(createElement(Gate));
  assert.equal(loads, 1);
  await new Promise((resolve) => setImmediate(resolve));
  markup = renderToStaticMarkup(createElement(Gate));
  assert.match(markup, /Approved Fourth Down/);
  assert.match(markup, /Sign out/);
});

test("all browser API calls attach the current JWT, avoid shared caching and report revocation", async (t) => {
  const { apiFetch } = await server.ssrLoadModule("/src/services/supabaseAuth.js");
  const events = [], requests = [];
  globalThis.window = { location: { origin: "https://fourth-down.example.test" }, dispatchEvent(event) { events.push(event); } };
  t.after(() => { delete globalThis.window; });
  fakeSession = { access_token: "first-user-jwt" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return { status: 403 };
  });
  await apiFetch("/api/nfl/teams");
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer first-user-jwt");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(events[0].detail, 403);
  fakeSession = { access_token: "second-user-jwt" };
  await apiFetch("/api/nfl/odds");
  assert.equal(requests[1].options.headers.get("Authorization"), "Bearer second-user-jwt");
  await assert.rejects(apiFetch("https://third-party.example.test/api/anything"), /same-origin/);
  fakeSession = null;
  await assert.rejects(apiFetch("/api/nfl/teams"), /sign in/);
  assert.equal(requests.length, 2);
});
