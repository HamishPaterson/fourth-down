const API_URL = "https://api.balldontlie.io/nfl/v1/stats";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  const gameId = Number(req.query.id);

  if (!apiKey) {
    return res.status(500).json({
      error: "BALLDONTLIE_API_KEY is not configured",
    });
  }

  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({
      error: "A valid game ID is required",
    });
  }

  try {
    const records = [];
    let cursor = null;

    do {
      const params = new URLSearchParams();

      params.append("game_ids[]", String(gameId));
      params.set("per_page", "100");

      if (cursor !== null) {
        params.set("cursor", String(cursor));
      }

      const response = await fetch(
        `${API_URL}?${params.toString()}`,
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
          error:
            text ||
            "BALLDONTLIE returned an invalid response",
        };
      }

      if (!response.ok) {
        return res.status(response.status).json({
          error:
            body.error ||
            `BALLDONTLIE returned HTTP ${response.status}`,
        });
      }

      records.push(...(body.data || []));
      cursor = body.meta?.next_cursor ?? null;
    } while (cursor !== null);

    const teams = aggregateTeamStats(records);

    return res.status(200).json({
      gameId,
      recordCount: records.length,
      teams,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Game statistics endpoint failed", error);

    return res.status(500).json({
      error: "Failed to retrieve game statistics",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

function aggregateTeamStats(records) {
  const teamMap = {};

  for (const record of records) {
    const team = record.team;
    const abbreviation = normalizeTeamCode(
      team?.abbreviation
    );

    if (!abbreviation) {
      continue;
    }

    if (!teamMap[abbreviation]) {
      teamMap[abbreviation] = createTeamStats(
        abbreviation,
        team
      );
    }

    const totals = teamMap[abbreviation];

    totals.passingCompletions += numberValue(
      record.passing_completions
    );

    totals.passingAttempts += numberValue(
      record.passing_attempts
    );

    totals.passingYards += numberValue(
      record.passing_yards
    );

    totals.passingTouchdowns += numberValue(
      record.passing_touchdowns
    );

    totals.interceptionsThrown += numberValue(
      record.passing_interceptions
    );

    totals.rushingAttempts += numberValue(
      record.rushing_attempts
    );

    totals.rushingYards += numberValue(
      record.rushing_yards
    );

    totals.rushingTouchdowns += numberValue(
      record.rushing_touchdowns
    );

    totals.receptions += numberValue(
      record.receptions
    );

    totals.receivingYards += numberValue(
      record.receiving_yards
    );

    totals.receivingTouchdowns += numberValue(
      record.receiving_touchdowns
    );

    totals.sacks += numberValue(record.sacks);

    totals.fumbles += numberValue(record.fumbles);

    totals.fumblesLost += numberValue(
      record.fumbles_lost
    );

    totals.fumblesForced += numberValue(
      record.fumbles_forced
    );

    totals.fumblesRecovered += numberValue(
      record.fumbles_recovered
    );

    totals.totalTackles += numberValue(
      record.total_tackles
    );

    totals.soloTackles += numberValue(
      record.solo_tackles
    );

    totals.fieldGoalsMade += numberValue(
      record.field_goals_made
    );

    totals.fieldGoalsAttempted += numberValue(
      record.field_goals_attempted
    );

    totals.punts += numberValue(record.punts);
    totals.puntingYards += numberValue(
      record.punting_yards
    );

    if (record.player) {
      totals.playerCount += 1;
    }
  }

  for (const totals of Object.values(teamMap)) {
    totals.totalOffense =
      totals.passingYards + totals.rushingYards;

    totals.turnovers =
      totals.interceptionsThrown +
      totals.fumblesLost;

    totals.yardsPerRush =
      totals.rushingAttempts > 0
        ? round(
            totals.rushingYards /
              totals.rushingAttempts
          )
        : null;

    totals.completionPercentage =
      totals.passingAttempts > 0
        ? round(
            (totals.passingCompletions /
              totals.passingAttempts) *
              100
          )
        : null;

    totals.fieldGoalPercentage =
      totals.fieldGoalsAttempted > 0
        ? round(
            (totals.fieldGoalsMade /
              totals.fieldGoalsAttempted) *
              100
          )
        : null;

    totals.puntAverage =
      totals.punts > 0
        ? round(
            totals.puntingYards / totals.punts
          )
        : null;
  }

  return teamMap;
}

function createTeamStats(abbreviation, team) {
  return {
    abbreviation,
    name:
      team?.full_name ||
      team?.name ||
      abbreviation,

    playerCount: 0,

    totalOffense: 0,

    passingCompletions: 0,
    passingAttempts: 0,
    passingYards: 0,
    passingTouchdowns: 0,
    interceptionsThrown: 0,
    completionPercentage: null,

    rushingAttempts: 0,
    rushingYards: 0,
    rushingTouchdowns: 0,
    yardsPerRush: null,

    receptions: 0,
    receivingYards: 0,
    receivingTouchdowns: 0,

    turnovers: 0,
    fumbles: 0,
    fumblesLost: 0,
    fumblesForced: 0,
    fumblesRecovered: 0,

    sacks: 0,
    totalTackles: 0,
    soloTackles: 0,

    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    fieldGoalPercentage: null,

    punts: 0,
    puntingYards: 0,
    puntAverage: null,
  };
}

function numberValue(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").toUpperCase();

  const aliases = {
    WAS: "WSH",
    LA: "LAR",
  };

  return aliases[normalized] || normalized;
}