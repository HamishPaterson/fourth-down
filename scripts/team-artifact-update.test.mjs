import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import runtimeArtifact from "../api/nfl/nflverse-team-metrics.js";
import { solveOpponentNetwork } from "../api/nfl/opponent-network.js";
import { buildDepthMetrics, validDepthLineup } from "../api-lib/depthCharts.js";
import {
  regenerateTeamMetrics, parseTeamArtifact, serializeTeamArtifact, validateTeamArtifact,
  writeTeamArtifactAtomically,
} from "./update-nflverse.mjs";

const season = 2026;
const cutoff = "2026-10-30T00:15:00.000Z";
const now = () => new Date("2026-10-27T06:00:00.000Z");
const weekly = ["metricsByWeek", "situationalAuditsByWeek", "teamMetricsAuditsByWeek", "kickerProfilesByWeek"];
const existing = structuredClone(runtimeArtifact);
for (const field of [...weekly, "opponentNetworkByWeek"]) {
  if (existing[field]) existing[field] = Object.fromEntries(
    Object.entries(existing[field]).filter(([week]) => Number(week) < 8));
}
const game = { id: 1, season, week: 7, date: "2026-10-23T00:15:00.000Z",
  completed_at: "2026-10-23T04:00:00.000Z", status: "Final",
  visitor_team: { abbreviation: "NE" }, home_team: { abbreviation: "CHI" } };
const schedule = [game, { ...game, id: 2, week: 8, date: cutoff, status: "Scheduled", completed_at: null }];
const csv = "season,season_type,week,game_id,play_id,posteam,defteam,play_type,epa,success\n2026,REG,7,2026_07_NE_CHI,1,NE,CHI,pass,0.2,1";
const depthCsv = "dt,team,player_name,espn_id,gsis_id,pos_grp,pos_abb,pos_slot,pos_rank\n" +
  Object.keys(existing.metricsByWeek[7]).map((team) =>
    `2026-10-27T05:00:00Z,${team},${team} QB,${team}-qb,,3WR 1TE,QB,1,1`).join("\n");
const depthAsset = (extension = "csv.gz") => ({
  name: `depth_charts_2026.${extension}`, state: "uploaded", size: 100,
  browser_download_url: `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.${extension}`,
});
const metadataResponse = (assets = [depthAsset()]) =>
  Response.json({ tag_name: "depth_charts", assets });
const mockFetch = async (url) => {
  if (url.startsWith("https://api.github.com/")) return metadataResponse();
  if (url.includes("/depth_charts/")) {
    return new Response(url.endsWith(".gz") ? gzipSync(Buffer.from(depthCsv)) : depthCsv);
  }
  return new Response(url.includes("/pbp/") ? gzipSync(Buffer.from(csv)) : "week,team\n7,NE");
};
const io = { readFile, writeFile, rename, unlink };

function generated(_rows, _games, _snaps, _depth, context) {
  const teams = structuredClone(existing.metricsByWeek[7]);
  const lineups = buildDepthMetrics(_depth || [], context);
  for (const metrics of Object.values(teams)) Object.assign(metrics, {
    predictionWeek: 8, cutoff, season,
    expectedLineup: lineups[metrics.team] || null,
    expectedKicker: null,
    availability: { ...metrics.availability, contextAvailable: Boolean(lineups[metrics.team]),
      lineupAvailable: validDepthLineup(lineups[metrics.team], 8, season), kickerIdentityAvailable: false },
    provenance: { ...metrics.provenance, context: { source: "nflverse depth charts",
      observedAt: lineups[metrics.team]?.snapshotAt || null, available: Boolean(lineups[metrics.team]) } },
  });
  return {
    metrics: teams,
    audit: { ...context, available: true, referenceWeek: 7,
      eligibleGames: existing.teamMetricsAuditsByWeek[7].eligibleGames + 1, eligiblePlays: 1,
      gameProvenance: [...existing.teamMetricsAuditsByWeek[7].gameProvenance,
        { key: "2026:7:CHI:NE", providerId: "1", gameId: "2026_07_NE_CHI", week: 7,
        away: "NE", home: "CHI", kickoff: game.date, completedAsOf: game.completed_at }] },
    situational: { audit: { ...existing.situationalAuditsByWeek[7], cutoff } },
    kickers: { ...existing.kickerProfilesByWeek[7], predictionWeek: 8, cutoff },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "team-updater-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "team.js");
  const original = serializeTeamArtifact(existing);
  await writeFile(destination, original);
  return { directory, destination, original, options: {
    season, outputPath: destination, now, io,
    fetchImpl: mockFetch,
    scheduleFetcher: async () => schedule, generateWeek: generated,
    generateNetwork: async () => {
      const games = generated(null, null, null, null, {}).audit.gameProvenance.map((game, i) => ({
        id: game.providerId, season, week: game.week, away: game.away, home: game.home,
        date: game.kickoff, awayScore: 20 + i % 8, homeScore: 24 + i % 6, weight: 1,
      }));
      return { season, week: 8, games, ratings: solveOpponentNetwork(games, 8) };
    },
  } };
}

test("existing team artifact parses and validates; malformed/invalid inputs fail before network reads", async (t) => {
  validateTeamArtifact(parseTeamArtifact(serializeTeamArtifact(existing)), { season });
  const f = await fixture(t);
  for (const bytes of ["broken", serializeTeamArtifact({ ...existing, season: 2025 })]) {
    await writeFile(f.destination, bytes);
    await assert.rejects(regenerateTeamMetrics({ ...f.options, fetchImpl: () => assert.fail("network read") }));
    assert.equal(await readFile(f.destination, "utf8"), bytes);
  }
});

test("only Week 8 is generated; historical contexts, player bytes and deterministic serialization are preserved", async (t) => {
  const f = await fixture(t), calls = [];
  const playerPath = new URL("../data/nflverse-player-metrics.js", import.meta.url);
  const hash = () => readFile(playerPath).then((b) => createHash("sha256").update(b).digest("hex"));
  const before = await hash();
  const result = await regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
    calls.push(args[4].predictionWeek);
    return generated(...args);
  } });
  assert.deepEqual(calls, [8]);
  for (const field of weekly) {
    for (const week of Object.keys(existing[field])) assert.deepEqual(result.payload[field][week], existing[field][week]);
    assert.deepEqual(Object.keys(result.payload[field]), ["2", "3", "4", "5", "6", "7", "8"]);
  }
  const first = await readFile(f.destination, "utf8");
  await regenerateTeamMetrics(f.options);
  assert.equal(await readFile(f.destination, "utf8"), first);
  assert.equal(serializeTeamArtifact(parseTeamArtifact(first)), first);
  assert.equal(await hash(), before);
  assert.equal(Object.keys(result.payload.metricsByWeek).filter((w) => w === "8").length, 1);
  const replacement = await regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
    const updated = generated(...args);
    updated.metrics.NE.epaPerPlay += 0.01;
    return updated;
  } });
  assert.notDeepEqual(replacement.payload.metricsByWeek[8], result.payload.metricsByWeek[8]);
  assert.deepEqual(replacement.payload.metricsByWeek[7], existing.metricsByWeek[7]);
  assert.deepEqual(replacement.payload.opponentNetworkByWeek[8], result.payload.opponentNetworkByWeek[8]);
  assert.equal(Object.keys(replacement.payload.metricsByWeek).filter((w) => w === "8").length, 1);
});

for (const stage of ["schedule", "PBP", "generation", "validation", "temporary-write", "temporary-validation", "rename"]) {
  test(`${stage} failure preserves original runtime bytes and cleans only its temporary file`, async (t) => {
    const f = await fixture(t), options = { ...f.options };
    if (stage === "schedule") options.scheduleFetcher = async () => { throw new Error("schedule failed"); };
    if (stage === "PBP") options.fetchImpl = async (url) => url.includes("/pbp/")
      ? new Response(null, { status: 503 }) : mockFetch(url);
    if (stage === "generation") options.generateWeek = () => { throw new Error("generation failed"); };
    if (stage === "validation") options.generateWeek = (...args) => {
      const result = generated(...args); result.metrics.NE.epaPerPlay = NaN; return result;
    };
    if (stage === "temporary-write") options.io = { ...io, writeFile: async (file) => {
      await writeFile(file, "interrupted"); throw new Error("interrupted");
    } };
    if (stage === "temporary-validation") options.io = { ...io, readFile: (file, encoding) =>
      file.endsWith(".tmp") ? Promise.resolve("corrupted") : readFile(file, encoding) };
    if (stage === "rename") options.io = { ...io, rename: async () => { throw new Error("rename failed"); } };
    const expected = {
      schedule: /schedule failed/, PBP: /503/, generation: /generation failed/,
      validation: /Non-finite/, "temporary-write": /interrupted/,
      "temporary-validation": /bytes differ/, rename: /rename failed/,
    };
    await assert.rejects(regenerateTeamMetrics(options), expected[stage]);
    assert.equal(await readFile(f.destination, "utf8"), f.original);
    assert.deepEqual(await readdir(f.directory), ["team.js"]);
  });
}

test("temporary output is parsed and validated before the single atomic rename", async (t) => {
  const f = await fixture(t), operations = [];
  await regenerateTeamMetrics({ ...f.options, io: {
    ...io,
    writeFile: async (file, bytes, flags) => {
      assert.equal(path.dirname(file), f.directory);
      assert.equal(flags.flag, "wx"); operations.push("write"); await writeFile(file, bytes, flags);
    },
    readFile: async (file, encoding) => {
      if (file.endsWith(".tmp")) operations.push("validate");
      return readFile(file, encoding);
    },
    rename: async (from, to) => {
      assert.equal(to, f.destination); assert.equal(await readFile(to, "utf8"), f.original);
      operations.push("rename"); await rename(from, to);
    },
  } });
  assert.deepEqual(operations, ["write", "validate", "rename"]);
});

test("player artifact path is rejected before all I/O", async () => {
  await assert.rejects(regenerateTeamMetrics({ season, outputPath: "data/nflverse-player-metrics.js",
    io: { readFile: () => assert.fail("read") } }), /player artifact/);
});

for (const problem of ["duplicate-game", "duplicate-team", "unknown-team", "non-finite",
  "stale-week-personnel", "future-personnel", "stale-kicker"]) {
  test(`rejects ${problem} without replacing runtime artifact`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
      const result = generated(...args);
      if (problem === "duplicate-game") {
        result.audit.gameProvenance.push(result.audit.gameProvenance[0]); result.audit.eligibleGames++;
      }
      if (problem === "duplicate-team") result.metrics.NE.team = "CHI";
      if (problem === "unknown-team") { result.metrics.UNKNOWN = result.metrics.NE; delete result.metrics.NE; }
      if (problem === "non-finite") result.metrics.NE.epaPerPlay = Infinity;
      if (problem === "stale-week-personnel") result.metrics.NE.expectedLineup.predictionWeek = 7;
      if (problem === "future-personnel") result.metrics.NE.expectedLineup.snapshotAt = "2026-10-27T07:00:00Z";
      if (problem === "stale-kicker") result.metrics.NE.expectedKicker = {
        team: "NE", depthChartPlayerId: "old-kicker", provenance: { observedAt: "2026-10-22T05:00:00Z" },
      };
      return result;
    } }));
    assert.equal(await readFile(f.destination, "utf8"), f.original);
  });
}

test("duplicate schedule games and missing completed-game PBP fail explicitly", async (t) => {
  const f = await fixture(t);
  await assert.rejects(regenerateTeamMetrics({ ...f.options, scheduleFetcher: async () => [...schedule, game] }), /duplicate/);
  await assert.rejects(regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
    const result = generated(...args);
    result.audit.gameProvenance = []; result.audit.eligibleGames = 0;
    return result;
  } }), /Missing eligible NFLverse PBP/);
  assert.equal(await readFile(f.destination, "utf8"), f.original);
});

test("incomplete cumulative history, missing team coverage and network failure preserve runtime bytes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
    const result = generated(...args);
    result.audit.gameProvenance.shift(); result.audit.eligibleGames--;
    return result;
  } }), /Incomplete cumulative team history/);
  await assert.rejects(regenerateTeamMetrics({ ...f.options, generateWeek: (...args) => {
    const result = generated(...args); result.metrics.NE.availability.teamMetricsAvailable = false;
    return result;
  } }), /lacks team PBP coverage/);
  await assert.rejects(regenerateTeamMetrics({ ...f.options, generateNetwork: async () => {
    throw new Error("network generation failed");
  } }), /network generation failed/);
  assert.equal(await readFile(f.destination, "utf8"), f.original);
});

test("atomic writer refuses malformed temporary artifacts without replacing the runtime file", async (t) => {
  const f = await fixture(t);
  await assert.rejects(writeTeamArtifactAtomically(f.destination, "invalid", { season, io }));
  assert.equal(await readFile(f.destination, "utf8"), f.original);
});

test("official release metadata selects the published gzip asset, not a guessed replacement", async (t) => {
  const f = await fixture(t), calls = [];
  const result = await regenerateTeamMetrics({ ...f.options, fetchImpl: async (url) => {
    calls.push(url);
    return mockFetch(url);
  }, generateWeek: (...args) => {
    assert.equal(args[3].length, 32);
    assert.equal(args[3][0].dt, "2026-10-27T05:00:00Z");
    return generated(...args);
  } });
  assert.equal(calls[0], "https://api.github.com/repos/nflverse/nflverse-data/releases/tags/depth_charts");
  assert.equal(calls.filter((url) => url.includes("/depth_charts/")).length, 1);
  assert.ok(calls.includes(depthAsset().browser_download_url));
  assert.equal(result.payload.sourceStatus.depthCharts.url, depthAsset().browser_download_url);
});

test("plain CSV is supported only when explicitly published in official metadata", async (t) => {
  const f = await fixture(t);
  const result = await regenerateTeamMetrics({ ...f.options, fetchImpl: (url) =>
    url.startsWith("https://api.github.com/") ? metadataResponse([depthAsset("csv")]) : mockFetch(url) });
  assert.equal(result.payload.sourceStatus.depthCharts.url, depthAsset("csv").browser_download_url);
});

test("historical Opponent Network and all Week 2-7 maps remain structurally unchanged", async (t) => {
  const f = await fixture(t);
  const historical = structuredClone(existing);
  const audit = historical.teamMetricsAuditsByWeek[7];
  const games = audit.gameProvenance.map((game) => ({
    id: game.providerId, season, week: game.week, away: game.away, home: game.home,
    date: game.kickoff, awayScore: 20, homeScore: 24, weight: 1,
  }));
  historical.opponentNetworkByWeek = { 7: {
    season, week: 7, games, ratings: solveOpponentNetwork(games, 7),
    provenance: { cutoff: audit.cutoff, sourceAsOf: audit.sourceAsOf, gameProvenance: audit.gameProvenance },
  } };
  await writeFile(f.destination, serializeTeamArtifact(historical));
  const { payload } = await regenerateTeamMetrics(f.options);
  for (const field of [...weekly, "opponentNetworkByWeek"]) {
    for (const [week, value] of Object.entries(historical[field])) {
      assert.deepEqual(payload[field][week], value, `${field}:${week}`);
    }
  }
});

for (const stage of ["missing-asset", "metadata-request", "malformed-metadata", "untrusted-url",
  "depth-404", "depth-429", "depth-503", "empty-depth", "malformed-depth", "invalid-timestamp",
  "invalid-rank", "missing-team", "future-depth"]) {
  test(`${stage} fails without source substitution, retries or artifact changes`, async (t) => {
    const f = await fixture(t), calls = [];
    const expected = {
      "missing-asset": /official depth-chart CSV asset unavailable/,
      "metadata-request": /metadata unavailable \(503\)/,
      "malformed-metadata": /Malformed official depth release metadata/,
      "untrusted-url": /Invalid official depth asset/,
      "depth-404": /\(404\)/, "depth-429": /\(429\)/, "depth-503": /\(503\)/,
      "empty-depth": /depth source is empty/, "malformed-depth": /depth source missing dt/,
      "invalid-timestamp": /Malformed team depth source row/,
      "invalid-rank": /Malformed team depth source row/,
      "missing-team": /lacks eligible depth-source coverage/,
      "future-depth": /lacks eligible depth-source coverage/,
    };
    await assert.rejects(regenerateTeamMetrics({ ...f.options, fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        if (stage === "missing-asset") return metadataResponse([{
          ...depthAsset(), name: "depth_charts_2025.csv.gz",
        }]);
        if (stage === "metadata-request") return new Response(null, { status: 503 });
        if (stage === "malformed-metadata") return Response.json({ assets: [] });
        if (stage === "untrusted-url") return metadataResponse([{
          ...depthAsset(), browser_download_url: "https://example.com/not-official.csv.gz",
        }]);
      }
      if (url.includes("/depth_charts/")) {
        if (/^depth-\d+$/.test(stage)) return new Response(null, { status: Number(stage.slice(6)) });
        let text = depthCsv;
        if (stage === "empty-depth") text = "";
        if (stage === "malformed-depth") text = "week,team\n8,NE";
        if (stage === "invalid-timestamp") text = text.replaceAll("2026-10-27T05:00:00Z", "invalid");
        if (stage === "invalid-rank") text = text.replaceAll(",QB,1,1", ",QB,1,NaN");
        if (stage === "missing-team") text = text.split("\n").slice(0, -1).join("\n");
        if (stage === "future-depth") text = text.replaceAll("2026-10-27T05:00:00Z", "2026-10-27T07:00:00Z");
        return new Response(gzipSync(Buffer.from(text)));
      }
      return mockFetch(url);
    } }), expected[stage]);
    assert.equal(new Set(calls).size, calls.length, "no failed request retried");
    assert.ok(calls.every((url) => !url.includes("2025")), "no prior-season substitution");
    assert.equal(await readFile(f.destination, "utf8"), f.original);
    assert.deepEqual(await readdir(f.directory), ["team.js"]);
  });
}
