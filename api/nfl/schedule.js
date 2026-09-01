const API_URL = "https://api.balldontlie.io/nfl/v1/games";

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

  const season = Number(req.query.season || 2026);
  const week = Number(req.query.week || 1);

  if (!Number.isInteger(season) || season < 2002) {
    return res.status(400).json({
      error: "Invalid season",
    });
  }

  if (!Number.isInteger(week) || week < 1 || week > 22) {
    return res.status(400).json({
      error: "Invalid week",
    });
  }

  try {
    const games = [];
    let cursor = null;

    do {
      const params = new URLSearchParams();

      params.append("seasons[]", String(season));
      params.append("weeks[]", String(week));
      params.set("per_page", "100");

      if (cursor !== null) {
        params.set("cursor", String(cursor));
      }

      const response = await fetch(`${API_URL}?${params.toString()}`, {
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
        },
      });

      const text = await response.text();

      let body;

      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {
          error: text || "BALLDONTLIE returned an invalid response",
        };
      }

      if (!response.ok) {
        return res.status(response.status).json({
          error:
            body.error ||
            `BALLDONTLIE returned HTTP ${response.status}`,
        });
      }

      games.push(...(body.data || []));
      cursor = body.meta?.next_cursor ?? null;
    } while (cursor !== null);

    const regularSeasonGames = games
      .filter((game) => game.postseason !== true)
      .sort((first, second) => {
        return new Date(first.date) - new Date(second.date);
      });

    return res.status(200).json({
      season,
      week,
      count: regularSeasonGames.length,
      games: regularSeasonGames,
    });
  } catch (error) {
    console.error("Schedule endpoint failed", error);

    return res.status(500).json({
      error: "Failed to retrieve the NFL schedule",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}