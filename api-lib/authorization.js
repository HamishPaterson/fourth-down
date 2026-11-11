import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function isTrustedJob(authorization) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof authorization !== "string") return false;
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function userClient(token) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase authorization configuration missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export function withApprovedUser(handler, { createUserClient = userClient } = {}) {
  return async (req, res, ...args) => {
    // Shared CDN responses must never bypass the per-request approval check.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (/^(cache-control|cdn-cache-control|vercel-cdn-cache-control)$/i.test(name)) {
        return setHeader(name, "private, no-store");
      }
      if (name.toLowerCase() === "vary") {
        return setHeader(name, [...new Set(`${value}, Authorization`.split(",").map((v) => v.trim()))].join(", "));
      }
      return setHeader(name, value);
    };
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("CDN-Cache-Control", "private, no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    const authorization = req.headers?.authorization;
    if (isTrustedJob(authorization)) return handler(req, res, ...args);
    const token = typeof authorization === "string" && /^Bearer \S+$/i.test(authorization)
      ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Authentication required" });
    let client;
    try {
      client = createUserClient(token);
      const { data, error } = await client.auth.getUser(token);
      if (error || !data?.user?.id) return res.status(401).json({ error: "Invalid or expired session" });
      const { data: profile, error: profileError } = await client.from("app_users")
        .select("user_id, approved").eq("user_id", data.user.id).maybeSingle();
      if (profileError) {
        console.error("Approval lookup failed");
        return res.status(503).json({ error: "Approval verification unavailable" });
      }
      if (profile?.user_id !== data.user.id || profile.approved !== true) {
        return res.status(403).json({ error: "Account awaiting approval" });
      }
    } catch {
      console.error("Authentication verification failed");
      return res.status(503).json({ error: "Authentication verification unavailable" });
    }
    return handler(req, res, ...args);
  };
}
