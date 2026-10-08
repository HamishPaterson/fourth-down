const API_URL = "https://api.balldontlie.io/nfl/v1/teams";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "BALLDONTLIE_API_KEY is not configured" });
  }

  try {
    const response = await fetch(API_URL, {
      headers: { Authorization: apiKey, Accept: "application/json" },
    });
    const body = await readJsonResponse(response);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(response.status).json(body);
  } catch (error) {
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
