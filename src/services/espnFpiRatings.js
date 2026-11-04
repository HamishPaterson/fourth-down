import { TEAM_NAMES } from "../data.js";

// Authoritative ESPN Week 9 tables supplied by the user, 2026-11-04.
// FPI: team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
const fpiRows = [
  ["SF","6-1-0",5.9,1,"--",5.2,0.6,0.1,27,18,1],
  ["BUF","6-1-0",5.1,2,"--",5.5,-1.0,0.6,8,27,4],
  ["JAX","5-2-0",5.1,3,"UP 3",2.8,2.1,0.2,15,28,2],
  ["CHI","6-2-0",4.7,4,"UP 3",2.8,1.3,0.5,24,4,3],
  ["LAR","4-4-0",3.8,5,"UP 3",2.6,2.5,-1.3,14,1,10],
  ["CIN","5-2-0",3.8,6,"DOWN 1",4.5,-0.6,-0.1,20,32,9],
  ["KC","5-2-0",3.5,7,"DOWN 3",2.8,0.9,-0.2,25,10,5],
  ["SEA","4-4-0",3.4,8,"DOWN 5",-0.3,3.3,0.5,6,12,15],
  ["NE","5-3-0",2.4,9,"UP 2",1.4,1.0,-0.0,10,17,7],
  ["DEN","6-2-0",2.3,10,"UP 4",0.1,2.1,0.1,1,31,19],
  ["TB","3-5-0",2.3,11,"UP 2",-0.6,2.2,0.6,21,26,12],
  ["DET","5-2-0",2.2,12,"--",3.6,-1.9,0.4,26,21,13],
  ["DAL","3-5-0",1.7,13,"DOWN 4",3.8,-2.7,0.5,22,13,20],
  ["GB","5-3-0",1.6,14,"UP 3",1.2,0.6,-0.2,12,3,6],
  ["HOU","2-5-0",1.5,15,"--",0.6,1.0,-0.1,7,30,18],
  ["MIN","6-1-0",0.3,16,"--",-4.3,4.0,0.6,18,5,11],
  ["PIT","6-2-0",-0.0,17,"UP 1",-1.0,0.7,0.2,32,11,14],
  ["CAR","3-4-0",-2.3,18,"UP 2",-1.7,-0.9,0.3,17,15,17],
  ["LAC","0-7-0",-2.3,19,"UP 2",-4.4,2.0,0.1,3,8,31],
  ["IND","2-6-0",-2.4,20,"DOWN 1",-2.0,-0.9,0.5,9,29,25],
  ["LV","4-4-0",-2.6,21,"UP 2",-0.9,-1.6,-0.0,16,19,23],
  ["WSH","2-4-1",-2.9,22,"UP 3",-0.9,-1.9,-0.1,13,14,26],
  ["NO","2-5-0",-3.2,23,"UP 1",-1.5,-1.7,0.1,19,25,28],
  ["ATL","3-5-0",-3.9,24,"DOWN 2",-3.7,-0.2,0.1,5,23,22],
  ["NYJ","2-6-0",-3.9,25,"UP 3",-2.1,-2.0,0.2,29,7,24],
  ["NYG","4-2-1",-4.2,26,"UP 1",-3.5,-0.9,0.2,30,22,16],
  ["ARI","3-5-0",-5.1,27,"UP 2",-2.1,-2.5,-0.5,2,20,29],
  ["CLE","5-3-0",-5.2,28,"DOWN 2",-4.9,-0.1,-0.2,23,24,27],
  ["BAL","4-4-0",-5.2,29,"DOWN 19",-4.6,-0.3,-0.3,31,16,8],
  ["TEN","1-7-0",-5.9,30,"UP 1",-3.7,-1.8,-0.4,28,6,30],
  ["PHI","2-6-0",-6.3,31,"DOWN 1",-6.1,-0.2,-0.0,11,9,21],
  ["MIA","1-6-0",-7.3,32,"--",-3.3,-3.2,-0.8,4,2,32],
];

// Efficiency: team, record, overall/rank, offense/rank, defense/rank, ST/rank.
const efficiencyRows = [
  ["JAX","5-2-0",71.5,1,62.0,7,67.1,5,60.6,7],
  ["CHI","6-2-0",68.3,2,60.4,9,61.1,7,61.9,5],
  ["SF","6-1-0",68.0,3,70.2,2,59.8,9,45.0,20],
  ["BUF","6-1-0",66.0,4,74.3,1,39.9,28,79.2,1],
  ["CIN","5-2-0",65.6,5,66.2,3,59.0,12,45.2,19],
  ["MIN","6-1-0",63.6,6,30.3,30,79.0,2,73.3,3],
  ["LAR","4-4-0",62.5,7,60.4,8,66.1,6,26.2,31],
  ["KC","5-2-0",62.4,8,65.9,4,59.6,11,32.2,29],
  ["PIT","6-2-0",60.0,9,45.1,18,68.8,3,51.9,15],
  ["NE","5-3-0",59.3,10,52.8,12,57.0,14,61.9,6],
  ["SEA","4-4-0",57.6,11,35.9,24,68.4,4,69.4,4],
  ["DET","5-2-0",57.0,12,65.8,5,36.0,30,75.2,2],
  ["GB","5-3-0",54.2,13,47.2,17,60.5,8,44.3,22],
  ["TB","3-5-0",53.7,14,28.3,31,79.0,1,44.9,21],
  ["DEN","6-2-0",51.1,15,44.7,20,57.3,13,49.4,16],
  ["NYG","4-2-1",49.5,16,48.9,14,47.4,19,55.5,11],
  ["HOU","2-5-0",49.4,17,57.7,10,44.5,21,41.0,25],
  ["CAR","3-4-0",48.4,18,49.3,13,45.2,20,58.9,8],
  ["DAL","3-5-0",48.4,19,63.1,6,33.7,31,55.4,12],
  ["LV","4-4-0",47.9,20,55.7,11,38.8,29,56.2,10],
  ["BAL","4-4-0",45.1,21,48.4,15,48.2,18,39.1,27],
  ["CLE","5-3-0",44.1,22,33.6,26,59.8,10,44.1,23],
  ["WSH","2-4-1",43.0,23,41.3,22,48.8,17,48.5,17],
  ["NYJ","2-6-0",42.5,24,47.5,16,42.7,26,47.0,18],
  ["ATL","3-5-0",42.2,25,33.2,27,53.7,16,54.3,14],
  ["NO","2-5-0",40.6,26,45.1,19,43.4,25,42.0,24],
  ["IND","2-6-0",36.7,27,33.8,25,43.5,22,56.4,9],
  ["ARI","3-5-0",34.6,28,41.7,21,43.4,24,23.9,32],
  ["PHI","2-6-0",33.5,29,31.5,28,42.5,27,54.9,13],
  ["TEN","1-7-0",30.8,30,31.1,29,43.5,23,39.9,26],
  ["MIA","1-6-0",27.3,31,41.0,23,31.7,32,28.0,30],
  ["LAC","0-7-0",24.0,32,13.7,32,56.8,15,37.1,28],
];

// Projections: team, record, projected W-L, playoff %, win division %, make
// division %, make conference %, make Super Bowl %, win Super Bowl %.
const projectionRows = [
  ["SF","6-1-0","13.2-3.8",99.1,93.4,86.5,58.9,38.5,21.8],
  ["BUF","6-1-0","12.8-4.2",99.1,83.5,76.8,46.7,26.6,14.4],
  ["JAX","5-2-0","12.2-4.8",97.8,94.2,70.1,40.5,22.7,12.2],
  ["CIN","5-2-0","12.1-4.8",96.1,70.6,61.0,31.9,15.8,7.4],
  ["DEN","6-2-0","11.7-5.3",93.9,59.1,54.0,24.5,11.3,5.5],
  ["CHI","6-2-0","11.7-5.3",90.4,38.9,62.0,35.8,18.7,9.9],
  ["MIN","6-1-0","11.2-5.8",83.9,30.7,46.6,20.7,8.2,3.3],
  ["KC","5-2-0","11.0-5.9",90.9,39.7,51.4,24.8,11.9,6.0],
  ["DET","5-2-0","10.8-6.2",78.3,24.2,42.6,18.6,7.3,2.9],
  ["PIT","6-2-0","10.7-6.3",80.0,27.0,31.1,10.4,3.3,1.3],
  ["NE","5-3-0","10.2-6.8",80.8,16.5,36.5,15.3,6.4,3.0],
  ["SEA","4-4-0","9.7-7.3",48.0,4.0,25.9,11.6,5.5,2.6],
  ["GB","5-3-0","9.6-7.3",49.1,6.2,24.2,9.8,4.0,1.7],
  ["LAR","4-4-0","9.4-7.6",44.0,2.6,25.6,11.8,5.8,3.0],
  ["TB","3-5-0","8.3-8.6",64.6,63.7,33.6,15.8,6.5,2.9],
  ["HOU","2-5-0","8.3-8.6",25.7,5.5,10.2,3.9,1.4,0.5],
  ["CLE","5-3-0","8.2-8.7",17.3,1.9,3.5,0.5,0.1,0.0],
  ["DAL","3-5-0","8.1-8.9",43.1,41.9,21.0,8.7,3.5,1.2],
  ["NYG","4-2-1","7.8-8.2",47.3,46.0,14.2,3.5,0.8,0.1],
  ["LV","4-4-0","7.5-9.4",9.1,1.2,2.3,0.6,0.2,0.0],
  ["BAL","4-4-0","7.4-9.6",7.2,0.5,2.6,0.9,0.3,0.1],
  ["CAR","3-4-0","7.3-9.7",23.6,22.1,8.5,2.5,0.7,0.2],
  ["ARI","3-5-0","6.4-10.6",1.1,0.0,0.3,0.0,0.0,0.0],
  ["IND","2-6-0","6.3-10.6",1.7,0.3,0.5,0.1,0.0,0.0],
  ["ATL","3-5-0","6.3-10.7",7.9,7.3,2.7,0.6,0.2,0.1],
  ["WSH","2-4-1","6.0-10.0",11.6,11.3,4.0,1.2,0.3,0.0],
  ["NO","2-5-0","5.9-11.0",7.2,7.0,2.2,0.5,0.2,0.0],
  ["NYJ","2-6-0","5.0-12.0",0.3,0.0,0.0,0.0,0.0,0.0],
  ["PHI","2-6-0","4.6-12.4",0.8,0.8,0.1,0.0,0.0,0.0],
  ["LAC","0-7-0","4.2-12.8",0.1,0.0,0.0,0.0,0.0,0.0],
  ["TEN","1-7-0","3.5-13.5",0.0,0.0,0.0,0.0,0.0,0.0],
  ["MIA","1-6-0","3.2-13.8",0.0,0.0,0.0,0.0,0.0,0.0],
];

export function createEspnSnapshot(fpi = fpiRows, efficiencies = efficiencyRows, projections = projectionRows) {
  const expected = Object.keys(TEAM_NAMES).sort();
  for (const [label, rows] of [["FPI", fpi], ["Efficiency", efficiencies], ["Projections", projections]]) {
    if (rows.length !== 32 || JSON.stringify(rows.map((row) => row[0]).sort()) !== JSON.stringify(expected)) {
      throw new Error(`${label}: expected 32 unique canonical teams`);
    }
    const rankColumns = label === "FPI" ? [3] : label === "Efficiency" ? [3, 5, 7, 9] : [];
    for (const column of rankColumns) {
      const ranks = rows.map((row) => row[column]).sort((a, b) => a - b);
      if (ranks.some((rank, index) => rank !== index + 1)) throw new Error(`${label}: invalid ranks in column ${column}`);
    }
    for (const row of rows) {
      const width = label === "FPI" ? 11 : label === "Efficiency" ? 10 : 9;
      if (!/^\d+-\d+-\d+$/.test(row[1]) || row.length !== width ||
          row.some((value, index) => index > 1 && !(label === "FPI" && index === 4) &&
            !(label === "Projections" && index === 2) &&
            (typeof value !== "number" || !Number.isFinite(value)))) {
        throw new Error(`${label}: invalid supplied fields for ${row[0]}`);
      }
      if (label === "FPI" && !/^(?:--|(?:UP|DOWN) [1-9]\d*)$/.test(row[4])) {
        throw new Error(`FPI: invalid trend for ${row[0]}`);
      }
      if (label === "Projections" && !/^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/.test(row[2])) {
        throw new Error(`Projections: invalid projected W-L for ${row[0]}`);
      }
    }
  }
  return {
    available: true,
    season: 2026,
    predictionWeek: 9,
    source: "ESPN NFL Football Power Index, Projections and Efficiencies",
    generatedAt: "2026-11-04T00:43:00.729Z",
    sourceUpdatedAt: null,
    providedAt: "2026-11-04T00:43:00.729Z",
    provenance: "Authoritative user-supplied ESPN tables; no scraping, interpolation or NFLverse blending",
    teams: Object.fromEntries([...fpi].sort(([a], [b]) => a.localeCompare(b)).map((row) => {
      const [code, record, overall, rank, trend, offense, defense, specialTeams,
        strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank] = row;
      const efficiency = efficiencies.find(([team]) => team === code);
      const projection = projections.find(([team]) => team === code);
      if (efficiency[1] !== record) throw new Error(`ESPN W-L-T conflict for ${code}`);
      if (projection[1] !== record) throw new Error(`ESPN W-L-T conflict for ${code}`);
      return [code, {
        name: TEAM_NAMES[code], record, source: "ESPN FPI, Projections and Efficiencies",
        espnFpi: { overall, rank, trend, offense, defense, specialTeams,
          strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank },
        efficiencies: { overall: efficiency[2], overallRank: efficiency[3],
          offense: efficiency[4], offenseRank: efficiency[5], defense: efficiency[6],
          defenseRank: efficiency[7], specialTeams: efficiency[8], specialTeamsRank: efficiency[9] },
        projections: { projectedRecord: projection[2], playoffPercentage: projection[3],
          winDivisionPercentage: projection[4], makeDivisionPercentage: projection[5],
          makeConferencePercentage: projection[6], makeSuperBowlPercentage: projection[7],
          winSuperBowlPercentage: projection[8] },
      }];
    })),
  };
}

const ESPN_FPI_RATINGS = createEspnSnapshot();
export default ESPN_FPI_RATINGS;
