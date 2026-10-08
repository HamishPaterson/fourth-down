import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const season = Number(process.argv[2] || new Date().getUTCFullYear());
const outputPath = path.resolve("src/services/espnFpiRatings.js");
const expectedTeams = ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WSH"];
const aliases = { WSH: "WSH", WAS: "WSH", LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC", JAC: "JAX" };
const endpoints = [
  `https://site.api.espn.com/apis/fittwo/v3/sports/football/nfl/powerindex?region=us&lang=en&contentorigin=espn&isqualified=true&season=${season}`,
  `https://www.espn.com/nfl/fpi/_/season/${season}`,
  "https://www.espn.com/nfl/fpi",
];

const previous = await readPreviousOutput();
let imported;
let sourceUrl;
let lastError;

for (const url of endpoints) {
  try {
    console.log(`Checking ESPN FPI: ${url}`);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "User-Agent": "FourthDown-FPI-Updater/1.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const rows = extractRows(text, response.headers.get("content-type") || "");
    imported = validateAndConvert(rows);
    sourceUrl = url;
    break;
  } catch (error) {
    lastError = error;
    console.warn(`ESPN FPI candidate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!imported) {
  if (previous?.available && Object.keys(previous.teams || {}).length === 32) {
    console.warn("ESPN FPI refresh failed. Keeping the last valid generated dataset.");
    process.exitCode = 0;
    process.exit();
  }
  throw new Error(`ESPN FPI import failed and no valid previous dataset exists: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const payload = {
  source: "ESPN Football Power Index",
  sourceUrl,
  season,
  generatedAt: new Date().toISOString(),
  sourceUpdatedAt: imported.sourceUpdatedAt,
  available: true,
  conversion: {
    overall: "75 + FPI * 3.0",
    offense: "75 + OFF * 3.0",
    defense: "75 + DEF contribution * 3.0",
    specialTeams: "75 + ST * 6.0",
    bounds: "50 to 100",
  },
  teams: imported.teams,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `const ESPN_FPI_RATINGS = ${JSON.stringify(payload, null, 2)};\n\nexport default ESPN_FPI_RATINGS;\n`);
console.log(`Wrote ${outputPath} with ${Object.keys(payload.teams).length} teams.`);

function extractRows(text, contentType) {
  const documents = [];
  if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    documents.push(JSON.parse(text));
  } else {
    for (const pattern of [
      /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
      /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi,
    ]) {
      let match;
      while ((match = pattern.exec(text))) {
        try { documents.push(JSON.parse(decodeHtml(match[1]))); } catch { /* Try other embedded payloads. */ }
        if (!pattern.global) break;
      }
    }
  }

  const candidates = [];
  for (const document of documents) walk(document, candidates);
  const rows = candidates.map(normalizeCandidate).filter(Boolean);
  return deduplicate(rows);
}

function walk(value, candidates) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, candidates);
    return;
  }
  if (looksLikeFpiRow(value)) candidates.push(value);
  for (const child of Object.values(value)) walk(child, candidates);
}

function looksLikeFpiRow(row) {
  const text = JSON.stringify(row).toLowerCase();
  return (text.includes("fpi") || text.includes("powerindex")) &&
    (text.includes("off") || text.includes("offense")) &&
    (text.includes("def") || text.includes("defense"));
}

function normalizeCandidate(row) {
  const teamObject = row.team || row.club || row.athlete || row;
  const code = normalizeCode(firstValue(teamObject, ["abbreviation","abbr","shortName","code"]) || firstValue(row, ["teamAbbreviation","teamAbbr","abbreviation"]));
  if (!expectedTeams.includes(code)) return null;

  const stats = flattenStats(row);
  const fpi = findNumber(stats, ["fpi","powerindex","powerIndex","overall"]);
  const offense = findNumber(stats, ["off","offense","offensive"]);
  const defense = findNumber(stats, ["def","defense","defensive"]);
  const specialTeams = findNumber(stats, ["st","specialteams","specialTeams"]);
  const rank = findNumber(stats, ["fpi_rank","fpirank","rank"]);
  if (![fpi, offense, defense, specialTeams].every(Number.isFinite)) return null;
  return { code, fpi, offense, defense, specialTeams, rank: Number.isFinite(rank) ? rank : null };
}

function flattenStats(row) {
  const output = {};
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const name = value.name || value.abbreviation || value.shortDisplayName || value.label;
    const numeric = number(value.value ?? value.displayValue ?? value.number);
    if (name && Number.isFinite(numeric)) output[normalizeKey(name)] = numeric;
    for (const [key, child] of Object.entries(value)) {
      const direct = number(child);
      if (Number.isFinite(direct)) output[normalizeKey(key)] = direct;
      else visit(child);
    }
  };
  visit(row);
  return output;
}

function validateAndConvert(rows) {
  const byCode = Object.fromEntries(rows.map((row) => [row.code, row]));
  const missing = expectedTeams.filter((code) => !byCode[code]);
  if (missing.length) throw new Error(`Schema validation failed. Missing teams: ${missing.join(", ")}`);
  if (Object.keys(byCode).length !== 32) throw new Error(`Expected 32 teams, received ${Object.keys(byCode).length}`);

  const teams = Object.fromEntries(expectedTeams.map((code) => {
    const row = byCode[code];
    return [code, {
      overall: rating(row.fpi, 3),
      offense: rating(row.offense, 3),
      defense: rating(row.defense, 3),
      specialTeams: rating(row.specialTeams, 6),
      source: "ESPN FPI",
      espnFpi: {
        overall: round(row.fpi),
        offense: round(row.offense),
        defense: round(row.defense),
        specialTeams: round(row.specialTeams),
        rank: row.rank,
      },
    }];
  }));
  return { teams, sourceUpdatedAt: new Date().toISOString() };
}

async function readPreviousOutput() {
  try {
    const source = await readFile(outputPath, "utf8");
    const match = source.match(/const ESPN_FPI_RATINGS = ([\s\S]*?);\s*export default/);
    return match ? JSON.parse(match[1]) : null;
  } catch { return null; }
}

function deduplicate(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.code, row);
  return [...map.values()];
}
function firstValue(object, keys) { for (const key of keys) if (object?.[key]) return object[key]; return null; }
function findNumber(stats, keys) { for (const key of keys) { const value = stats[normalizeKey(key)]; if (Number.isFinite(value)) return value; } return NaN; }
function normalizeKey(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normalizeCode(value) { const code = String(value || "").trim().toUpperCase(); return aliases[code] || code; }
function decodeHtml(value) { return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function number(value) { if (value === null || value === undefined || value === "") return NaN; const parsed = Number(String(value).replace(/[^0-9+.-]/g, "")); return Number.isFinite(parsed) ? parsed : NaN; }
function rating(value, multiplier) { return Math.round(Math.min(100, Math.max(50, 75 + value * multiplier))); }
function round(value) { return Math.round(value * 1000) / 1000; }
