import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSession } from "../src/services/authSession.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(initial = null) {
  let callback, current = initial;
  const profiles = new Map(), writes = [], states = [], authCalls = [];
  const session = (id) => ({ access_token: `jwt-${id}`, user: { id, email: `${id}@example.test` } });
  const client = {
    auth: {
      onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() { callback = null; } } } }; },
      async getSession() { return { data: { session: current }, error: null }; },
      async signInWithPassword(credentials) {
        authCalls.push(["signIn", credentials]);
        current = session(credentials.email.split("@")[0]);
        callback?.("SIGNED_IN", current);
        return { data: { session: current }, error: null };
      },
      async signUp(credentials) {
        authCalls.push(["signUp", credentials]);
        const id = credentials.email.split("@")[0];
        profiles.set(id, false);
        current = session(id);
        callback?.("SIGNED_IN", current);
        return { data: { session: current }, error: null };
      },
      async signOut() { current = null; callback?.("SIGNED_OUT", null); return { error: null }; },
    },
    from(table) {
      assert.equal(table, "app_users");
      let id;
      return {
        select(value) { assert.equal(value, "user_id, approved"); return this; },
        eq(key, value) { assert.equal(key, "user_id"); id = value; return this; },
        async maybeSingle() { return { data: profiles.has(id) ? { user_id: id, approved: profiles.get(id) } : null, error: null }; },
      };
    },
  };
  return { client, profiles, states, writes, authCalls, session,
    emit(next) { current = next; callback?.("SIGNED_IN", next); } };
}

test("no session resolves to sign in; signup calls Supabase and never grants approval", async () => {
  const f = fixture(), controller = createAuthSession(f.client, (state) => f.states.push(state));
  const stop = controller.start();
  await flush();
  assert.equal(f.states.at(-1).status, "signedOut");
  await controller.signUp("new@example.test", "password");
  await flush();
  assert.deepEqual(f.authCalls, [["signUp", { email: "new@example.test", password: "password" }]]);
  assert.equal(f.states.at(-1).status, "pending");
  assert.equal(f.profiles.get("new"), false);
  assert.deepEqual(f.writes, []);
  stop();
});

test("approved session restores on remount; sign out returns to login and accounts stay isolated", async () => {
  const f = fixture();
  f.profiles.set("approved", true);
  f.profiles.set("pending", false);
  let controller = createAuthSession(f.client, (state) => f.states.push(state));
  let stop = controller.start();
  await flush();
  await controller.signIn("approved@example.test", "password");
  await flush();
  assert.equal(f.states.at(-1).status, "approved");
  stop();
  controller = createAuthSession(f.client, (state) => f.states.push(state));
  stop = controller.start();
  await flush();
  assert.equal(f.states.at(-1).status, "approved");
  f.emit(f.session("pending"));
  await flush();
  assert.equal(f.states.at(-1).status, "pending");
  await controller.signOut();
  assert.equal(f.states.at(-1).status, "signedOut");
  stop();
});

test("approval removal and API denial immediately remove app access", async () => {
  const f = fixture();
  f.profiles.set("user", true);
  const controller = createAuthSession(f.client, (state) => f.states.push(state));
  const stop = controller.start();
  await controller.signIn("user@example.test", "password");
  await flush();
  assert.equal(f.states.at(-1).status, "approved");
  f.profiles.set("user", false);
  controller.deny(403);
  assert.equal(f.states.at(-1).status, "pending");
  await controller.retry();
  assert.equal(f.states.at(-1).status, "pending");
  controller.deny(401);
  assert.equal(f.states.at(-1).status, "signedOut");
  stop();
});

test("late session restoration and approval reads cannot resurrect a signed-out app", async () => {
  const f = fixture();
  let finishSession, finishProfile;
  f.client.auth.getSession = () => new Promise((resolve) => { finishSession = resolve; });
  f.client.from = () => ({
    select() { return this; }, eq() { return this; },
    maybeSingle: () => new Promise((resolve) => { finishProfile = resolve; }),
  });
  const controller = createAuthSession(f.client, (state) => f.states.push(state));
  const stop = controller.start();
  f.emit(f.session("late"));
  await controller.signOut();
  finishProfile({ data: { user_id: "late", approved: true }, error: null });
  finishSession({ data: { session: f.session("late") }, error: null });
  await flush();
  assert.equal(f.states.at(-1).status, "signedOut");
  stop();
});

test("confirmation-required signup does not imply a session or approval", async () => {
  const f = fixture();
  f.client.auth.signUp = async (credentials) => {
    f.authCalls.push(["signUp", credentials]);
    return { data: { session: null, user: { id: "confirmation-user" } }, error: null };
  };
  const controller = createAuthSession(f.client, (state) => f.states.push(state));
  const stop = controller.start();
  await flush();
  await controller.signUp("confirm@example.test", "password");
  assert.equal(f.states.at(-1).status, "signedOut");
  stop();
});

test("missing own-row evidence fails closed and stopped controllers cannot emit approval", async () => {
  const f = fixture();
  const controller = createAuthSession(f.client, (state) => f.states.push(state));
  const stop = controller.start();
  f.emit(f.session("missing"));
  await flush();
  assert.equal(f.states.at(-1).status, "error");
  assert.match(f.states.at(-1).error, /approval record/);
  stop();
  const count = f.states.length;
  f.emit(f.session("other"));
  await flush();
  assert.equal(f.states.length, count);
});
