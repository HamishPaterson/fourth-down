import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const browser = [
  process.env.AUTH_TEST_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((path) => path && existsSync(path));

test("mounted AuthGate preserves real App navigation during background revalidation", {
  skip: !browser && "Set AUTH_TEST_BROWSER to an installed Chromium browser",
  timeout: 60000,
}, async (t) => {
  let report;
  const requests = [];
  const completed = new Promise((resolve) => { report = resolve; });
  const profile = mkdtempSync(join(tmpdir(), "fourth-down-auth-navigation-"));
  const server = await createServer({
    configFile: false, appType: "custom", cacheDir: join(profile, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [{
      name: "auth-navigation-boundaries",
      resolveId(id) { if (id === "/__auth-navigation-test.js") return id; },
      load(id) { if (id === "/__auth-navigation-test.js") return browserTest; },
      transform(code, id) {
        const file = id.replace(/\\/g, "/");
        if (file.endsWith("/src/components/AuthGate.jsx")) {
          return code.replace('import { getAuthClient } from "../services/supabaseAuth.js";',
            "const getAuthClient = () => globalThis.authNavigation.client;");
        }
        if (file.endsWith("/src/App.jsx")) {
          return code.replace(/import (\w+) from "\.\/(?:pages|components)\/[^"]+";/g,
            "const $1 = globalThis.authNavigation.components.$1;");
        }
      },
      configureServer(vite) {
        vite.middlewares.use((req, _res, next) => { requests.push(req.url); next(); });
        vite.middlewares.use("/__auth-navigation-report", (req, res) => {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => { report(JSON.parse(body)); res.end("ok"); });
        });
        vite.middlewares.use("/__auth-navigation-page", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(`<div id="root"></div><script>
            for (const type of ["error", "unhandledrejection"]) addEventListener(type, event =>
              fetch("/__auth-navigation-report", { method: "POST",
                body: JSON.stringify({ fatal: String(event.error?.stack || event.reason || event.message) }) }));
            </script><script type="module" src="/__auth-navigation-test.js"></script>`);
        });
      },
    }, react()],
  });
  let child;
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__auth-navigation-page`;
    assert.equal((await fetch(url)).status, 200);
    child = spawn(browser, ["--headless", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--disable-background-timer-throttling",
      `--user-data-dir=${join(profile, "browser")}`, url], { stdio: "ignore" });
    const failed = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Test browser exited before reporting (${code})`)));
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Auth navigation browser tests timed out: ${requests.slice(-10).join(", ")}`)), 45000);
    });
    let results;
    try { results = await Promise.race([completed, failed, timeout]); }
    finally { clearTimeout(timer); }
    assert.equal(results.fatal, undefined, results.fatal);
    assert.equal(results.cases.length, 24);
    for (const result of results.cases) {
      await t.test(result.name, () => assert.equal(result.error, undefined, result.error));
    }
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const browserTest = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
const cases = [];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const waitFor = async (predicate) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(); }
  throw new Error("Timed out waiting for auth/navigation");
};
const run = async (name, action) => {
  try { await action(); cases.push({ name }); }
  catch (error) { cases.push({ name, error: error.stack }); throw error; }
};
let callback, approved = true, deferred = false, pending = [], mounts = 0;
const session = { access_token: "test-token", user: { id: "approved", email: "test@example.test" } };
const emit = (event = "SIGNED_IN", next = session) => callback(event, next);
function Screen({ name, game, team, onOpen, onOpenTeam }) {
  const [instance] = useState(() => ++mounts), [count, setCount] = useState(0);
  return React.createElement("section", { "data-screen": name, "data-instance": instance,
    "data-selection": JSON.stringify(game || team || null) },
    React.createElement("button", { id: "local-state", onClick: () => setCount(count + 1) }, count),
    onOpen && React.createElement("button", { id: "open-matchup",
      onClick: () => onOpen({ id: "NE-CHI", week: 8 }) }, "Open matchup"),
    onOpenTeam && React.createElement("button", { id: "open-team",
      onClick: () => onOpenTeam({ abbreviation: "NE" }) }, "Open team"));
}
const components = Object.fromEntries(["Home", "Matchup", "Teams", "TeamDetail", "Conference",
  "Settings", "Predictions", "Results", "DataHealth"].map(name =>
    [name, props => React.createElement(Screen, { name, ...props })]));
components.Header = () => null;
components.TeamPicker = () => null;
components.Navigation = ({ onChange }) => React.createElement("nav", null,
  ...["predictions", "teams", "results", "schedule"].map(name =>
    React.createElement("button", { key: name, id: "nav-" + name, onClick: () => onChange(name) }, name)));
globalThis.authNavigation = { components, client: {
  auth: {
    onAuthStateChange(fn) {
      callback = fn;
      const focus = () => emit();
      const visible = () => { if (document.visibilityState === "visible") emit(); };
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visible);
      return { data: { subscription: { unsubscribe() {
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", visible);
      } } } };
    },
    async getSession() { return { data: { session }, error: null }; },
  },
  from() { return {
    select() { return this; }, eq() { return this; },
    async maybeSingle() {
      if (deferred) await new Promise(resolve => pending.push(resolve));
      return { data: { user_id: session.user.id, approved }, error: null };
    },
  }; },
} };
const screen = () => document.querySelector("[data-screen]");
const click = async id => { document.getElementById(id).click(); await pause(); };
let root;
try {
  const { default: Gate } = await import("/src/components/AuthGate.jsx");
  root = createRoot(document.getElementById("root"));
  root.render(React.createElement(Gate));
  await waitFor(screen);
  for (const route of ["matchup", "team", "predictions", "results", "schedule"]) {
    await click("nav-" + (route === "matchup" ? "predictions" : route === "team" ? "teams" : route));
    if (route === "matchup") await click("open-matchup");
    if (route === "team") await click("open-team");
    await click("local-state");
    history.replaceState(null, "", "/__auth-navigation-page#" + route);
    const url = location.href, before = screen().outerHTML, instance = screen(), mountCount = mounts;
    for (const event of ["focus loss/regain", "visibility hidden/visible", "token refresh", "approval recheck"]) {
      await run(route + ": " + event, async () => {
        deferred = true;
        if (event === "focus loss/regain") {
          window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus"));
        } else if (event === "visibility hidden/visible") {
          for (const state of ["hidden", "visible"]) {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
            document.dispatchEvent(new Event("visibilitychange"));
          }
        } else emit(event === "token refresh" ? "TOKEN_REFRESHED" : "USER_UPDATED",
          { ...session, access_token: "refreshed-token" });
        await pause();
        check(pending.length > 0, "Approval must actually be rechecked");
        check(screen() === instance && screen().outerHTML === before, "Pending revalidation remounted/reset the page");
        deferred = false;
        pending.splice(0).forEach(resolve => resolve());
        await pause();
        check(screen() === instance && screen().outerHTML === before && mounts === mountCount,
          "Successful revalidation remounted/reset route, selection or local state");
        check(location.href === url, "Revalidation changed the current URL");
      });
    }
  }
  for (const [name, deny] of [
    ["revoked approval", () => { approved = false; emit("USER_UPDATED"); }],
    ["genuine sign out", () => emit("SIGNED_OUT", null)],
    ["absent session", () => emit("TOKEN_REFRESHED", null)],
    ["API revocation", () => window.dispatchEvent(new CustomEvent("fourth-down:access-denied", { detail: 403 }))],
  ]) {
    await run(name + " blocks access", async () => {
      approved = true; emit(); await waitFor(screen);
      deny(); await pause();
      check(!screen(), name + " did not remove the authenticated application");
      check(/Awaiting Approval|Sign In/.test(document.body.textContent), "Missing blocking auth screen");
    });
  }
  await fetch("/__auth-navigation-report", { method: "POST", body: JSON.stringify({ cases }) });
} catch (error) {
  await fetch("/__auth-navigation-report", { method: "POST", body: JSON.stringify({ cases, fatal: error.stack }) });
} finally { root?.unmount(); }
`;
