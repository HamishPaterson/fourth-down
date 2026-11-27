import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import {
  accountFavoriteTeam,
  readFavoriteTeam,
  readFavoriteTeamChoice,
  saveFavoriteTeamPreference,
} from "../src/services/favoriteTeamPreference.js";
import { TEAM_ACCENTS, contrastRatio, ACCENT_INK } from "../src/services/teamAccent.js";
import { TEAM_NAMES } from "../src/data.js";

let server, App, Settings;
before(async () => {
  server = await createServer({
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{
      name: "favorite-team-component-hooks",
      transform(code, id) {
        if (/\/src\/(?:App|pages\/Settings|components\/TeamPicker)\.jsx$/.test(id.replace(/\\/g, "/"))) {
          return code.replace(/import \{ ([^}]+) \} from "react";/,
            "const { $1 } = globalThis.favoriteTeamTestHooks;");
        }
      },
    }],
  });
  const states = [];
  let cursor = 0;
  globalThis.favoriteTeamTestHooks = {
    reset() { cursor = 0; },
    unmount() { states.length = 0; cursor = 0; },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = value; }];
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
  };
  App = (await server.ssrLoadModule("/src/App.jsx")).default;
  Settings = (await server.ssrLoadModule("/src/pages/Settings.jsx")).default;
  // The app reads and writes the favourite on the account; tests use a stand-in client.
  const updates = [];
  globalThis.favoriteTeamAccountUpdates = updates;
  (await server.ssrLoadModule("/src/services/supabaseAuth.js")).setAuthClientForTests({ auth: {
    getSession: async () => ({ data: { session: null } }),
    updateUser: async ({ data }) => { updates.push(data.favorite_team); return { error: null }; },
  } });
});
after(async () => {
  await server?.close();
  delete globalThis.favoriteTeamTestHooks;
});

function storage(t, initial) {
  const values = new Map(initial ? [["favoriteTeam", initial]] : []);
  const writes = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); },
    removeItem(key) { writes.push([key, null]); values.delete(key); },
  }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  return { values, writes };
}

function find(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  return [element.props?.children].flat(Infinity).map((child) => find(child, predicate)).find(Boolean);
}

test("no stored answer means no team and the question is still open; invalid values are ignored", (t) => {
  const { values, writes } = storage(t);
  assert.deepEqual(readFavoriteTeamChoice(), { team: null, decided: false });
  assert.equal(readFavoriteTeam(), null);
  for (const invalid of ["INVALID", "gb", "San Francisco 49ers", "toString", ""]) {
    values.set("favoriteTeam", invalid);
    assert.deepEqual(readFavoriteTeamChoice(), { team: null, decided: false });
  }
  assert.deepEqual(writes, []);
  assert.throws(() => saveFavoriteTeamPreference("INVALID"), /Invalid favourite/);
});

test("a team survives reload, can be replaced, and can be cleared to no team", (t) => {
  const { writes } = storage(t);
  saveFavoriteTeamPreference("GB");
  assert.deepEqual(readFavoriteTeamChoice(), { team: "GB", decided: true });
  saveFavoriteTeamPreference("MIN");
  assert.equal(readFavoriteTeam(), "MIN");
  saveFavoriteTeamPreference(null);
  assert.deepEqual(readFavoriteTeamChoice(), { team: null, decided: true });
  assert.deepEqual(writes, [
    ["favoriteTeam", "GB"], ["favoriteTeamChoice", null],
    ["favoriteTeam", "MIN"], ["favoriteTeamChoice", null],
    ["favoriteTeam", null], ["favoriteTeamChoice", "none"],
  ]);
});

test("the account's saved answer reads as a team, no team, or never answered", () => {
  assert.equal(accountFavoriteTeam({ user_metadata: { favorite_team: "PIT" } }), "PIT");
  assert.equal(accountFavoriteTeam({ user_metadata: { favorite_team: "none" } }), null);
  assert.equal(accountFavoriteTeam({ user_metadata: { favorite_team: "XYZ" } }), undefined);
  assert.equal(accountFavoriteTeam({ user_metadata: {} }), undefined);
  assert.equal(accountFavoriteTeam(null), undefined);
});

test("every team has an accent readable on the dark background and under dark text", () => {
  assert.deepEqual(Object.keys(TEAM_ACCENTS).sort(), Object.keys(TEAM_NAMES).sort());
  for (const [code, [, accent]] of Object.entries(TEAM_ACCENTS)) {
    assert.ok(contrastRatio(accent, "#0C0D11") >= 4.5, `${code} accent on background`);
    assert.ok(contrastRatio(accent, "#16181E") >= 4.5, `${code} accent on cards`);
    assert.ok(contrastRatio(accent, ACCENT_INK) >= 4.5, `${code} text on accent`);
  }
});

test("storage failure reports an error without claiming Settings was saved", (t) => {
  const hooks = globalThis.favoriteTeamTestHooks;
  hooks.unmount();
  t.mock.method(console, "warn", () => {});
  const props = { favoriteTeam: "MIN", onSave() { throw new Error("Storage unavailable"); } };
  let settings = Settings(props);
  find(settings, (node) => node.props?.className === "secondary").props.onClick();
  hooks.reset();
  settings = Settings(props);
  find(settings, (node) => node.props?.mode === "settings").props.onConfirm("GB");
  hooks.reset();
  settings = Settings(props);
  assert.match(find(settings, (node) => node.props?.role === "alert").props.children, /could not be saved/);
  assert.equal(find(settings, (node) => node.props?.className === "success"), undefined);
});

test("first open asks for a team; the answer persists, reaches the account, and Settings can change it", (t) => {
  const { writes } = storage(t);
  Object.defineProperty(globalThis, "window", { value: { scrollTo() {} }, configurable: true });
  t.after(() => { delete globalThis.window; });
  const updates = globalThis.favoriteTeamAccountUpdates;
  updates.length = 0;
  const hooks = globalThis.favoriteTeamTestHooks;
  hooks.unmount();
  const renderApp = () => { hooks.reset(); return App(); };
  const picker = () => find(renderApp(), (node) => typeof node.props?.onConfirm === "function" && node.props?.onSkip);
  assert.ok(picker(), "the team picker opens on first use");
  picker().props.onConfirm("PIT");
  assert.equal(picker(), undefined, "the picker closes once answered");
  assert.equal(find(renderApp(), (node) => node.props?.favoriteTeam === "PIT").props.favoriteTeam, "PIT");
  assert.equal(renderApp().props.style["--accent"], TEAM_ACCENTS.PIT[1]);
  find(renderApp(), (node) => node.props?.page === "predictions" && node.props.onChange).props.onChange("settings");
  const settings = find(renderApp(), (node) => typeof node.props?.onSave === "function").props;
  settings.onSave(null);
  assert.equal(renderApp().props.style["--accent"], "#FF6B1A");
  hooks.unmount();
  assert.equal(picker(), undefined, "a reopened app does not ask again");
  assert.deepEqual(updates, ["PIT", "none"]);
  assert.deepEqual(writes.filter(([key]) => key === "favoriteTeam"), [["favoriteTeam", "PIT"], ["favoriteTeam", null]]);
});
