import { TEAM_NAMES } from "../data.js";

// Authoritative ESPN Week 12 tables supplied by the user, 2026-11-25.
// FPI: team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
const fpiRows = [
  ["SF","9-1-0",7.5,1,"--",7.1,0.7,-0.3,25,10,1],
  ["BUF","9-1-0",6.0,2,"UP 1",4.9,0.3,0.8,18,13,4],
  ["KC","8-2-0",5.7,3,"UP 2",4.1,2.4,-0.7,32,2,3],
  ["JAX","7-3-0",5.1,4,"DOWN 2",2.4,2.4,0.4,23,24,5],
  ["LAR","6-4-0",4.8,5,"UP 1",2.6,3.5,-1.3,20,1,9],
  ["CIN","7-3-0",4.4,6,"DOWN 2",5.5,-1.0,-0.1,30,31,6],
  ["SEA","6-4-0",3.8,7,"UP 1",0.2,3.3,0.3,13,3,13],
  ["DET","8-2-0",3.8,8,"UP 2",4.2,-0.8,0.4,29,18,7],
  ["CHI","8-2-0",3.7,9,"DOWN 2",1.4,1.5,0.8,28,4,2],
  ["HOU","4-6-0",2.6,10,"UP 2",1.2,1.5,-0.1,19,23,10],
  ["MIN","7-3-0",2.4,11,"DOWN 2",-2.1,3.7,0.9,8,25,14],
  ["DAL","5-6-0",2.4,12,"UP 2",5.1,-3.2,0.5,21,5,15],
  ["DEN","8-2-0",2.4,13,"DOWN 2",0.6,1.6,0.2,2,30,11],
  ["GB","6-4-0",1.9,14,"DOWN 1",1.5,0.7,-0.3,15,6,8],
  ["TB","3-7-0",1.7,15,"--",-1.0,2.1,0.7,12,29,18],
  ["PIT","6-4-0",-1.7,16,"--",-1.7,-0.3,0.3,31,12,21],
  ["CAR","5-5-0",-1.8,17,"--",-0.7,-1.3,0.3,17,17,20],
  ["WSH","4-5-1",-2.1,18,"UP 1",-0.5,-1.4,-0.1,5,27,22],
  ["NYG","6-3-1",-2.6,19,"UP 3",-2.6,-0.1,0.1,22,11,12],
  ["IND","3-8-0",-3.1,20,"UP 1",-2.6,-0.8,0.4,11,21,24],
  ["NO","3-7-0",-3.3,21,"DOWN 1",-1.8,-1.3,-0.1,24,20,28],
  ["LAC","1-9-0",-4.1,22,"DOWN 4",-4.9,0.6,0.2,6,7,29],
  ["NYJ","3-8-0",-4.5,23,"UP 7",-2.1,-2.8,0.4,16,22,23],
  ["CLE","6-4-0",-5.0,24,"DOWN 1",-4.7,-0.2,-0.1,26,19,26],
  ["NE","5-5-0",-5.7,25,"UP 1",-5.7,-0.0,-0.0,9,16,19],
  ["ATL","3-7-0",-5.8,26,"DOWN 1",-4.6,-0.8,-0.3,3,26,25],
  ["BAL","4-7-0",-5.9,27,"--",-4.7,-0.6,-0.5,27,15,16],
  ["PHI","3-7-0",-6.0,28,"DOWN 4",-6.3,0.3,0.0,10,8,17],
  ["ARI","3-8-0",-6.3,29,"DOWN 1",-3.1,-3.0,-0.2,1,28,30],
  ["TEN","1-9-0",-6.6,30,"DOWN 1",-3.2,-3.0,-0.3,14,14,32],
  ["LV","4-7-0",-8.0,31,"--",-6.3,-1.9,0.2,7,32,27],
  ["MIA","1-9-0",-11.3,32,"--",-8.3,-1.8,-1.2,4,9,31],
];

// Efficiency: team, record, overall/rank, offense/rank, defense/rank, ST/rank.
const efficiencyRows = [
  ["SF","9-1-0",73.6,1,79.9,1,58.7,10,39.4,25],
  ["KC","8-2-0",73.5,2,72.4,2,70.7,5,29.4,31],
  ["BUF","9-1-0",71.1,3,69.2,5,55.6,15,70.5,2],
  ["JAX","7-3-0",70.4,4,57.8,9,71.4,3,54.3,10],
  ["CIN","7-3-0",69.6,5,72.3,3,57.0,13,51.1,17],
  ["CHI","8-2-0",67.2,6,53.2,10,68.8,7,61.7,5],
  ["LAR","6-4-0",67.2,7,61.0,7,70.5,6,30.6,30],
  ["DET","8-2-0",65.1,8,68.6,6,47.4,22,69.2,3],
  ["SEA","6-4-0",61.3,9,41.3,20,70.8,4,62.3,4],
  ["HOU","4-6-0",59.8,10,60.5,8,54.3,16,49.7,20],
  ["MIN","7-3-0",55.8,11,26.0,31,72.3,2,75.9,1],
  ["DEN","8-2-0",54.4,12,48.7,12,56.7,14,54.3,11],
  ["DAL","5-6-0",53.5,13,70.9,4,33.3,32,49.8,19],
  ["GB","6-4-0",53.3,14,47.5,13,61.1,9,37.8,28],
  ["NYG","6-3-1",52.3,15,45.2,15,57.4,12,52.4,13],
  ["PIT","6-4-0",52.3,16,39.8,22,61.7,8,55.4,9],
  ["CAR","5-5-0",49.9,17,50.5,11,48.4,20,52.6,12],
  ["TB","3-7-0",49.3,18,28.5,30,73.3,1,46.7,22],
  ["NE","5-5-0",48.3,19,47.2,14,47.1,24,59.8,8],
  ["CLE","6-4-0",45.9,20,35.0,23,58.6,11,51.1,16],
  ["WSH","4-5-1",44.9,21,43.3,18,49.9,18,47.6,21],
  ["NO","3-7-0",41.5,22,40.3,21,50.8,17,39.0,26],
  ["BAL","4-7-0",40.5,23,42.6,19,47.2,23,38.7,27],
  ["LV","4-7-0",40.0,24,44.6,16,37.3,28,59.8,7],
  ["NYJ","3-8-0",37.4,25,44.5,17,36.5,29,50.7,18],
  ["PHI","3-7-0",35.9,26,29.0,28,49.3,19,52.3,14],
  ["IND","3-8-0",34.1,27,29.0,29,43.8,26,60.3,6],
  ["ATL","3-7-0",33.7,28,30.7,27,44.1,25,52.2,15],
  ["MIA","1-9-0",27.6,29,31.8,26,42.4,27,25.0,32],
  ["TEN","1-9-0",26.6,30,32.8,25,33.9,31,45.2,23],
  ["ARI","3-8-0",26.3,31,34.9,24,34.2,30,31.2,29],
  ["LAC","1-9-0",25.7,32,20.5,32,47.5,21,39.9,24],
];

// ESPN 2026 Season Leaders Total QBR (All NFL), supplied 2026-11-25 with the
// Week 12 tables. Player-level only: canonicalId is the GSIS identity already
// present in local NFLverse evidence; never resolved or retained by team.
// Columns: canonicalId, name, QBR, PAA, PLAYS, EPA, PASS, RUN, SACK, PEN, RAW.
// Season-leaders table: weekly QBR is not supplied and stays null.
const qbrRows = [
  ["00-0037834","Brock Purdy",84.6,44.4,360,75.3,59.9,14.0,-6.3,1.4,85.1],
  ["00-0033077","Dak Prescott",80.9,55.5,502,101.8,86.7,8.3,-5.9,6.8,82.7],
  ["00-0036442","Joe Burrow",79.7,44.4,445,84.8,79.9,2.6,-8.6,2.3,80.4],
  ["00-0039851","Drake Maye",73.8,21.3,362,52.0,37.9,12.1,-7.8,1.9,69.7],
  ["00-0039163","C.J. Stroud",72.9,32.3,428,71.1,59.4,8.7,-6.0,3.0,74.4],
  ["00-0034857","Josh Allen",70.2,25.0,419,63.4,42.6,16.8,-9.4,4.0,69.9],
  ["00-0036264","Jordan Love",69.4,25.5,432,63.1,58.1,2.6,-8.4,2.4,69.7],
  ["00-0039918","Caleb Williams",68.9,14.3,282,40.5,29.7,10.9,-5.2,-0.2,67.2],
  ["00-0036971","Trevor Lawrence",65.8,18.9,377,51.6,46.3,4.4,-6.6,0.9,67.0],
  ["00-0029604","Kirk Cousins",65.7,17.3,444,55.6,52.3,-0.3,-5.4,3.6,63.4],
  ["00-0033873","Patrick Mahomes",64.3,18.2,378,52.8,46.1,6.8,-6.1,-0.1,66.4],
  ["00-0033106","Jared Goff",62.4,15.0,397,50.8,51.3,-1.8,-10.0,1.3,63.1],
  ["00-0026498","Matthew Stafford",62.1,18.4,422,57.5,54.4,1.1,-7.3,2.1,64.9],
  ["00-0039910","Jayden Daniels",61.6,12.2,331,43.6,27.6,16.4,-8.3,-0.4,62.7],
  ["00-0039150","Bryce Young",60.9,8.6,435,47.4,42.6,3.1,-13.5,1.7,57.0],
  ["00-0040743","Tyler Shough",57.9,8.9,489,54.5,48.3,2.5,-14.0,3.7,56.4],
  ["00-0030565","Geno Smith",56.8,5.0,392,42.4,39.2,1.1,-15.3,2.2,54.5],
  ["00-0040676","Cam Ward",53.2,4.1,397,40.1,28.1,7.8,-7.9,4.2,53.6],
  ["00-0038128","Malik Willis",53.0,1.9,296,29.6,14.3,14.6,-10.8,0.7,52.3],
  ["00-0039917","Michael Penix Jr.",51.4,-1.1,298,26.0,17.5,5.9,-5.2,2.7,48.7],
  ["00-0033119","Jacoby Brissett",50.3,0.8,470,44.7,35.5,4.8,-10.2,4.5,50.6],
  ["00-0035228","Kyler Murray",48.8,-0.1,208,19.9,11.5,8.8,-6.9,-0.5,49.8],
  ["00-0034869","Sam Darnold",48.8,-1.5,262,23.5,16.4,6.6,-7.9,0.6,48.0],
  ["00-0039732","Bo Nix",48.2,-3.2,402,35.0,29.3,0.7,-4.7,5.1,47.2],
  ["00-0031503","Jameis Winston",46.2,1.7,225,23.0,13.7,8.1,-6.3,1.2,52.7],
  ["00-0023459","Aaron Rodgers",45.6,-9.1,424,30.3,23.3,3.1,-15.3,3.8,42.4],
  ["00-0033537","Deshaun Watson",39.8,-11.0,412,26.5,22.0,4.0,-13.7,0.5,40.6],
  ["00-0034855","Baker Mayfield",36.2,-14.9,248,8.8,2.8,4.2,-9.9,1.8,29.9],
  ["00-0036355","Justin Herbert",35.4,-18.5,392,18.8,13.2,4.2,-15.1,1.4,33.9],
  ["00-0035710","Daniel Jones",28.9,-26.2,427,14.3,14.6,-1.3,-11.1,0.9,29.6],
];

// ESPN Week 11 weekly QBR evidence for players not yet qualifying
// for ESPN's season-leaders table.
const weeklyQbrRows = [
  ["00-0039923","J.J. McCarthy",null,3.4,45,7.7,3.1,3.6,-0.6,1.0,74.4,74.2,11],
  ["00-0041562","Fernando Mendoza",null,-1.8,47,2.6,1.8,0.9,-2.0,0.0,36.7,43.3,11],
  ["00-0026300","Josh Johnson",null,-2.4,36,0.9,1.1,-0.2,-1.2,0.0,28.1,38.0,11],
  ["00-0039398","Joe Milton",null,-1.5,28,1.2,1.5,-0.1,-1.3,-0.2,31.9,37.3,11],
  ["00-0040014","Kyle McCord",null,-4.0,39,-0.2,-0.7,-0.4,-1.0,0.9,19.1,24.4,11],
];
export function createEspnSnapshot(fpi = fpiRows, efficiencies = efficiencyRows, qbr = qbrRows) {
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
    season: 2026,
    predictionWeek: 12,
    source: "ESPN NFL Football Power Index, Efficiencies and Total QBR",
    generatedAt: "2026-11-25T00:56:20.594Z",
    sourceUpdatedAt: null,
    providedAt: "2026-11-25T00:56:20.594Z",
    provenance: "Authoritative user-supplied ESPN tables; no scraping, interpolation or NFLverse blending",
    quarterbacks: {
      week: 12,
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
            week: 12,
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










