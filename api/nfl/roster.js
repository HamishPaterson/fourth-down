export default async function handler(req, res) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;

  try {
    const response = await fetch(
      "https://api.balldontlie.io/nfl/v1/teams/30/roster?season=2026",
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
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(500).json({
      error: error.message,
    });
  }
}