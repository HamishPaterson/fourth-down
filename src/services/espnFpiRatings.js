import { TEAM_NAMES } from "../data.js";

// Authoritative ESPN Week 11 tables supplied by the user, 2026-11-18.
// FPI: team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
const fpiRows = [
  ["SF","8-1-0",6.6,1,"--",6.3,0.5,-0.2,28,9,1],
  ["JAX","7-2-0",6.1,2,"UP 1",3.3,2.4,0.4,25,24,2],
  ["BUF","8-1-0",6.1,3,"DOWN 1",5.6,0.0,0.5,12,23,5],
  ["CIN","7-2-0",5.3,4,"--",6.2,-0.8,-0.1,26,31,6],
  ["KC","7-2-0",5.0,5,"--",3.7,2.0,-0.7,32,5,4],
  ["LAR","6-4-0",4.7,6,"UP 1",2.6,3.4,-1.3,24,1,9],
  ["CHI","7-2-0",3.9,7,"DOWN 1",2.1,1.3,0.6,23,6,3],
  ["SEA","6-4-0",3.8,8,"UP 7",0.2,3.2,0.3,18,2,12],
  ["MIN","7-2-0",3.5,9,"UP 8",-1.6,4.3,0.9,9,22,10],
  ["DET","7-2-0",3.2,10,"UP 2",3.4,-0.8,0.5,30,15,8],
  ["DEN","7-2-0",2.5,11,"--",0.6,1.7,0.1,2,32,14],
  ["HOU","3-6-0",2.1,12,"DOWN 4",1.3,0.9,-0.2,11,29,11],
  ["GB","6-4-0",1.9,13,"DOWN 4",1.7,0.6,-0.3,16,4,7],
  ["DAL","4-6-0",1.7,14,"DOWN 1",4.1,-3.0,0.6,17,11,20],
  ["TB","3-6-0",0.8,15,"DOWN 5",-2.6,2.8,0.6,15,27,13],
  ["PIT","6-3-0",-0.9,16,"--",-1.1,-0.1,0.3,27,17,18],
  ["CAR","4-5-0",-1.7,17,"UP 1",-0.9,-1.0,0.1,20,12,19],
  ["LAC","1-8-0",-2.7,18,"UP 5",-4.2,1.3,0.2,4,13,29],
  ["WSH","3-5-1",-2.9,19,"UP 1",-0.9,-1.9,-0.1,8,20,23],
  ["NO","3-6-0",-3.1,20,"UP 1",-1.5,-1.7,0.0,29,10,28],
  ["IND","3-7-0",-3.3,21,"DOWN 2",-2.9,-0.9,0.6,13,19,22],
  ["NYG","5-3-1",-3.8,22,"UP 2",-3.1,-0.8,0.1,31,7,16],
  ["CLE","6-4-0",-4.9,23,"UP 4",-4.6,-0.2,-0.1,22,21,27],
  ["PHI","2-7-0",-5.7,24,"UP 6",-5.5,-0.1,-0.0,10,8,21],
  ["ATL","3-7-0",-5.7,25,"--",-4.5,-0.9,-0.3,3,28,26],
  ["NE","5-5-0",-5.7,26,"DOWN 12",-5.7,-0.0,0.0,7,18,17],
  ["BAL","4-6-0",-5.9,27,"UP 1",-5.1,-0.5,-0.4,21,16,15],
  ["ARI","3-7-0",-5.9,28,"UP 4",-2.8,-2.9,-0.2,1,26,30],
  ["TEN","1-8-0",-6.3,29,"--",-3.6,-2.3,-0.4,19,14,32],
  ["NYJ","2-8-0",-7.1,30,"DOWN 4",-5.1,-2.5,0.4,14,25,25],
  ["LV","4-6-0",-7.2,31,"DOWN 9",-5.5,-1.9,0.2,6,30,24],
  ["MIA","1-8-0",-10.2,32,"DOWN 1",-6.9,-2.3,-0.9,5,3,31],
];

// Efficiency: team, record, overall/rank, offense/rank, defense/rank, ST/rank.
const efficiencyRows = [
  ["JAX","7-2-0",75.0,1,64.7,7,71.1,3,57.9,9],
  ["CIN","7-2-0",72.3,2,74.3,2,59.9,10,47.5,20],
  ["SF","8-1-0",70.6,3,77.6,1,57.4,12,37.1,28],
  ["KC","7-2-0",70.5,4,69.3,4,69.9,6,28.5,31],
  ["BUF","8-1-0",69.5,5,71.2,3,52.1,15,68.1,3],
  ["LAR","6-4-0",67.2,6,61.0,8,70.5,5,30.6,29],
  ["CHI","7-2-0",67.1,7,55.4,10,66.2,7,61.0,7],
  ["DET","7-2-0",64.0,8,65.6,6,47.5,22,72.3,2],
  ["MIN","7-2-0",61.3,9,26.0,30,77.8,2,78.3,1],
  ["SEA","6-4-0",61.3,10,41.3,20,70.8,4,62.3,6],
  ["HOU","3-6-0",54.4,11,58.7,9,50.3,17,43.5,22],
  ["PIT","6-3-0",53.9,12,42.4,18,60.9,9,56.7,10],
  ["GB","6-4-0",53.3,13,47.5,12,61.1,8,37.8,27],
  ["TB","3-6-0",52.2,14,25.8,31,79.9,1,45.0,21],
  ["DEN","7-2-0",52.1,15,47.5,13,54.9,13,53.4,11],
  ["NYG","5-3-1",50.7,16,47.4,14,53.0,14,50.4,18],
  ["CAR","4-5-0",48.5,17,49.7,11,48.2,20,49.2,19],
  ["DAL","4-6-0",48.4,18,65.7,5,31.5,32,51.3,14],
  ["NE","5-5-0",48.3,19,47.2,15,47.1,23,59.8,8],
  ["CLE","6-4-0",45.9,20,35.0,24,58.6,11,51.1,15],
  ["WSH","3-5-1",43.8,21,40.6,21,50.0,18,50.5,17],
  ["NO","3-6-0",42.6,22,43.6,17,48.9,19,39.7,25],
  ["LV","4-6-0",41.6,23,46.8,16,36.7,31,62.4,5],
  ["BAL","4-6-0",40.8,24,41.8,19,47.7,21,40.5,24],
  ["IND","3-7-0",38.7,25,31.3,27,45.9,25,66.5,4],
  ["NYJ","2-8-0",35.7,26,40.0,22,38.2,29,50.7,16],
  ["ATL","3-7-0",33.7,27,30.7,28,44.1,26,52.2,12],
  ["PHI","2-7-0",33.5,28,28.9,29,46.0,24,52.1,13],
  ["TEN","1-8-0",30.1,29,32.1,26,40.6,28,43.1,23],
  ["MIA","1-8-0",29.2,30,34.3,25,41.6,27,27.1,32],
  ["ARI","3-7-0",28.9,31,36.1,23,37.8,30,30.0,30],
  ["LAC","1-8-0",24.1,32,15.9,32,51.9,16,39.2,26],
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

// ESPN 2026 Season Leaders Total QBR (All NFL), supplied 2026-11-18 with the
// Week 11 tables. Player-level only: canonicalId is the GSIS identity already
// present in local NFLverse evidence; never resolved or retained by team.
// Columns: canonicalId, name, QBR, PAA, PLAYS, EPA, PASS, RUN, SACK, PEN, RAW.
// Season-leaders table: weekly QBR is not supplied and stays null.
const qbrRows = [
  ["00-0036442","Joe Burrow",82.0,42.9,400,78.9,73.3,3.6,-7.3,2.0,82.0],
  ["00-0037834","Brock Purdy",81.3,37.0,332,66.1,51.0,14.0,-5.9,1.1,82.9],
  ["00-0033077","Dak Prescott",78.3,44.6,465,88.1,75.3,5.9,-5.9,6.8,79.5],
  ["00-0034857","Josh Allen",75.1,26.9,368,60.4,39.3,16.8,-7.7,4.3,73.8],
  ["00-0039851","Drake Maye",73.3,21.3,362,52.0,37.9,12.1,-7.8,1.9,69.7],
  ["00-0036264","Jordan Love",72.8,29.0,427,65.9,60.4,2.6,-7.6,2.9,72.3],
  ["00-0039918","Caleb Williams",72.7,14.8,253,38.2,28.6,10.0,-4.3,-0.5,69.6],
  ["00-0039163","C.J. Stroud",72.5,28.2,394,64.5,53.5,8.3,-5.6,2.7,73.3],
  ["00-0036971","Trevor Lawrence",71.6,22.4,323,49.5,44.0,4.6,-5.3,0.9,72.7],
  ["00-0029604","Kirk Cousins",65.0,15.7,404,51.2,48.1,-0.3,-5.2,3.4,63.4],
  ["00-0033873","Patrick Mahomes",63.9,14.7,339,46.2,39.4,6.8,-5.5,0.0,64.8],
  ["00-0026498","Matthew Stafford",61.1,18.4,422,57.5,54.4,1.1,-7.3,2.1,64.9],
  ["00-0039150","Bryce Young",60.9,7.2,402,42.9,38.0,3.1,-11.6,1.7,56.3],
  ["00-0039910","Jayden Daniels",60.5,11.5,287,38.7,24.4,14.6,-7.0,-0.4,63.8],
  ["00-0033106","Jared Goff",58.2,9.4,365,42.3,44.4,-3.4,-9.7,1.3,59.0],
  ["00-0036389","Jalen Hurts",58.2,4.4,199,23.1,18.5,2.3,-4.6,2.3,57.8],
  ["00-0040743","Tyler Shough",56.9,8.7,438,49.4,43.3,2.5,-10.9,3.5,56.9],
  ["00-0040676","Cam Ward",53.3,3.3,359,36.2,25.4,7.7,-5.7,3.1,53.3],
  ["00-0030565","Geno Smith",53.2,1.4,369,36.6,33.3,1.1,-15.0,2.2,51.3],
  ["00-0038128","Malik Willis",53.0,1.9,296,29.6,14.3,14.6,-10.8,0.7,52.3],
  ["00-0039917","Michael Penix Jr.",51.4,-1.1,298,26.0,17.5,5.9,-5.2,2.7,48.7],
  ["00-0035228","Kyler Murray",49.1,0.3,206,20.0,11.5,8.8,-6.9,-0.3,50.5],
  ["00-0039732","Bo Nix",49.0,-2.7,360,31.5,25.3,1.9,-3.9,4.3,47.4],
  ["00-0034869","Sam Darnold",48.6,-1.5,262,23.5,16.4,6.6,-7.9,0.6,48.0],
  ["00-0033119","Jacoby Brissett",48.6,-0.9,428,39.1,30.3,4.5,-9.4,4.2,49.2],
  ["00-0023459","Aaron Rodgers",46.7,-7.4,370,26.8,21.2,1.8,-12.9,3.8,43.0],
  ["00-0031503","Jameis Winston",45.1,1.0,221,21.9,14.0,6.7,-6.3,1.2,51.5],
  ["00-0033537","Deshaun Watson",40.1,-11.0,412,26.5,22.0,4.0,-13.7,0.5,40.6],
  ["00-0034855","Baker Mayfield",32.0,-16.4,203,3.1,-1.5,3.8,-7.3,0.8,24.2],
  ["00-0035710","Daniel Jones",30.3,-21.8,396,15.7,15.8,-1.1,-10.0,1.0,31.4],
  ["00-0036355","Justin Herbert",30.1,-20.7,357,13.3,9.3,2.5,-12.9,1.4,30.5],
];

// ESPN Week 10 weekly QBR evidence for players not yet qualifying
// for ESPN's season-leaders table.
const weeklyQbrRows = [
  ["00-0041562","Fernando Mendoza",null,-1.0,41,3.0,0.9,2.1,-2.4,0.0,41.5,49.5,10],
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
    predictionWeek: 11,
    source: "ESPN NFL Football Power Index, Efficiencies and Total QBR",
    generatedAt: "2026-11-18T00:16:20.223Z",
    sourceUpdatedAt: null,
    providedAt: "2026-11-18T00:16:20.223Z",
    provenance: "Authoritative user-supplied ESPN tables; no scraping, interpolation or NFLverse blending",
    // ESPN supplied no Week 11 Projections table; the retained Week 9 rows are
    // explicitly stale evidence and must not gate the current FPI/Efficiency data.
    projectionsStatus: { current: false, stale: true, asOfPredictionWeek: 9, providedAt: "2026-11-04T00:43:00.729Z" },
    quarterbacks: {
      week: 11,
      scope: "ESPN 2026 Season Leaders Total QBR (All NFL)",
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
            week: 11,
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










