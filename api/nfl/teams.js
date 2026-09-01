export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://api.balldontlie.io/nfl/v1/teams",
      {
        headers: {
          Authorization: process.env.BALLDONTLIE_API_KEY,
        },
      }
    );

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load teams",
      details: error.message,
    });
  }
}