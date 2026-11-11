import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getAuthClient } from "../services/supabaseAuth.js";
import { createAuthSession } from "../services/authSession.js";

const ApprovedApp = lazy(() => import("../App.jsx"));

export default function AuthGate() {
  const [state, setState] = useState({ status: "loading", session: null });
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [createAccount, setCreateAccount] = useState(false);
  const [message, setMessage] = useState(null);
  const controller = useRef(null);
  useEffect(() => {
    let auth;
    try {
      auth = createAuthSession(getAuthClient(), setState);
    } catch (error) {
      setState({ status: "error", session: null, error: error.message });
      return;
    }
    controller.current = auth;
    const stop = auth.start();
    const deny = (event) => auth.deny(event.detail);
    window.addEventListener("fourth-down:access-denied", deny);
    return () => {
      stop();
      controller.current = null;
      window.removeEventListener("fourth-down:access-denied", deny);
    };
  }, []);

  async function act(action) {
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch (error) { setActionError(error.message); }
    finally { setBusy(false); }
  }
  function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get("email")).trim();
    const password = String(fields.get("password"));
    void act(async () => {
      if (createAccount) {
        await controller.current.signUp(email, password);
        setMessage("Account created. Check your email if confirmation is required. Access requires administrator approval.");
      } else {
        await controller.current.signIn(email, password);
      }
    });
  }
  if (state.status === "approved") {
    return <>
      <div className="auth-account-bar">
        <span>{state.session.user.email}</span>
        <button type="button" disabled={busy} onClick={() => act(() => controller.current.signOut())}>Sign out</button>
        {actionError && <p role="alert">{actionError}</p>}
      </div>
      <Suspense fallback={<p role="status">Loading Fourth Down...</p>}><ApprovedApp /></Suspense>
    </>;
  }
  return <main className="auth-page">
    <section className="card auth-card">
      <h1>Fourth Down</h1>
      {state.status === "loading" && <p role="status">Checking your session and approval...</p>}
      {state.status === "pending" && <>
        <h2>Awaiting Approval</h2>
        <p>Your account is signed in. An administrator must approve access before you can use Fourth Down.</p>
        <button type="button" disabled={busy} onClick={() => act(() => controller.current.retry())}>Check approval</button>
      </>}
      {state.status === "error" && <>
        <p role="alert">{state.error}</p>
        <button type="button" disabled={busy} onClick={() => window.location.reload()}>Retry</button>
      </>}
      {state.status === "signedOut" && <>
        <h2>{createAccount ? "Create Account" : "Sign In"}</h2>
        <form onSubmit={submit}>
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<input name="password" type="password" minLength={6}
            autoComplete={createAccount ? "new-password" : "current-password"} required /></label>
          <button className="primary" type="submit" disabled={busy}>{createAccount ? "Create account" : "Sign in"}</button>
        </form>
        <button type="button" disabled={busy} onClick={() => {
          setCreateAccount(!createAccount); setMessage(null); setActionError(null);
        }}>{createAccount ? "Already have an account? Sign in" : "Create account"}</button>
      </>}
      {state.session && <button type="button" disabled={busy} onClick={() => act(() => controller.current.signOut())}>Sign out</button>}
      {message && <p role="status">{message}</p>}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
  </main>;
}
