import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import artifact from "../data/nflverse-player-metrics.js";
import {
  buildWeeklyPlayerMetrics,
  parsePlay,
  regeneratePlayerMetrics,
  serializePlayerArtifact,
} from "./update-nflverse-players.mjs";

const teams = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH",
];
const season = 2026;
const cutoff = "2026-10-23T00:15:00.000Z";
const weekSevenSchedule = [
  ...Array.from({ length: 16 }, (_, index) => ({
    id: `week-one-${index}`,
    season,
    week: 1,
    season_type: "REG",
    status: "Final",
    date: `2026-09-13T17:00:00.000Z`,
    updated_at: "2026-09-13T21:00:00.000Z",
    visitor_team: { abbreviation: teams[index * 2] },
    home_team: { abbreviation: teams[index * 2 + 1] },
  })),
  ...Array.from({ length: 14 }, (_, index) => ({
    id: `week-seven-${index}`,
    season,
    week: 7,
    season_type: "REG",
    status: "Scheduled",
    date: cutoff,
  })),
];
const csv = [
  "season,game_id,play_id,week,posteam,defteam,play_type,wp,season_type,pass_attempt,complete_pass,passer_player_id,passer_player_name",
  "2026,2026_06_NYG_KC,1,6,NYG,KC,pass,0.5,REG,1,1,00-0033119,Quarterback",
].join("\n");

function generatedWeek(predictionWeek, weekCutoff, marker = "first") {
  return Object.fromEntries(Array.from({ length: 16 }, (_, index) => {
    const away = teams[index * 2];
    const home = teams[index * 2 + 1];
    const gameId = `2026_01_${away}_${home}`;
    const game = {
      gameId,
      week: 1,
      away,
      home,
      kickoff: "2026-09-13T17:00:00.000Z",
      completedAsOf: "2026-09-13T21:00:00.000Z",
    };
    const entry = (team) => ({
      team,
      games: 1,
      teamTotals: {
        passAttempts: 1,
        completions: 1,
        passingYards: 10,
        sacksAllowed: 0,
        rushingAttempts: 0,
        targets: 1,
      },
      players: {
        [`${team}-player`]: {
          playerId: `${team}-player`,
          gsisId: `${team}-player`,
          playerName: `${marker}-${team}`,
          team,
          position: "QB",
          games: 1,
          weeks: [1],
          gameLog: [{ gameId, week: 1 }],
        },
      },
      predictionWeek,
      cutoff: weekCutoff,
      expectedCompletedGames: 1,
      gameProvenance: [game],
    });
    return [[away, entry(away)], [home, entry(home)]];
  }).flat());
}

function dependencies({ generateWeek, io, now } = {}) {
  return {
    season,
    outputPath: path.join(os.tmpdir(), `fourth-down-player-updater-${process.pid}-${Math.random()}.js`),
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => gzipSync(Buffer.from(csv)),
    }),
    scheduleFetcher: async () => weekSevenSchedule,
    now: now || (() => new Date("2026-10-19T06:00:00.000Z")),
    generateWeek: generateWeek || ((_plays, _schedule, options) =>
      generatedWeek(options.predictionWeek, options.cutoff)),
    ...(io ? { io } : {}),
  };
}

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "player-updater-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedArtifact(outputPath) {
  const original = structuredClone(artifact);
  await writeFile(outputPath, serializePlayerArtifact(original));
  return { original, bytes: await readFile(outputPath) };
}

test("Week 7 regeneration preserves Weeks 2-6 and adds all 32 canonical teams", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "player-metrics.js");
    const { original } = await seedArtifact(outputPath);
    const result = await regeneratePlayerMetrics({ ...dependencies(), outputPath });
    const saved = await readFile(outputPath, "utf8");

    assert.equal(result.predictionWeek, 7);
    assert.equal(result.cutoff, cutoff);
    assert.deepEqual(Object.keys(result.payload.playerMetricsByWeek).map(Number), [2, 3, 4, 5, 6, 7]);
    for (const week of [2, 3, 4, 5, 6]) {
      assert.deepEqual(result.payload.playerMetricsByWeek[week], original.playerMetricsByWeek[week]);
    }
    assert.deepEqual(Object.keys(result.payload.playerMetricsByWeek[7]).sort(), [...teams].sort());
    assert.equal(result.payload.cutoffs[7], cutoff);
    assert.deepEqual(JSON.parse(saved.slice(
      "const NFLVERSE_PLAYER_METRICS = ".length,
      -";\n\nexport default NFLVERSE_PLAYER_METRICS;\n".length,
    )).playerMetricsByWeek[6], original.playerMetricsByWeek[6]);
  });
});

test("re-running Week 7 replaces only the target week and serialization is deterministic", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "player-metrics.js");
    const { original } = await seedArtifact(outputPath);
    const first = await regeneratePlayerMetrics({
      ...dependencies({ generateWeek: () => generatedWeek(7, cutoff, "first") }),
      outputPath,
    });
    const firstWeek = structuredClone(first.payload.playerMetricsByWeek[7]);
    const second = await regeneratePlayerMetrics({
      ...dependencies({ generateWeek: () => generatedWeek(7, cutoff, "second") }),
      outputPath,
    });

    assert.notDeepEqual(second.payload.playerMetricsByWeek[7], firstWeek);
    assert.deepEqual(Object.keys(second.payload.playerMetricsByWeek).map(Number), [2, 3, 4, 5, 6, 7]);
    for (const week of [2, 3, 4, 5, 6]) {
      assert.deepEqual(second.payload.playerMetricsByWeek[week], original.playerMetricsByWeek[week]);
    }
    assert.equal(
      serializePlayerArtifact(second.payload),
      serializePlayerArtifact(JSON.parse(serializePlayerArtifact(second.payload).slice(
        "const NFLVERSE_PLAYER_METRICS = ".length,
        -";\n\nexport default NFLVERSE_PLAYER_METRICS;\n".length,
      ))),
    );
  });
});

test("generation and target-validation failures leave the original artifact byte-identical", async (t) => {
  for (const scenario of [
    ["generation", () => { throw new Error("mock generation failure"); }],
    ["validation", () => Object.fromEntries(Object.entries(generatedWeek(7, cutoff)).slice(0, 31))],
  ]) {
    await t.test(scenario[0], async () => {
      await withDirectory(async (directory) => {
        const outputPath = path.join(directory, "player-metrics.js");
        const { bytes } = await seedArtifact(outputPath);
        await assert.rejects(
          regeneratePlayerMetrics({
            ...dependencies({ generateWeek: scenario[1] }),
            outputPath,
          }),
          /mock generation failure|all 32 canonical teams/,
        );
        assert.deepEqual(await readFile(outputPath), bytes);
      });
    });
  }
});

test("write and rename failures leave the original artifact byte-identical and clean temporary files", async (t) => {
  for (const failure of ["writeFile", "temporary validation", "rename"]) {
    await t.test(failure, async () => {
      await withDirectory(async (directory) => {
        const outputPath = path.join(directory, "player-metrics.js");
        const { bytes } = await seedArtifact(outputPath);
        const failingIo = {
          readFile,
          writeFile: failure === "writeFile"
            ? async () => { throw new Error("mock write failure"); }
            : failure === "temporary validation"
              ? async (filePath, contents, options) => writeFile(
                filePath,
                contents.replace('"predictionWeek": 7', '"predictionWeek": 6'),
                options,
              )
              : writeFile,
          rename: failure === "rename"
            ? async () => { throw new Error("mock rename failure"); }
            : rename,
          unlink,
        };
        await assert.rejects(
          regeneratePlayerMetrics({ ...dependencies({ io: failingIo }), outputPath }),
          failure === "temporary validation"
            ? /Invalid player artifact team identity/
            : new RegExp(`mock ${failure === "writeFile" ? "write" : "rename"} failure`),
        );
        assert.deepEqual(await readFile(outputPath), bytes);
        assert.deepEqual(await readdir(directory), ["player-metrics.js"]);
      });
    });
  }
});

test("successful regeneration leaves no temporary files and never targets the team artifact", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "player-metrics.js");
    await seedArtifact(outputPath);
    await regeneratePlayerMetrics({ ...dependencies(), outputPath });
    assert.deepEqual(await readdir(directory), ["player-metrics.js"]);
  });

  const teamPath = path.resolve("api/nfl/nflverse-team-metrics.js");
  await assert.rejects(
    regeneratePlayerMetrics({ ...dependencies(), outputPath: teamPath }),
    /cannot write the team artifact/,
  );
});

test("Week 7 player builder excludes future rows and games observed after its cutoff", () => {
  const base = (week, gameId, team, opponent, overrides = {}) => parsePlay({
    season: "2026",
    season_type: "REG",
    week: String(week),
    game_id: gameId,
    play_id: `${team}-${gameId}-1`,
    posteam: team,
    defteam: opponent,
    play_type: "pass",
    wp: "0.5",
    pass_attempt: "1",
    complete_pass: "1",
    passer_player_id: "00-0033119",
    passer_player_name: "Quarterback",
    receiver_player_id: "00-0039337",
    receiver_player_name: "Receiver",
    passing_yards: "8",
    receiving_yards: "8",
    ...overrides,
  });
  const schedule = [
    {
      id: "old-final",
      season,
      week: 1,
      season_type: "REG",
      status: "Final",
      date: "2026-09-13T17:00:00Z",
      updated_at: "2026-09-13T21:00:00Z",
      visitor_team: { abbreviation: "NYG" },
      home_team: { abbreviation: "KC" },
    },
    {
      id: "after-cutoff",
      season,
      week: 6,
      season_type: "REG",
      status: "Final",
      date: "2026-10-18T17:00:00Z",
      updated_at: "2026-10-24T00:15:00Z",
      visitor_team: { abbreviation: "NYG" },
      home_team: { abbreviation: "KC" },
    },
  ];
  const generated = buildWeeklyPlayerMetrics([
    base(1, "2026_01_NYG_KC", "NYG", "KC"),
    base(1, "2026_01_NYG_KC", "KC", "NYG"),
    base(6, "2026_06_NYG_KC", "NYG", "KC"),
    base(6, "2026_06_NYG_KC", "KC", "NYG"),
    base(7, "2026_07_NYG_KC", "NYG", "KC"),
    base(7, "2026_07_NYG_KC", "KC", "NYG"),
  ], schedule, { season, predictionWeek: 7, cutoff });

  for (const team of ["NYG", "KC"]) {
    assert.deepEqual(generated[team].gameProvenance.map((game) => game.gameId), ["2026_01_NYG_KC"]);
    assert.deepEqual(Object.values(generated[team].players)[0].weeks, [1]);
  }
});
