const API_URL = "https://api.balldontlie.io/nfl/v1/teams";

import { withApprovedUser } from "../../api-lib/authorization.js";
import { DAY, providerCache } from "../../api-lib/serverCache.js";

export default withApprovedUser(handler);
export async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "BALLDONTLIE_API_KEY is not configured" });
  }

  try {
    // The 32 teams barely change: one provider call a day per server, shared by every user.
    const body = await providerCache("teams", DAY, async () => {
      const response = await fetch(API_URL, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      const result = await readJsonResponse(response);
      if (!response.ok) throw Object.assign(new Error(result.error || `Teams request failed (${response.status})`), { status: response.status, body: result });
      return result;
    });
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(body);
  } catch (error) {
    if (error?.body) return res.status(error.status).json(error.body);
    return res.status(500).json({
      error: "Failed to load teams",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || "Invalid upstream response" };
  }
}
