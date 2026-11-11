import { createClient } from "@supabase/supabase-js";

let client;
export function getAuthClient() {
  if (client) return client;
  const url = import.meta.env?.VITE_SUPABASE_URL;
  const key = import.meta.env?.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Sign in is unavailable: Supabase browser configuration is missing.");
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function apiFetch(url, options = {}) {
  // Server generation uses its existing trusted in-process input loaders.
  if (typeof window === "undefined") return fetch(url, options);
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/")) {
    throw new Error("Authenticated requests must target the same-origin API");
  }
  const { data, error } = await getAuthClient().auth.getSession();
  if (error) throw error;
  if (!data.session?.access_token) throw new Error("Please sign in to continue.");
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${data.session.access_token}`);
  const response = await fetch(url, { ...options, headers, cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent("fourth-down:access-denied", { detail: response.status }));
  }
  return response;
}
