import { TEAM_NAMES } from "../data.js";

// Authoritative ESPN Week 8 tables supplied by the user, 2026-10-27.
// FPI: team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
const fpiRows = [
  ["SF","6-1-0",5.9,1,"--",5.1,0.6,0.1,27,15,1],
  ["BUF","5-1-0",4.4,2,"--",5.8,-2.0,0.6,9,27,7],
  ["SEA","4-3-0",4.3,3,"UP 3",0.1,3.6,0.6,11,8,12],
  ["KC","5-1-0",4.0,4,"--",2.6,1.6,-0.2,28,11,5],
  ["CIN","4-2-0",4.0,5,"UP 3",4.1,-0.1,-0.1,15,32,6],
  ["JAX","4-2-0",3.9,6,"DOWN 1",2.4,1.3,0.2,12,29,4],
  ["CHI","5-2-0",3.9,7,"UP 5",2.3,1.1,0.5,25,3,2],
  ["LAR","3-4-0",3.5,8,"DOWN 5",2.7,2.1,-1.2,18,1,11],
  ["NE","4-3-0",2.3,9,"DOWN 2",1.4,1.0,-0.1,5,28,9],
  ["BAL","4-3-0",2.2,10,"UP 5",2.9,-0.4,-0.3,32,9,3],
  ["DET","4-2-0",1.8,11,"DOWN 1",3.5,-2.0,0.4,31,21,13],
  ["TB","2-5-0",1.7,12,"UP 16",-0.3,1.3,0.6,16,24,15],
  ["DAL","2-4-0",1.6,13,"DOWN 4",3.3,-2.1,0.4,10,23,27],
  ["DEN","5-2-0",1.5,14,"--",-0.9,2.4,0.1,2,30,16],
  ["HOU","2-5-0",1.5,15,"DOWN 4",0.6,1.0,-0.1,8,31,20],
  ["MIN","6-0-0",1.4,16,"DOWN 3",-3.4,4.1,0.7,24,6,10],
  ["GB","4-3-0",1.2,17,"DOWN 1",1.0,0.2,0.0,13,7,8],
  ["PIT","5-2-0",-0.8,18,"UP 1",-1.5,0.4,0.3,22,16,22],
  ["IND","2-5-0",-1.1,19,"DOWN 2",-1.0,-0.6,0.4,19,26,21],
  ["CAR","3-3-0",-1.8,20,"DOWN 2",-1.1,-0.7,0.0,21,10,14],
  ["LAC","0-6-0",-2.0,21,"DOWN 1",-3.9,1.9,0.0,6,4,30],
  ["ATL","3-4-0",-2.6,22,"UP 1",-2.3,-0.4,0.1,7,18,18],
  ["LV","3-4-0",-2.9,23,"DOWN 1",-1.7,-1.0,-0.2,14,25,23],
  ["NO","2-5-0",-3.2,24,"--",-1.5,-1.7,0.0,20,22,29],
  ["WSH","1-4-1",-3.2,25,"--",-1.0,-2.1,-0.2,4,20,26],
  ["CLE","5-2-0",-4.2,26,"UP 1",-4.2,0.3,-0.3,23,17,25],
  ["NYJ","2-5-0",-4.3,27,"DOWN 1",-3.0,-1.5,0.3,26,19,24],
  ["NYG","4-2-1",-4.4,28,"UP 1",-3.5,-1.0,0.2,30,13,19],
  ["ARI","2-5-0",-5.0,29,"UP 1",-1.7,-2.9,-0.3,1,14,28],
  ["PHI","2-4-0",-5.3,30,"DOWN 9",-6.0,0.6,0.1,17,12,17],
  ["TEN","1-6-0",-6.3,31,"--",-4.3,-1.6,-0.4,29,5,32],
  ["MIA","1-5-0",-7.3,32,"--",-3.3,-3.4,-0.6,3,2,31],
];

// Efficiency: team, record, overall/rank, offense/rank, defense/rank, ST/rank.
const efficiencyRows = [
  ["MIN","6-0-0",68.4,1,30.7,29,83.5,1,77.6,1],
  ["SF","6-1-0",68.0,2,70.2,2,59.8,9,45.0,20],
  ["KC","5-1-0",65.7,3,65.5,4,65.2,4,30.9,29],
  ["CHI","5-2-0",65.4,4,59.1,8,59.7,10,55.6,11],
  ["CIN","4-2-0",64.3,5,63.6,5,60.1,8,43.6,21],
  ["SEA","4-3-0",64.0,6,36.5,27,73.8,2,77.4,2],
  ["JAX","4-2-0",63.8,7,58.5,9,58.8,12,60.0,6],
  ["BUF","5-1-0",60.2,8,79.1,1,30.2,31,75.1,4],
  ["LAR","3-4-0",59.0,9,61.3,6,59.3,11,26.2,31],
  ["NE","4-3-0",57.7,10,50.8,14,57.5,14,59.6,7],
  ["DET","4-2-0",55.3,11,68.5,3,31.5,29,77.2,3],
  ["PIT","5-2-0",55.2,12,40.8,20,63.9,6,58.4,8],
  ["BAL","4-3-0",52.4,13,57.5,11,46.9,21,46.4,19],
  ["GB","4-3-0",51.9,14,45.0,17,56.9,15,53.3,14],
  ["CAR","3-3-0",51.7,15,56.1,12,46.4,23,49.5,16],
  ["DEN","5-2-0",50.2,16,39.8,23,60.8,7,47.6,18],
  ["CLE","5-2-0",49.8,17,39.3,25,64.7,5,37.0,27],
  ["NYG","4-2-1",49.5,18,48.9,15,47.4,18,55.5,12],
  ["HOU","2-5-0",49.4,19,57.7,10,44.5,24,41.0,25],
  ["TB","2-5-0",48.0,20,29.2,30,71.6,3,43.3,23],
  ["ATL","3-4-0",47.6,21,44.5,18,50.3,16,56.0,10],
  ["LV","3-4-0",46.1,22,51.6,13,42.5,26,49.3,17],
  ["IND","2-5-0",43.6,23,40.0,22,47.0,20,57.9,9],
  ["DAL","2-4-0",43.4,24,61.1,7,30.0,32,50.2,15],
  ["NYJ","2-5-0",42.8,25,41.7,19,46.4,22,54.4,13],
  ["NO","2-5-0",40.6,26,45.1,16,43.4,25,42.0,24],
  ["PHI","2-4-0",38.0,27,30.7,28,47.7,17,61.7,5],
  ["WSH","1-4-1",36.8,28,39.7,24,42.5,27,43.5,22],
  ["ARI","2-5-0",31.3,29,38.7,26,41.3,28,23.7,32],
  ["TEN","1-6-0",31.3,30,28.2,31,47.2,19,38.8,26],
  ["MIA","1-5-0",26.7,31,40.0,21,31.5,30,28.6,30],
  ["LAC","0-6-0",25.5,32,15.8,32,58.0,13,31.2,28],
];

export function createEspnSnapshot(fpi = fpiRows, efficiencies = efficiencyRows) {
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
      if (!/^\d+-\d+-\d+$/.test(row[1]) || row.length !== (label === "FPI" ? 11 : 10) ||
          row.some((value, index) => index > 1 && !(label === "FPI" && index === 4) &&
            (typeof value !== "number" || !Number.isFinite(value)))) {
        throw new Error(`${label}: invalid supplied fields for ${row[0]}`);
      }
      if (label === "FPI" && !/^(?:--|(?:UP|DOWN) [1-9]\d*)$/.test(row[4])) {
        throw new Error(`FPI: invalid trend for ${row[0]}`);
      }
    }
  }
  return {
    available: true,
    season: 2026,
    predictionWeek: 8,
    source: "ESPN NFL Football Power Index and Efficiencies",
    generatedAt: "2026-10-27T05:10:11.820Z",
    sourceUpdatedAt: null,
    providedAt: "2026-10-27T05:10:11.820Z",
    provenance: "Authoritative user-supplied ESPN tables; no scraping, interpolation or NFLverse blending",
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
