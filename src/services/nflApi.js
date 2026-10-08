export async function getTeams(signal) {
  const response = await fetch(
    "/api/nfl/teams",
    {
      signal,
    }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        `Teams request failed (${response.status})`
    );
  }

  return Array.isArray(body.data)
    ? body.data
    : [];
}

export async function getStandings(
  signal,
  season
) {
  const query = season
    ? `?season=${encodeURIComponent(
        season
      )}`
    : "";

  const response = await fetch(
    `/api/nfl/standings${query}`,
    {
      signal,
    }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        `Standings request failed (${response.status})`
    );
  }

  return Array.isArray(body.data)
    ? body.data
    : [];
}

export async function getQbRosterHealth(
  away,
  home,
  season,
  signal
) {
  const params = new URLSearchParams({
    away,
    home,
  });

  if (season) {
    params.set(
      "season",
      String(season)
    );
  }

  const response = await fetch(
    `/api/nfl/qb-roster-health?${params.toString()}`,
    {
      signal,
    }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        `QB/roster request failed (${response.status})`
    );
  }

  return body;
}

export async function getKickerStats(
  away,
  home,
  season,
  signal
) {
  const params = new URLSearchParams({
    away,
    home,
    season: String(season),
  });

  const response = await fetch(
    `/api/nfl/kicker-stats?${params.toString()}`,
    {
      signal,
    }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        `Kicker request failed (${response.status})`
    );
  }

  return body;
}
export async function getTeamForm(away, home, season, week, signal) {
  const params = new URLSearchParams({
    away,
    home,
    season: String(season),
    week: String(week),
  });

  const response = await fetch(
    `/api/nfl/game-stats?${params.toString()}`,
    { signal }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      body.error ||
        `Team form request failed (${response.status})`
    );
  }

  return body;
}

export async function getOpponentNetwork(away, home, season, week, signal) {
  const params = new URLSearchParams({
    away,
    home,
    season: String(season),
    week: String(week),
  });

  const response = await fetch(
    `/api/nfl/opponent-network?${params.toString()}`,
    { signal }
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Opponent network request failed (${response.status})`);
  }
  return body;
}


export async function getPlayByPlayMetrics(away, home, season, week, signal) {
  const params = new URLSearchParams({ away, home, season: String(season), week: String(week) });
  const response = await fetch(`/api/nfl/play-by-play?${params.toString()}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Play-by-play request failed (${response.status})`);
  return body;
}
