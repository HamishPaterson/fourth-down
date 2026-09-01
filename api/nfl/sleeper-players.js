export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://api.sleeper.app/v1/players/nfl"
    );

    const players = await response.json();

    return res.status(200).json(players);
  } catch (error) {
    return res.status(500).json({
      error: "Unable to load Sleeper players",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}