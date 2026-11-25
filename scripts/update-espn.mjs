// Weekly ESPN inputs: FPI, efficiencies and Total QBR from ESPN's public JSON feeds.
// Writes src/services/espnSnapshotData.js only when every check passes; any doubt leaves
// the previous file untouched and exits non-zero.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEspnSnapshot } from "../src/services/espnFpiRatings.js";
import { getCalendarWeek } from "../src/services/weekLifecycle.js";

const BASE = "https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl";
const OUTPUT = path.resolve("src/services/espnSnapshotData.js");
const TEAM = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
const FPI = ["fpi", "epaoffense", "epadefense", "epaspecialteams", "fpirank", "avgsosrank", "sosremainingrank",
  "avgingamewprank", "rankchange7days", "numwins", "numlosses", "numties"];
const EFFICIENCY = ["totefficiency", "totefficiencyrank", "offefficiency", "offefficiencyrank",
  "defefficiency", "defefficiencyrank", "stefficiency", "stefficiencyrank"];
const QBR = ["schedAdjQBR", "qbpaa", "actionPlays", "cwepaTotal", "cwepaPassesCondensed", "cwepaRuns",
  "cwepaSackedCondensed", "cwepaPenalties", "qbr"];
const fail = (message) => { throw new Error(`ESPN update refused: ${message}`); };
const tenth = (value) => { const rounded = Math.round(Number(value) * 10) / 10; return rounded === 0 ? 0 : rounded; };

function reader(payload, category, wanted) {
  const names = payload?.categories?.find((row) => row.name === category)?.names;
  if (!Array.isArray(names)) fail(`missing ${category} columns`);
  const index = Object.fromEntries(wanted.map((name) => [name, names.indexOf(name)]));
  for (const name of wanted) if (index[name] < 0) fail(`missing ${category} column ${name}`);
  return (entry, field) => {
    const values = entry.categories?.find((row) => row.name === category)?.[field];
    return Object.fromEntries(wanted.map((name) => {
      const value = Number(values?.[index[name]]);
      if (!Number.isFinite(value)) fail(`invalid ${category}.${name}`);
      return [name, value];
    }));
  };
}

export function buildTeamRows(payload, { season, completedGames, notBefore }) {
  if (Number(payload?.requestedSeason?.year ?? payload?.currentSeason?.year) !== season) fail("wrong season");
  const updated = Date.parse(payload.lastUpdated);
  if (!Number.isFinite(updated) || updated < notBefore) {
    fail(`team ratings last updated ${payload.lastUpdated}, before the final game of the completed week`);
  }
  const fpi = reader(payload, "fpi", FPI), efficiency = reader(payload, "efficiencies", EFFICIENCY);
  let teamGames = 0;
  const fpiRows = [], efficiencyRows = [];
  for (const entry of payload.teams || []) {
    const code = TEAM[entry.team?.abbreviation] || entry.team?.abbreviation;
    const f = fpi(entry, "values"), e = efficiency(entry, "values");
    const record = [f.numwins, f.numlosses, f.numties].join("-");
    teamGames += f.numwins + f.numlosses + f.numties;
    const change = f.rankchange7days;
    fpiRows.push([code, record, tenth(f.fpi), f.fpirank, change === 0 ? "--" : `${change > 0 ? "UP" : "DOWN"} ${Math.abs(change)}`,
      tenth(f.epaoffense), tenth(f.epadefense), tenth(f.epaspecialteams), f.avgsosrank, f.sosremainingrank, f.avgingamewprank]);
    efficiencyRows.push([code, record, tenth(e.totefficiency), e.totefficiencyrank, tenth(e.offefficiency), e.offefficiencyrank,
      tenth(e.defefficiency), e.defefficiencyrank, tenth(e.stefficiency), e.stefficiencyrank]);
    if (Math.abs(f.epaoffense + f.epadefense + f.epaspecialteams - f.fpi) > 0.1) fail(`${code} FPI components do not add up`);
  }
  if (teamGames !== completedGames * 2) fail(`records cover ${teamGames / 2} games, expected ${completedGames}`);
  const order = (a, b) => a[3] - b[3];
  return { fpiRows: fpiRows.sort(order), efficiencyRows: efficiencyRows.sort(order), lastUpdated: payload.lastUpdated };
}

export function buildQbrRows(seasonPayload, weekPayload, { referenceWeek, resolveId }) {
  const seasonOf = reader(seasonPayload, "general", QBR), weekOf = reader(weekPayload, "general", QBR);
  const row = (athlete, read) => {
    const name = athlete.athlete?.displayName, id = resolveId(String(athlete.athlete?.id || ""), name);
    const v = read(athlete, "totals");
    return { id, name, v };
  };
  const season = (seasonPayload.athletes || []).map((athlete) => row(athlete, seasonOf));
  if (season.length < 20) fail(`only ${season.length} season QBR rows`);
  const missing = season.filter((entry) => !entry.id);
  if (missing.length) fail(`no canonical identity for ${missing.map((entry) => entry.name).join(", ")}`);
  const qualified = new Set(season.map((entry) => entry.id));
  // Players outside the season leaders carry only their genuine latest-week rating.
  const weekly = (weekPayload.athletes || []).map((athlete) => row(athlete, weekOf));
  if (weekly.length < 15) fail(`only ${weekly.length} Week ${referenceWeek} QBR rows`);
  const unresolvedWeekly = weekly.filter((entry) => !entry.id).map((entry) => entry.name);
  const values = ({ v }) => [v.qbpaa, v.actionPlays, v.cwepaTotal, v.cwepaPassesCondensed, v.cwepaRuns,
    v.cwepaSackedCondensed, v.cwepaPenalties, v.qbr].map((value) => (value === 0 ? 0 : value));
  return {
    qbrRows: season.map((entry) => [entry.id, entry.name, entry.v.schedAdjQBR, ...values(entry)]),
    weeklyQbrRows: weekly.filter((entry) => entry.id && !qualified.has(entry.id))
      .map((entry) => [entry.id, entry.name, null, ...values(entry), entry.v.schedAdjQBR, referenceWeek]),
    unresolvedWeekly,
  };
}

// ESPN athlete ids are the depth-chart player ids, which already carry the GSIS identity.
export function identityResolver(teamArtifact, predictionWeek) {
  const byEspn = new Map();
  for (let week = predictionWeek; week >= 2; week -= 1) {
    for (const metrics of Object.values(teamArtifact.metricsByWeek?.[week] || {})) {
      for (const player of metrics.expectedLineup?.roster || []) {
        if (!player.playerId || !/^00-\d{7}$/.test(player.gsisId || "")) continue;
        const known = byEspn.get(String(player.playerId));
        if (known && known !== player.gsisId) fail(`conflicting identity for ${player.name}`);
        byEspn.set(String(player.playerId), player.gsisId);
      }
    }
  }
  return (espnId) => byEspn.get(espnId) || null;
}

export function serialize(data) {
  const rows = (list) => `[\n${list.map((row) => `    ${JSON.stringify(row)},`).join("\n")}\n  ]`;
  return `// GENERATED by scripts/update-espn.mjs - do not edit by hand.
const ESPN_SNAPSHOT_DATA = {
  season: ${data.season},
  predictionWeek: ${data.predictionWeek},
  generatedAt: ${JSON.stringify(data.generatedAt)},
  sourceUpdatedAt: ${JSON.stringify(data.sourceUpdatedAt)},
  // team, record, FPI, rank, trend, OFF, DEF, ST, SOS, remaining SOS, AVGWP.
  fpiRows: ${rows(data.fpiRows)},
  // team, record, overall/rank, offense/rank, defense/rank, ST/rank.
  efficiencyRows: ${rows(data.efficiencyRows)},
  // canonicalId, name, QBR, PAA, PLAYS, EPA, PASS, RUN, SACK, PEN, RAW.
  qbrRows: ${rows(data.qbrRows)},
  // As above with no season QBR, then weekly QBR and week; non-qualifying players only.
  weeklyQbrRows: ${rows(data.weeklyQbrRows)},
};

export default ESPN_SNAPSHOT_DATA;
`;
}

export async function updateEspn({ season, predictionWeek, teamArtifact, fetchImpl = fetch, now = () => new Date(), output = OUTPUT }) {
  const audit = teamArtifact.teamMetricsAuditsByWeek?.[predictionWeek];
  if (audit?.available !== true || audit.referenceWeek !== predictionWeek - 1) fail(`run the NFLverse Week ${predictionWeek} update first`);
  const notBefore = Math.max(...audit.gameProvenance.map((game) => Date.parse(game.kickoff))) + 3 * 3600000;
  const get = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail(`HTTP ${response.status}`);
    return response.json();
  };
  const qbr = (type, extra = "") => get(`${BASE}/qbr?region=us&lang=en&qbrType=${type}&seasontype=2&isqualified=true&sort=schedAdjQBR:desc&season=${season}&limit=100${extra}`);
  const [teams, seasonQbr, weekQbr] = [
    await get(`${BASE}/powerindex?region=us&lang=en&season=${season}&limit=50`),
    await qbr("seasons"), await qbr("weeks", `&week=${predictionWeek - 1}`),
  ];
  const team = buildTeamRows(teams, { season, completedGames: audit.eligibleGames, notBefore });
  const quarterbacks = buildQbrRows(seasonQbr, weekQbr, { referenceWeek: predictionWeek - 1, resolveId: identityResolver(teamArtifact, predictionWeek) });
  const data = { season, predictionWeek, generatedAt: now().toISOString(), sourceUpdatedAt: team.lastUpdated,
    fpiRows: team.fpiRows, efficiencyRows: team.efficiencyRows, qbrRows: quarterbacks.qbrRows, weeklyQbrRows: quarterbacks.weeklyQbrRows };
  createEspnSnapshot(data.fpiRows, data.efficiencyRows, data.qbrRows, data); // runs every structural check
  const temporary = `${output}.tmp`;
  try { await writeFile(temporary, serialize(data)); await rename(temporary, output); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { ...data, unresolvedWeekly: quarterbacks.unresolvedWeekly };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { default: teamArtifact } = await import("../api/nfl/nflverse-team-metrics.js");
  const result = await updateEspn({ season: 2026, predictionWeek: Number(process.argv[2]) || getCalendarWeek(), teamArtifact });
  console.log(`Wrote ESPN Week ${result.predictionWeek}: ${result.fpiRows.length} teams, ${result.qbrRows.length} season QBR, ${result.weeklyQbrRows.length} weekly-only; source ${result.sourceUpdatedAt}`);
  if (result.unresolvedWeekly.length) console.log(`No identity, skipped: ${result.unresolvedWeekly.join(", ")}`);
}
