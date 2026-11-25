import { TEAM_NAMES } from "../data.js";
import DATA from "./espnSnapshotData.js";

// Data columns are documented in espnSnapshotData.js.
export function createEspnSnapshot(fpi = DATA.fpiRows, efficiencies = DATA.efficiencyRows, qbr = DATA.qbrRows, data = DATA) {
  const { weeklyQbrRows } = data;
  const expected = Object.keys(TEAM_NAMES).sort();
  for (const [label, rows] of [["FPI", fpi], ["Efficiency", efficiencies]]) {
    if (rows.length !== 32 || JSON.stringify(rows.map((row) => row[0]).sort()) !== JSON.stringify(expected)) {
      throw new Error(`${label}: expected 32 unique canonical teams`);
    }
    const rankColumns = label === "FPI" ? [3] : [3, 5, 7, 9];
    for (const column of rankColumns) {
      const ranks = rows.map((row) => row[column]).sort((a, b) => a - b);
      if (ranks.some((rank, index) => rank !== index + 1)) throw new Error(`${label}: invalid ranks in column ${column}`);
    }
    for (const row of rows) {
      const width = label === "FPI" ? 11 : 10;
      if (!/^\d+-\d+-\d+$/.test(row[1]) || row.length !== width ||
          row.some((value, index) => index > 1 && !(label === "FPI" && index === 4) &&
            (typeof value !== "number" || !Number.isFinite(value)))) {
        throw new Error(`${label}: invalid supplied fields for ${row[0]}`);
      }
      if (label === "FPI" && !/^(?:--|(?:UP|DOWN) [1-9]\d*)$/.test(row[4])) {
        throw new Error(`FPI: invalid trend for ${row[0]}`);
      }
    }
  }
  const qbrIds = new Set();
  for (const row of qbr) {
    const [canonicalId, playerName, ...values] = row;
    if (row.length !== 11 || !/^00-\d{7}$/.test(canonicalId) || qbrIds.has(canonicalId) ||
        typeof playerName !== "string" || !playerName.trim() ||
        values.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        !Number.isInteger(row[4]) || row[4] <= 0) {
      throw new Error(`QBR: invalid supplied fields for ${playerName || canonicalId}`);
    }
    qbrIds.add(canonicalId);
  }
  return {
    available: true,
    season: data.season,
    predictionWeek: data.predictionWeek,
    source: "ESPN NFL Football Power Index, Efficiencies and Total QBR",
    generatedAt: data.generatedAt,
    sourceUpdatedAt: data.sourceUpdatedAt,
    providedAt: data.generatedAt,
    provenance: "ESPN published tables; no interpolation or NFLverse blending",
    quarterbacks: {
      week: data.predictionWeek,
      scope: `ESPN ${data.season} Season Leaders Total QBR (All NFL)`,
      players: Object.fromEntries([
        ...qbr.map((row) => {
          const [canonicalId, playerName, seasonQbr, pointsAboveAverage, plays,
            expectedPointsAdded, pass, run, sack, penalty, rawQbr] = row;

          return [canonicalId, {
            canonicalId,
            playerName,
            seasonQbr,
            weeklyQbr: null,
            plays,
            week: data.predictionWeek,
            evidence: {
              pointsAboveAverage,
              expectedPointsAdded,
              pass,
              run,
              sack,
              penalty,
              rawQbr,
            },
          }];
        }),
        ...weeklyQbrRows.map((row) => {
          const [canonicalId, playerName, seasonQbr, pointsAboveAverage, plays,
            expectedPointsAdded, pass, run, sack, penalty, rawQbr,
            weeklyQbr, week] = row;

          return [canonicalId, {
            canonicalId,
            playerName,
            seasonQbr,
            weeklyQbr,
            plays,
            week,
            evidence: {
              pointsAboveAverage,
              expectedPointsAdded,
              pass,
              run,
              sack,
              penalty,
              rawQbr,
            },
          }];
        }),
      ].sort(([a], [b]) => a.localeCompare(b))),
    },
    teams: Object.fromEntries([...fpi].sort(([a], [b]) => a.localeCompare(b)).map((row) => {
      const [code, record, overall, rank, trend, offense, defense, specialTeams,
        strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank] = row;
      const efficiency = efficiencies.find(([team]) => team === code);
      if (efficiency[1] !== record) throw new Error(`ESPN W-L-T conflict for ${code}`);
      return [code, {
        name: TEAM_NAMES[code], record, source: "ESPN FPI and Efficiencies",
        espnFpi: { overall, rank, trend, offense, defense, specialTeams,
          strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank },
        efficiencies: { overall: efficiency[2], overallRank: efficiency[3],
          offense: efficiency[4], offenseRank: efficiency[5], defense: efficiency[6],
          defenseRank: efficiency[7], specialTeams: efficiency[8], specialTeamsRank: efficiency[9] },
      }];
    })),
  };
}

const ESPN_FPI_RATINGS = createEspnSnapshot();
export default ESPN_FPI_RATINGS;
