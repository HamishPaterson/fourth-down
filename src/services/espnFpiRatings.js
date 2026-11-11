import { TEAM_NAMES } from "../data.js";

// Authoritative ESPN Week 10 tables supplied by the user, 2026-11-11.
// FPI: team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
const fpiRows = [
  ["SF","7-1-0",6.2,1,"--",5.5,0.8,-0.1,29,14,1],
  ["BUF","7-1-0",5.7,2,"--",5.3,-0.1,0.5,10,27,5],
  ["JAX","6-2-0",5.6,3,"--",2.7,2.5,0.4,17,26,2],
  ["CIN","6-2-0",4.4,4,"UP 2",5.3,-0.8,-0.1,24,31,7],
  ["KC","6-2-0",4.2,5,"UP 2",3.2,1.4,-0.4,31,9,6],
  ["CHI","7-2-0",4.1,6,"DOWN 2",2.1,1.4,0.6,22,7,3],
  ["LAR","5-4-0",3.7,7,"DOWN 2",2.3,2.6,-1.2,19,1,8],
  ["HOU","3-5-0",2.8,8,"UP 7",1.8,1.2,-0.2,8,30,11],
  ["GB","6-3-0",2.7,9,"UP 5",2.2,0.7,-0.2,16,3,4],
  ["MIN","6-2-0",2.6,10,"UP 6",-2.0,4.0,0.7,11,17,14],
  ["TB","3-6-0",2.5,11,"--",-0.8,2.7,0.6,15,29,16],
  ["DEN","7-2-0",2.3,12,"DOWN 2",0.5,1.6,0.1,2,32,17],
  ["DET","6-2-0",2.1,13,"DOWN 1",3.0,-1.3,0.5,32,10,9],
  ["DAL","4-5-0",1.9,14,"DOWN 1",3.8,-2.4,0.5,21,8,19],
  ["NE","5-4-0",1.4,15,"DOWN 6",1.2,0.2,0.0,9,22,13],
  ["SEA","5-4-0",0.6,16,"DOWN 8",-3.1,3.2,0.4,13,4,15],
  ["PIT","6-2-0",-0.1,17,"--",-0.9,0.6,0.2,30,11,12],
  ["CAR","3-5-0",-1.8,18,"--",-0.7,-1.2,0.2,18,19,20],
  ["IND","2-7-0",-2.5,19,"UP 1",-2.2,-0.8,0.5,6,28,23],
  ["WSH","2-5-1",-2.9,20,"UP 2",-0.9,-1.7,-0.2,7,18,22],
  ["NO","3-5-0",-2.9,21,"UP 2",-1.0,-1.9,-0.0,28,13,28],
  ["LAC","0-8-0",-3.1,22,"DOWN 3",-4.6,1.4,0.2,3,15,32],
  ["NYG","5-2-1",-3.5,23,"UP 3",-3.1,-0.7,0.3,27,12,18],
  ["ATL","3-6-0",-4.7,24,"--",-3.5,-0.6,-0.5,4,24,24],
  ["NYJ","2-7-0",-4.9,25,"--",-2.9,-2.4,0.4,23,20,25],
  ["CLE","5-4-0",-5.4,26,"UP 2",-4.9,-0.4,-0.1,25,16,27],
  ["BAL","4-5-0",-5.6,27,"UP 2",-4.9,-0.2,-0.4,20,21,10],
  ["TEN","1-7-0",-6.0,28,"UP 2",-3.7,-1.9,-0.4,26,5,30],
  ["PHI","2-7-0",-6.1,29,"UP 2",-5.9,-0.2,-0.0,14,6,21],
  ["LV","4-5-0",-6.9,30,"DOWN 9",-5.1,-1.9,0.2,12,25,26],
  ["ARI","3-6-0",-8.5,31,"DOWN 4",-5.3,-2.8,-0.4,1,23,29],
  ["MIA","1-7-0",-11.2,32,"--",-7.6,-2.8,-0.8,5,2,31],
];

// Efficiency: team, record, overall/rank, offense/rank, defense/rank, ST/rank.
const efficiencyRows = [
  ["JAX","6-2-0",75.0,1,62.0,7,72.5,3,61.9,6],
  ["SF","7-1-0",71.8,2,71.5,1,64.5,9,41.3,24],
  ["CIN","6-2-0",68.8,3,70.2,2,57.4,11,53.2,12],
  ["BUF","7-1-0",67.8,4,69.6,3,49.8,19,70.4,3],
  ["CHI","7-2-0",67.1,5,55.4,10,66.2,7,61.0,8],
  ["KC","6-2-0",66.8,6,67.2,4,65.2,8,30.8,30],
  ["LAR","5-4-0",62.9,7,57.3,9,67.3,6,32.7,29],
  ["SEA","5-4-0",60.4,8,39.5,22,69.7,4,67.7,4],
  ["PIT","6-2-0",60.0,9,45.1,18,68.8,5,51.9,16],
  ["DET","6-2-0",59.4,10,62.0,6,44.2,24,72.8,2],
  ["GB","6-3-0",58.0,11,51.6,11,62.0,10,43.8,22],
  ["MIN","6-2-0",57.9,12,23.8,31,76.5,2,75.3,1],
  ["HOU","3-5-0",56.1,13,62.0,8,50.3,18,41.5,23],
  ["NE","5-4-0",54.2,14,50.2,13,52.1,15,61.8,7],
  ["TB","3-6-0",52.2,15,25.8,30,79.9,1,45.0,20],
  ["DEN","7-2-0",52.1,16,47.5,15,54.9,13,53.4,11],
  ["NYG","5-2-1",52.0,17,46.0,17,54.0,14,57.0,10],
  ["DAL","4-5-0",49.8,18,63.0,5,37.7,30,46.5,19],
  ["CAR","3-5-0",47.2,19,51.5,12,43.6,25,52.5,13],
  ["CLE","5-4-0",44.3,20,33.4,26,57.4,12,52.2,14],
  ["LV","4-5-0",42.8,21,50.0,14,36.6,31,59.0,9],
  ["NO","3-5-0",42.6,22,46.9,16,46.9,22,35.6,28],
  ["WSH","2-5-1",41.8,23,38.9,23,51.0,16,44.0,21],
  ["BAL","4-5-0",40.3,24,42.1,19,47.4,21,38.2,27],
  ["ATL","3-6-0",38.1,25,35.8,24,47.6,20,46.8,18],
  ["NYJ","2-7-0",38.0,26,41.2,20,40.7,29,50.8,17],
  ["IND","2-7-0",37.1,27,33.0,27,42.6,27,63.0,5],
  ["PHI","2-7-0",33.5,28,28.9,29,46.0,23,52.1,15],
  ["ARI","3-6-0",32.7,29,39.5,21,41.9,28,26.0,32],
  ["TEN","1-7-0",30.8,30,31.1,28,43.5,26,39.9,25],
  ["MIA","1-7-0",27.0,31,34.9,25,36.0,32,30.4,31],
  ["LAC","0-8-0",21.0,32,13.4,32,50.7,17,38.9,26],
];

// Projections: team, record, projected W-L, playoff %, win division %, make
// division %, make conference %, make Super Bowl %, win Super Bowl %.
// STALE: previous Week 9 ESPN snapshot (2026-11-04). ESPN did not supply a
// Week 10 Projections table; records in these rows are the Week 9 records and
// are preserved verbatim as prior evidence, never relabelled as Week 10.
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

// ESPN 2026 Season Leaders Total QBR (All NFL), supplied 2026-11-11 with the
// Week 10 tables. Player-level only: canonicalId is the GSIS identity already
// present in local NFLverse evidence; never resolved or retained by team.
// Columns: canonicalId, name, QBR, PAA, PLAYS, EPA, PASS, RUN, SACK, PEN, RAW.
// Season-leaders table: weekly QBR is not supplied and stays null.
const qbrRows = [
  ["00-0037834","Brock Purdy",81.4,31.8,292,57.2,43.1,13.1,-4.4,1.0,82.4],
  ["00-0036442","Joe Burrow",79.5,33.6,355,66.8,62.3,3.2,-7.0,1.3,79.2],
  ["00-0033077","Dak Prescott",77.0,35.9,403,73.7,62.8,4.6,-5.8,6.3,77.9],
  ["00-0034857","Josh Allen",76.0,25.9,338,56.5,37.7,15.3,-7.2,3.5,74.8],
  ["00-0039851","Drake Maye",74.3,21.9,354,51.7,37.6,11.8,-7.4,2.3,70.6],
  ["00-0039163","C.J. Stroud",73.2,27.7,348,59.8,50.2,7.8,-5.1,1.8,75.5],
  ["00-0039918","Caleb Williams",72.2,14.9,253,38.2,28.7,10.0,-4.3,-0.5,69.7],
  ["00-0036264","Jordan Love",70.2,24.7,396,59.2,55.0,1.5,-5.6,2.7,70.7],
  ["00-0036971","Trevor Lawrence",66.9,14.4,283,38.2,35.9,1.5,-4.6,0.7,67.3],
  ["00-0039150","Bryce Young",64.7,10.4,364,42.1,38.0,3.4,-9.5,0.7,60.0],
  ["00-0039910","Jayden Daniels",62.9,10.6,241,33.3,20.4,13.5,-6.4,-0.6,65.0],
  ["00-0029604","Kirk Cousins",62.8,14.6,366,46.9,44.3,-0.8,-3.5,3.3,63.8],
  ["00-0033873","Patrick Mahomes",60.9,11.2,301,39.6,34.6,5.0,-5.0,0.0,62.9],
  ["00-0040743","Tyler Shough",60.7,10.2,389,46.2,39.4,4.8,-10.4,2.0,59.2],
  ["00-0026498","Matthew Stafford",59.5,14.0,391,50.3,47.5,1.1,-6.3,1.8,62.4],
  ["00-0036389","Jalen Hurts",59.5,4.4,199,23.1,18.5,2.3,-4.6,2.3,57.8],
  ["00-0033106","Jared Goff",58.5,9.8,330,39.9,42.0,-3.5,-8.9,1.4,60.3],
  ["00-0039917","Michael Penix Jr.",55.7,1.7,240,23.6,16.7,4.3,-3.7,2.6,52.5],
  ["00-0030565","Geno Smith",54.8,3.2,344,36.0,32.7,1.1,-14.5,2.2,53.2],
  ["00-0038128","Malik Willis",52.6,1.9,296,29.6,14.3,14.6,-10.8,0.7,52.3],
  ["00-0034869","Sam Darnold",49.0,-1.5,262,23.5,16.4,6.6,-7.9,0.6,48.0],
  ["00-0040676","Cam Ward",49.0,-0.1,314,28.6,21.9,3.5,-4.9,3.2,49.9],
  ["00-0033119","Jacoby Brissett",49.0,-1.6,373,33.3,24.0,4.9,-8.5,4.3,48.5],
  ["00-0039732","Bo Nix",48.9,-2.7,360,31.5,25.3,1.9,-3.9,4.3,47.4],
  ["00-0023459","Aaron Rodgers",47.7,-5.0,335,26.9,21.2,1.8,-11.9,3.9,44.8],
  ["00-0031503","Jameis Winston",45.8,1.2,219,21.9,14.0,6.7,-6.3,1.2,51.9],
  ["00-0035228","Kyler Murray",45.7,-0.1,208,19.9,11.5,8.9,-6.9,0.3,49.8],
  ["00-0033537","Deshaun Watson",40.8,-10.3,360,22.4,19.5,2.7,-11.6,0.3,40.0],
  ["00-0035710","Daniel Jones",36.4,-15.1,369,19.6,17.2,1.2,-9.7,1.2,36.0],
  ["00-0034855","Baker Mayfield",31.7,-16.4,203,3.1,-1.5,3.8,-7.3,0.8,24.2],
  ["00-0036355","Justin Herbert",29.8,-21.6,329,9.9,8.2,0.4,-12.3,1.2,28.3],
];

export function createEspnSnapshot(fpi = fpiRows, efficiencies = efficiencyRows, projections = projectionRows, qbr = qbrRows) {
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
    season: 2026,
    predictionWeek: 10,
    source: "ESPN NFL Football Power Index, Efficiencies and Total QBR",
    generatedAt: "2026-11-10T23:47:00.000Z",
    sourceUpdatedAt: null,
    providedAt: "2026-11-10T23:47:00.000Z",
    provenance: "Authoritative user-supplied ESPN tables; no scraping, interpolation or NFLverse blending",
    // ESPN supplied no Week 10 Projections table; the retained Week 9 rows are
    // explicitly stale evidence and must not gate the current FPI/Efficiency data.
    projectionsStatus: { current: false, stale: true, asOfPredictionWeek: 9, providedAt: "2026-11-04T00:43:00.729Z" },
    quarterbacks: {
      week: 10,
      scope: "ESPN 2026 Season Leaders Total QBR (All NFL)",
      players: Object.fromEntries([...qbr].sort(([a], [b]) => a.localeCompare(b)).map((row) => {
        const [canonicalId, playerName, seasonQbr, pointsAboveAverage, plays,
          expectedPointsAdded, pass, run, sack, penalty, rawQbr] = row;
        return [canonicalId, {
          canonicalId, playerName, seasonQbr, weeklyQbr: null, plays, week: 10,
          evidence: { pointsAboveAverage, expectedPointsAdded, pass, run, sack, penalty, rawQbr },
        }];
      })),
    },
    teams: Object.fromEntries([...fpi].sort(([a], [b]) => a.localeCompare(b)).map((row) => {
      const [code, record, overall, rank, trend, offense, defense, specialTeams,
        strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank] = row;
      const efficiency = efficiencies.find(([team]) => team === code);
      const projection = projections.find(([team]) => team === code);
      if (efficiency[1] !== record) throw new Error(`ESPN W-L-T conflict for ${code}`);
      return [code, {
        name: TEAM_NAMES[code], record, source: "ESPN FPI, Efficiencies and stale Week 9 Projections",
        espnFpi: { overall, rank, trend, offense, defense, specialTeams,
          strengthOfScheduleRank, remainingStrengthOfScheduleRank, averageWinProbabilityRank },
        efficiencies: { overall: efficiency[2], overallRank: efficiency[3],
          offense: efficiency[4], offenseRank: efficiency[5], defense: efficiency[6],
          defenseRank: efficiency[7], specialTeams: efficiency[8], specialTeamsRank: efficiency[9] },
        projections: { stale: true, asOfPredictionWeek: 9, recordAtProjection: projection[1],
          projectedRecord: projection[2], playoffPercentage: projection[3],
          winDivisionPercentage: projection[4], makeDivisionPercentage: projection[5],
          makeConferencePercentage: projection[6], makeSuperBowlPercentage: projection[7],
          winSuperBowlPercentage: projection[8] },
      }];
    })),
  };
}

const ESPN_FPI_RATINGS = createEspnSnapshot();
export default ESPN_FPI_RATINGS;
