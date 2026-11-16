export function createAuthSession(client, onChange) {
  let version = 0, stopped = false, session = null;
  let approvedUserId = null;
  const emit = (state) => { if (!stopped) onChange(state); };
  async function resolve(nextSession) {
    const request = ++version;
    const alreadyApproved = Boolean(nextSession && approvedUserId === nextSession.user.id);
    session = nextSession;
    if (!alreadyApproved) approvedUserId = null;
    emit({ status: alreadyApproved ? "approved" : nextSession ? "loading" : "signedOut", session: nextSession });
    if (!nextSession) return;
    try {
      const { data, error } = await client.from("app_users")
        .select("user_id, approved").eq("user_id", nextSession.user.id).maybeSingle();
      if (error) throw new Error("Unable to verify account approval. Please retry.");
      if (stopped || request !== version) return;
      if (!data || data.user_id !== nextSession.user.id) {
        throw new Error("Your account approval record is not available yet. Please retry.");
      }
      approvedUserId = data.approved === true ? nextSession.user.id : null;
      emit({ status: data.approved === true ? "approved" : "pending", session: nextSession });
    } catch (error) {
      if (!stopped && request === version) {
        emit({ status: alreadyApproved ? "approved" : "error", session: nextSession, error: error.message });
      }
    }
  }
  return {
    start() {
      emit({ status: "loading", session: null });
      const { data: { subscription } } = client.auth.onAuthStateChange((event, next) => {
        // Do not await Supabase calls inside its auth callback.
        void resolve(event === "SIGNED_OUT" ? null : next);
      });
      const initialVersion = version;
      void client.auth.getSession().then(({ data, error }) => {
        if (stopped || version !== initialVersion) return;
        if (error) emit({ status: "error", session: null, error: "Unable to restore your session. Please retry." });
        else void resolve(data.session);
      }).catch(() => {
        if (!stopped && version === initialVersion) {
          emit({ status: "error", session: null, error: "Unable to restore your session. Please retry." });
        }
      });
      return () => { stopped = true; version++; subscription.unsubscribe(); };
    },
    retry() { return resolve(session); },
    deny(status) {
      version++;
      approvedUserId = null;
      if (status === 401) session = null;
      emit({ status: status === 401 ? "signedOut" : "pending", session });
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUp(email, password) {
      const { error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      // Approval is exclusively the server-managed app_users value.
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      await resolve(null);
    },
  };
}
