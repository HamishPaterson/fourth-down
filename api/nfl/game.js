const API_BASE = "https://api.balldontlie.io/nfl/v1";

import { withApprovedUser } from "../../api-lib/authorization.js";
import { DAY, MINUTE, providerCache } from "../../api-lib/serverCache.js";

export default withApprovedUser(handler);
export async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  const gameId = Number(req.query.id);

  if (!apiKey) {
    return res.status(500).json({ error: "BALLDONTLIE_API_KEY is not configured" });
  }
  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: "A valid game ID is required" });
  }

  try {
    // Live scores need to stay fresh, so a game is shared for a minute; a finished one for a day.
    const result = await providerCache(`game:${gameId}`,
      (answer) => (/final/i.test(String(answer.body?.data?.status || "")) ? DAY : MINUTE),
      async () => {
        const response = await fetch(`${API_BASE}/games/${gameId}`, {
          headers: { Authorization: apiKey, Accept: "application/json" },
        });
        const answer = { status: response.status, body: await readJsonResponse(response) };
        if (!response.ok) throw Object.assign(new Error("upstream"), { upstream: answer });
        return answer;
      });
    const body = result.body;
    if (!body.data) {
      return res.status(404).json({ error: "Game data was not returned" });
    }

    return res.status(200).json({
      game: body.data,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.upstream) {
      return res.status(error.upstream.status).json({
        error: error.upstream.body?.error || `BALLDONTLIE returned HTTP ${error.upstream.status}`,
      });
    }
    return res.status(500).json({
      error: "Failed to retrieve live game information",
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
