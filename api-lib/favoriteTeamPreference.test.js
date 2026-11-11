import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { readFavoriteTeam, saveFavoriteTeamPreference } from "../src/services/favoriteTeamPreference.js";

let server, App, Settings;
before(async () => {
  server = await createServer({
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{
      name: "favorite-team-component-hooks",
      transform(code, id) {
        if (/\/src\/(?:App|pages\/Settings)\.jsx$/.test(id.replace(/\\/g, "/"))) {
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

test("absent or invalid stored values use SF without writing over storage", (t) => {
  const { values, writes } = storage(t);
  assert.equal(readFavoriteTeam(), "SF");
  for (const invalid of ["INVALID", "gb", "San Francisco 49ers", "toString", ""]) {
    values.set("favoriteTeam", invalid);
    assert.equal(readFavoriteTeam(), "SF");
  }
  assert.deepEqual(writes, []);
  assert.throws(() => saveFavoriteTeamPreference("INVALID"), /Invalid favourite/);
});

test("GB survives reload/reopen and MIN replaces GB without startup writes", (t) => {
  const { writes } = storage(t);
  saveFavoriteTeamPreference("GB");
  assert.equal(readFavoriteTeam(), "GB");
  assert.equal(readFavoriteTeam(), "GB");
  saveFavoriteTeamPreference("MIN");
  assert.equal(readFavoriteTeam(), "MIN");
  assert.deepEqual(writes, [["favoriteTeam", "GB"], ["favoriteTeam", "MIN"]]);
});

test("storage failure reports an error without claiming Settings was saved", (t) => {
  const hooks = globalThis.favoriteTeamTestHooks;
  hooks.unmount();
  t.mock.method(console, "warn", () => {});
  const props = { favoriteTeam: "MIN", onSave() { throw new Error("Storage unavailable"); } };
  let settings = Settings(props);
  find(settings, (node) => node.type === "select").props.onChange({ target: { value: "GB" } });
  hooks.reset();
  settings = Settings(props);
  assert.match(find(settings, (node) => node.props?.role === "alert").props.children, /could not be saved/);
  assert.equal(find(settings, (node) => node.props?.className === "success"), undefined);
  assert.equal(find(settings, (node) => node.type === "select").props.value, "MIN");
});

test("Settings selection immediately persists through App rerender, navigation and remount", (t) => {
  const { writes } = storage(t);
  Object.defineProperty(globalThis, "window", { value: { scrollTo() {} }, configurable: true });
  t.after(() => { delete globalThis.window; });
  const hooks = globalThis.favoriteTeamTestHooks;
  hooks.unmount();
  const renderApp = () => { hooks.reset(); return App(); };
  const settingsProps = () => find(renderApp(), (node) => typeof node.props?.onSave === "function").props;
  let tree = renderApp();
  assert.equal(find(tree, (node) => node.props?.favoriteTeam === "SF").props.favoriteTeam, "SF");
  find(tree, (node) => node.props?.page === "home" && node.props.onChange).props.onChange("settings");
  let props = settingsProps();
  const settings = Settings(props);
  find(settings, (node) => node.type === "select").props.onChange({ target: { value: "GB" } });
  assert.deepEqual(writes, [["favoriteTeam", "GB"]]);
  props = settingsProps();
  assert.equal(props.favoriteTeam, "GB");
  props.onSave("MIN");
  assert.equal(settingsProps().favoriteTeam, "MIN");
  tree = renderApp();
  find(tree, (node) => node.props?.page === "settings" && node.props.onChange).props.onChange("home");
  renderApp();
  hooks.unmount();
  assert.equal(find(renderApp(), (node) => node.props?.favoriteTeam === "MIN").props.favoriteTeam, "MIN");
  renderApp();
  assert.deepEqual(writes, [["favoriteTeam", "GB"], ["favoriteTeam", "MIN"]]);
});
