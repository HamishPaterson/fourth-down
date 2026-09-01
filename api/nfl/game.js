const API_BASE = "https://api.balldontlie.io/nfl/v1";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey = process.env.BALLDONTLIE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "BALLDONTLIE_API_KEY is not configured in Vercel",
    });
  }

  const gameId = Number(req.query.id);

  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({
      error: "A valid game ID is required",
    });
  }

  try {
    const response = await fetch(
      `${API_BASE}/games/${gameId}`,
      {
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
        },
      }
    );

    const text = await response.text();

    let body;

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {
        error: text || "BALLDONTLIE returned invalid JSON",
      };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          body.error ||
          `BALLDONTLIE returned HTTP ${response.status}`,
      });
    }

    const game = body.data;

    if (!game) {
      return res.status(404).json({
        error: "Game data was not returned",
      });
    }

    return res.status(200).json({
      game,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Game endpoint failed", error);

    return res.status(500).json({
      error: "Failed to retrieve live game information",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}