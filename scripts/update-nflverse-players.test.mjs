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
import path from "node:path";
import artifact from "../data/nflverse-player-metrics.js";
import {
  buildTeamPlayerMetrics,
  buildWeeklyPlayerMetrics,
  main,
  PLAYER_SOURCE_REQUIRED_FIELDS,
  parsePlay,
  regeneratePlayerMetrics,
  serializePlayerArtifact,
  validatePlayerArtifact,
  validatePlayerSourceRows,
} from "./update-nflverse-players.mjs";

const teams = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH",
];
const season = 2026;
test("one stable PBP identity cannot aggregate conflicting full names", () => {
  const first = parsePlay(sourceRow({ passer_player_name: "Braelon Allen" }));
  const second = parsePlay(sourceRow({ play_id: "2", passer_player_name: "Breece Hall" }));
  assert.throws(() => buildTeamPlayerMetrics([first, second], "NYG"), /Conflicting canonical names/);
});

const cutoff = "2026-10-23T00:15:00.000Z";
const weekEightCutoff = "2026-10-30T00:15:00.000Z";
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
const weekEightSchedule = [
  ...weekSevenSchedule.filter((game) => game.week === 1),
  ...Array.from({ length: 14 }, (_, index) => ({
    id: `week-eight-${index}`,
    season,
    week: 8,
    season_type: "REG",
    status: "Scheduled",
    date: weekEightCutoff,
  })),
];
const sourceRow = (overrides = {}) => ({
  ...Object.fromEntries(PLAYER_SOURCE_REQUIRED_FIELDS.map((field) => [field, ""])),
  ...Object.fromEntries([
    "sack", "qb_scramble", "rush_attempt", "interception", "rush_touchdown",
    "pass_touchdown", "yards_after_catch", "fumble", "fumble_lost",
  ].map((field) => [field, "0"])),
  season: String(season),
  season_type: "REG",
  week: "6",
  game_id: "2026_06_NYG_KC",
  play_id: "1",
  posteam: "NYG",
  defteam: "KC",
  play_type: "pass",
  wp: "0.5",
  pass_attempt: "1",
  complete_pass: "1",
  passer_player_id: "00-0033119",
  passer_player_name: "Quarterback Name",
  receiver_player_id: "",
  receiver_player_name: "",
  passing_yards: "8",
  yardline_100: "50",
  ...overrides,
});
const csv = (rows = [sourceRow()]) => [
  PLAYER_SOURCE_REQUIRED_FIELDS.join(","),
  ...rows.map((row) => PLAYER_SOURCE_REQUIRED_FIELDS.map((field) => row[field] ?? "").join(",")),
].join("\n");

function stableId(team) {
  return `00-${String(teams.indexOf(team) + 1).padStart(7, "0")}`;
}

function teamArtifact(targetWeek = 7, targetCutoff = cutoff) {
  const teamMetrics = Object.fromEntries(teams.map((team) => [team, {
    team,
    predictionWeek: targetWeek,
    cutoff: targetCutoff,
    expectedLineup: {
      schemaVersion: 2,
      schemaValidated: true,
      available: true,
      season,
      predictionWeek: targetWeek,
      cutoff: targetCutoff,
      snapshotAt: "2026-10-19T06:00:00.000Z",
      players: [{
        gsisId: stableId(team),
        name: `Player ${team}`,
        position: "QB",
      }],
    },
  }]));
  for (const metrics of Object.values(teamMetrics)) {
    metrics.expectedLineup.roster = metrics.expectedLineup.players;
  }
  return {
    season,
    metricsByWeek: { [targetWeek]: teamMetrics },
    teamMetricsAuditsByWeek: {
      [targetWeek]: {
        available: true,
        season,
        predictionWeek: targetWeek,
        cutoff: targetCutoff,
        sourceAsOf: "2026-10-19T06:00:00.000Z",
        referenceWeek: targetWeek - 1,
      },
    },
  };
}

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
        [stableId(team)]: {
          playerId: stableId(team),
          gsisId: stableId(team),
          playerName: `${marker} Player ${team}`,
          team,
          position: "QB",
          positionSource: "expectedLineup",
          health: "Unknown",
          healthSource: "Unavailable",
          passing: { attempts: 1 },
          rushing: { attempts: 0 },
          receiving: { targets: 1 },
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

function dependencies({
  generateWeek, io, now, predictionWeek = 7, targetArtifact = teamArtifact(),
  schedule = weekSevenSchedule, rows = [sourceRow()], fetchImpl, scheduleFetcher,
} = {}) {
  return {
    season,
    predictionWeek,
    outputPath: path.join(process.cwd(), "scripts", `.unused-player-artifact-${process.pid}.js`),
    fetchImpl: fetchImpl || (async () => ({
      ok: true,
      arrayBuffer: async () => gzipSync(Buffer.from(csv(rows))),
    })),
    scheduleFetcher: scheduleFetcher || (async () => schedule),
    teamArtifact: targetArtifact,
    now: now || (() => new Date("2026-10-19T06:00:00.000Z")),
    generateWeek: generateWeek || ((_plays, _schedule, options) =>
      generatedWeek(options.predictionWeek, options.cutoff)),
    ...(io ? { io } : {}),
  };
}

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(process.cwd(), "scripts", ".player-updater-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedArtifact(outputPath) {
  const original = historicalArtifact();
  await writeFile(outputPath, serializePlayerArtifact(original));
  return { original, bytes: await readFile(outputPath) };
}

function historicalArtifact() {
  const original = structuredClone(artifact);
  for (const week of Object.keys(original.playerMetricsByWeek)) {
    if (Number(week) <= 7) continue;
    delete original.playerMetricsByWeek[week];
    delete original.cutoffs[week];
    if (original.targetMetadataByWeek) delete original.targetMetadataByWeek[week];
  }
  return original;
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
  for (const failure of ["writeFile", "temporary validation", "temporary metadata", "rename"]) {
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
              : failure === "temporary metadata"
                ? async (filePath, contents, options) => writeFile(
                  filePath,
                  contents.replaceAll(cutoff, "2026-10-24T00:15:00.000Z"),
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
            : failure === "temporary metadata"
              ? /target metadata changed/
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

test("explicit Week 8 builder excludes Week 8/9 and nonfinal/future evidence", () => {
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
      updated_at: "2026-11-01T00:15:00Z",
      visitor_team: { abbreviation: "NYG" },
      home_team: { abbreviation: "KC" },
    },
    {
      id: "week-seven-not-final",
      season,
      week: 7,
      season_type: "REG",
      status: "Scheduled",
      date: "2026-10-23T00:15:00Z",
    },
    {
      id: "week-eight-target",
      season,
      week: 8,
      season_type: "REG",
      status: "Scheduled",
      date: weekEightCutoff,
    },
    {
      id: "week-nine-not-final",
      season,
      week: 9,
      season_type: "REG",
      status: "In Progress",
      date: "2026-11-08T17:00:00Z",
      updated_at: "2026-11-08T17:00:00Z",
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
    base(8, "2026_08_NYG_KC", "NYG", "KC"),
    base(8, "2026_08_NYG_KC", "KC", "NYG"),
    base(9, "2026_09_NYG_KC", "NYG", "KC"),
    base(9, "2026_09_NYG_KC", "KC", "NYG"),
  ], schedule, { season, predictionWeek: 8, cutoff: weekEightCutoff });

  for (const team of ["NYG", "KC"]) {
    assert.deepEqual(generated[team].gameProvenance.map((game) => game.gameId), ["2026_01_NYG_KC"]);
    assert.deepEqual(Object.values(generated[team].players)[0].weeks, [1]);
  }
});

test("explicit Week 8 wins over later source rows and keeps Weeks 2-6 byte-equivalent", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "players.js");
    const { original } = await seedArtifact(outputPath);
    let receivedWeek;
    const result = await regeneratePlayerMetrics({
      ...dependencies({
        predictionWeek: 8,
        targetArtifact: teamArtifact(8, weekEightCutoff),
        schedule: weekEightSchedule,
        now: () => new Date("2026-10-19T07:00:00.000Z"),
        generateWeek: (_plays, _schedule, options) => {
          receivedWeek = options.predictionWeek;
          return generatedWeek(options.predictionWeek, options.cutoff);
        },
      }),
      outputPath,
    });
    assert.equal(receivedWeek, 8);
    assert.equal(result.predictionWeek, 8);
    assert.equal(result.cutoff, weekEightCutoff);
    assert.equal(result.payload.latestCompletedWeek, 7);
    for (const week of [2, 3, 4, 5, 6, 7]) {
      assert.deepEqual(result.payload.playerMetricsByWeek[week], original.playerMetricsByWeek[week]);
    }
    assert.deepEqual(Object.keys(result.payload.playerMetricsByWeek).map(Number), [2, 3, 4, 5, 6, 7, 8]);
  });
});

test("Week 8 default builder is idempotent and future Week 9 identities cannot change current evidence", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "players.js");
    await seedArtifact(outputPath);
    const rows = weekSevenSchedule.filter((game) => game.week === 1).flatMap((game, index) => {
      const away = game.visitor_team.abbreviation;
      const home = game.home_team.abbreviation;
      return [away, home].map((team, side) => sourceRow({
        week: "1",
        game_id: `2026_01_${away}_${home}`,
        play_id: String(index * 2 + side + 1),
        posteam: team,
        defteam: team === away ? home : away,
        pass_attempt: "1",
        complete_pass: "1",
        passer_player_id: stableId(team),
        passer_player_name: `Source ${team}`,
        receiver_player_id: `00-${String(1001 + teams.indexOf(team)).padStart(7, "0")}`,
        receiver_player_name: `Receiver ${team}`,
        passing_yards: "8",
        receiving_yards: "8",
        air_yards: "6",
        yardline_100: "50",
      }));
    });
    const targetArtifact = teamArtifact(8, weekEightCutoff);
    for (const [team, metrics] of Object.entries(targetArtifact.metricsByWeek[8])) {
      metrics.expectedLineup.roster = [...metrics.expectedLineup.players, {
        gsisId: `00-${String(1001 + teams.indexOf(team)).padStart(7, "0")}`,
        name: `Receiver ${team}`, position: "WR",
      }];
    }
    const futureRows = [
      sourceRow({
        week: "9", game_id: "2026_09_ARI_ATL", posteam: "ATL", defteam: "ARI",
        passer_player_id: "00-0001001", passer_player_name: "Receiver ARI",
      }),
      sourceRow({
        season: "2025", week: "1", game_id: "2025_01_ARI_ATL", posteam: "ATL", defteam: "ARI",
        passer_player_id: "00-0001001", passer_player_name: "Receiver ARI",
      }),
      sourceRow({
        week: "7", game_id: "2026_07_ARI_ATL", posteam: "ATL", defteam: "ARI",
        passer_player_id: "00-0001001", passer_player_name: "Receiver ARI",
      }),
      sourceRow({
        week: "6", game_id: "2026_06_ARI_ATL", posteam: "ATL", defteam: "ARI",
        passer_player_id: "00-0001001", passer_player_name: "Receiver ARI",
      }),
    ];
    const options = {
      ...dependencies({
        rows: [...rows, ...futureRows],
        predictionWeek: 8,
        targetArtifact,
        now: () => new Date("2026-10-27T06:00:00.000Z"),
        schedule: [
          ...weekEightSchedule,
          {
            ...weekEightSchedule[0], week: 9, status: "Final",
            updated_at: "2026-11-09T06:00:00.000Z",
          },
          {
            ...weekEightSchedule[0], week: 7, status: "In Progress",
          },
          {
            ...weekEightSchedule[0], week: 6, status: "Final",
            updated_at: "2026-10-28T06:00:00.000Z",
          },
        ],
        generateWeek: buildWeeklyPlayerMetrics,
      }),
      outputPath,
    };
    const result = await regeneratePlayerMetrics(options);
    assert.equal(result.playerCount, 64);
    for (const team of teams) {
      const players = Object.values(result.payload.playerMetricsByWeek[8][team].players);
      assert.equal(players.length, 2);
      const quarterback = players.find((player) => player.position === "QB");
      const receiver = players.find((player) => player.playerName === `Receiver ${team}`);
      assert.equal(quarterback.gsisId, stableId(team));
      assert.equal(quarterback.playerName, `Player ${team}`);
      assert.equal(quarterback.positionSource, "expectedLineup");
      assert.equal(receiver.positionSource, "expectedRoster");
    }
    const first = await readFile(outputPath);
    await regeneratePlayerMetrics(options);
    assert.deepEqual(await readFile(outputPath), first);
    options.fetchImpl = dependencies({ rows }).fetchImpl;
    await regeneratePlayerMetrics(options);
    assert.deepEqual(await readFile(outputPath), first);
  });
});

test("fixed-clock identical reruns are byte deterministic and preserve explicit unknown health", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "players.js");
    await seedArtifact(outputPath);
    const options = {
      ...dependencies({ generateWeek: (_plays, _schedule, context) =>
        generatedWeek(context.predictionWeek, context.cutoff, "Stable") }),
      outputPath,
    };
    await regeneratePlayerMetrics(options);
    const first = await readFile(outputPath);
    await regeneratePlayerMetrics(options);
    const second = await readFile(outputPath);
    assert.deepEqual(second, first);
    const target = JSON.parse(second.toString().slice(
      "const NFLVERSE_PLAYER_METRICS = ".length,
      -";\n\nexport default NFLVERSE_PLAYER_METRICS;\n".length,
    ));
    const player = Object.values(target.playerMetricsByWeek[7].ARI.players)[0];
    assert.equal(player.health, "Unknown");
    assert.equal(player.healthSource, "Unavailable");
  });
});

test("missing/invalid explicit arguments, target metadata and future source time fail before fetch", async (t) => {
  const cases = [
    ["missing week", { predictionWeek: undefined }, /explicitly provided/],
    ["invalid week", { predictionWeek: 19 }, /from 2 through 18/],
    ["bad reference week", {
      targetArtifact: (() => {
        const target = structuredClone(teamArtifact());
        target.teamMetricsAuditsByWeek[7].referenceWeek = 5;
        return target;
      })(),
    }, /cutoff\/referenceWeek evidence/],
    ["bad target cutoff", {
      targetArtifact: (() => {
        const target = structuredClone(teamArtifact());
        target.metricsByWeek[7].ARI.expectedLineup.cutoff = "2026-10-24T00:15:00.000Z";
        return target;
      })(),
    }, /lineup\/cutoff/],
    ["future lineup snapshot", {
      targetArtifact: (() => {
        const target = structuredClone(teamArtifact());
        target.metricsByWeek[7].ARI.expectedLineup.snapshotAt = "2026-10-24T00:15:00.001Z";
        return target;
      })(),
    }, /lineup\/cutoff/],
    ["future source timestamp", { now: () => new Date("2026-10-24T00:15:00.001Z") }, /later than the target cutoff/],
  ];
  for (const [name, options, expected] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      const callOptions = dependencies({
        ...options,
        fetchImpl: async () => { fetchCount += 1; throw new Error("unexpected fetch"); },
      });
      if (name === "missing week") delete callOptions.predictionWeek;
      await assert.rejects(regeneratePlayerMetrics({
        ...callOptions,
        outputPath: path.join(process.cwd(), "scripts", `.unused-preflight-${process.pid}.js`),
      }), expected);
      assert.equal(fetchCount, 0);
    });
  }
  await assert.rejects(main([]), /Usage:/);
  await assert.rejects(main(["2026", "19"]), /Prediction week/);
});

test("required PBP schema and malformed rows fail without scheduling or publication", async (t) => {
  for (const scenario of ["missing column", "malformed row"]) {
    await t.test(scenario, async () => {
      await withDirectory(async (directory) => {
        const outputPath = path.join(directory, "players.js");
        const { bytes } = await seedArtifact(outputPath);
        let scheduleCount = 0;
        let sourceText = csv();
        if (scenario === "missing column") {
          const field = "qb_scramble";
          const headers = PLAYER_SOURCE_REQUIRED_FIELDS.filter((column) => column !== field);
          const row = sourceRow();
          sourceText = [headers.join(","), headers.map((column) => row[column]).join(",")].join("\n");
        } else {
          sourceText = `${PLAYER_SOURCE_REQUIRED_FIELDS.join(",")}\n1,2`;
        }
        await assert.rejects(regeneratePlayerMetrics({
          ...dependencies({
            fetchImpl: async () => ({
              ok: true,
              arrayBuffer: async () => gzipSync(Buffer.from(sourceText)),
            }),
            scheduleFetcher: async () => { scheduleCount += 1; return weekSevenSchedule; },
          }),
          outputPath,
        }), scenario === "missing column" ? /missing required column qb_scramble/ : /Malformed player source CSV row/);
        assert.equal(scheduleCount, 0);
        assert.deepEqual(await readFile(outputPath), bytes);
      });
    });
  }
});

function validStrictArtifact(targetTeams = generatedWeek(7, cutoff)) {
  const fixedSourceAsOf = "2026-10-19T07:00:00.000Z";
  return {
    ...historicalArtifact(),
    sourceAsOf: fixedSourceAsOf,
    generatedAt: fixedSourceAsOf,
    requiredFields: [...PLAYER_SOURCE_REQUIRED_FIELDS],
    cutoffs: { ...historicalArtifact().cutoffs, 7: cutoff },
    targetMetadataByWeek: {
      7: {
        season,
        predictionWeek: 7,
        cutoff,
        referenceWeek: 6,
        sourceAsOf: fixedSourceAsOf,
        sourceColumns: [...PLAYER_SOURCE_REQUIRED_FIELDS],
      },
    },
    playerMetricsByWeek: { ...historicalArtifact().playerMetricsByWeek, 7: targetTeams },
  };
}

test("strict target validation rejects duplicate, incomplete, mismatched and malformed identities only on target", async (t) => {
  const cases = [
    ["duplicate stable ID", (candidate) => {
      const player = structuredClone(candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")]);
      candidate.playerMetricsByWeek[7].ARI.players["duplicate-key"] = player;
    }, /identity/],
    ["name-only target row", (candidate) => {
      const player = candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")];
      player.gsisId = null;
    }, /identity/],
    ["duplicate canonical name", (candidate) => {
      const player = structuredClone(candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")]);
      player.playerId = "00-0099001";
      player.gsisId = "00-0099001";
      candidate.playerMetricsByWeek[7].ARI.players[player.playerId] = player;
    }, /identity/],
    ["wrong team", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")].team = "NE";
    }, /identity|provenance/],
    ["wrong target week", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.predictionWeek = 6;
    }, /team identity/],
    ["wrong target cutoff", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.cutoff = "2026-10-24T00:15:00.000Z";
    }, /team identity/],
    ["wrong metric season", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.season = 2025;
    }, /season mismatch/],
    ["metadata cutoff differs from artifact cutoff", (candidate) => {
      candidate.targetMetadataByWeek[7].cutoff = "2026-10-24T00:15:00.000Z";
    }, /target metadata/],
    ["invalid metadata reference week", (candidate) => {
      candidate.targetMetadataByWeek[7].referenceWeek = 5;
    }, /target metadata/],
    ["invalid source columns", (candidate) => {
      candidate.targetMetadataByWeek[7].sourceColumns.pop();
    }, /target metadata/],
    ["source timestamp beyond cutoff", (candidate) => {
      candidate.targetMetadataByWeek[7].sourceAsOf = "2026-10-24T00:15:00.001Z";
      candidate.sourceAsOf = candidate.targetMetadataByWeek[7].sourceAsOf;
      candidate.generatedAt = candidate.targetMetadataByWeek[7].sourceAsOf;
    }, /target metadata/],
    ["wrong artifact season", (candidate) => {
      candidate.season = 2025;
    }, /season mismatch/],
    ["empty target team", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.players = {};
    }, /no canonical players/],
    ["nonfinite metric", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")].passing.yards = Infinity;
    }, /Nonfinite/],
    ["malformed game log", (candidate) => {
      candidate.playerMetricsByWeek[7].ARI.players[stableId("ARI")].gameLog = [{}];
    }, /game log|game provenance/i],
    ["duplicate ID across teams", (candidate) => {
      const nePlayers = candidate.playerMetricsByWeek[7].NE.players;
      const player = nePlayers[stableId("NE")];
      delete nePlayers[stableId("NE")];
      player.playerId = stableId("ARI");
      player.gsisId = stableId("ARI");
      nePlayers[stableId("ARI")] = player;
    }, /identity/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const candidate = validStrictArtifact();
      mutate(candidate);
      assert.throws(() => validatePlayerArtifact(candidate, { season, targetWeek: 7 }), expected);
    });
  }
  const inferred = validStrictArtifact();
  const player = inferred.playerMetricsByWeek[7].ARI.players[stableId("ARI")];
  player.position = "RB";
  player.positionSource = "inferred";
  assert.equal(validatePlayerArtifact(inferred, { season, targetWeek: 7 }), true);
  assert.equal(validatePlayerArtifact(structuredClone(artifact), { season }), true);
});

test("no-ID names map only by exact unique authoritative name; initials and old-team usage are excluded", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "players.js");
    await seedArtifact(outputPath);
    const target = teamArtifact();
    target.metricsByWeek[7].NYJ.expectedLineup.players = [
      { gsisId: "00-0099001", name: "Braelon Allen", position: "RB" },
      { gsisId: "00-0099002", name: "Breece Hall", position: "RB" },
    ];
    target.metricsByWeek[7].NYJ.expectedLineup.roster = target.metricsByWeek[7].NYJ.expectedLineup.players;
    const rows = [
      sourceRow({
        play_id: "11", posteam: "NYJ", defteam: "NE", pass_attempt: "0", rush_attempt: "1",
        rusher_player_name: "Braelon Allen", rushing_yards: "4",
      }),
      sourceRow({
        play_id: "12", posteam: "NYJ", defteam: "NE", pass_attempt: "0", rush_attempt: "1",
        rusher_player_name: "Breece Hall", rushing_yards: "5",
      }),
      sourceRow({
        play_id: "13", posteam: "NYJ", defteam: "NE", pass_attempt: "0", rush_attempt: "1",
        rusher_player_name: "B.Allen", rushing_yards: "6",
      }),
      sourceRow({
        play_id: "14", posteam: "NYJ", defteam: "NE", pass_attempt: "0", rush_attempt: "1",
        rusher_player_name: "B.Allen Jr.", rushing_yards: "7",
      }),
      sourceRow({
        play_id: "15", posteam: "NE", defteam: "NYJ", pass_attempt: "0", rush_attempt: "1",
        rusher_player_id: "00-0099001", rusher_player_name: "Braelon Allen", rushing_yards: "8",
      }),
      sourceRow({
        play_id: "16", posteam: "NYJ", defteam: "NE", pass_attempt: "0", rush_attempt: "1",
        rusher_player_id: "00-0088888", rusher_player_name: "Unknown Player", rushing_yards: "9",
      }),
      sourceRow({
        play_id: "17", posteam: "NE", defteam: "NYJ", pass_attempt: "0", rush_attempt: "1",
        rusher_player_id: "00-0088888", rusher_player_name: "Unknown Player", rushing_yards: "10",
      }),
    ];
    let identified;
    await regeneratePlayerMetrics({
      ...dependencies({
        targetArtifact: target,
        rows,
        schedule: [
          ...weekSevenSchedule,
          {
            ...weekSevenSchedule[0], week: 6,
            visitor_team: { abbreviation: "NYJ" },
            home_team: { abbreviation: "NE" },
          },
        ],
        generateWeek: (plays, _schedule, options) => {
          identified = plays;
          return generatedWeek(options.predictionWeek, options.cutoff);
        },
      }),
      outputPath,
    });
    const byPlay = new Map(identified.map((play) => [play.playId, play]));
    assert.equal(byPlay.get("11").rusherId, "00-0099001");
    assert.equal(byPlay.get("11").rusherName, "Braelon Allen");
    assert.equal(byPlay.get("12").rusherId, "00-0099002");
    assert.equal(byPlay.get("12").rusherName, "Breece Hall");
    assert.equal(byPlay.get("13").rusherId, null);
    assert.equal(byPlay.get("14").rusherId, null);
    assert.equal(byPlay.get("15").rusherId, null);
    assert.equal(byPlay.get("16").rusherId, null);
    assert.equal(byPlay.get("17").rusherId, null);
    assert.notEqual(byPlay.get("11").rusherId, byPlay.get("12").rusherId);
  });
});

test("every PBP column consumed by parsePlay is inventoried and required", async (t) => {
  const source = await readFile(new URL("./update-nflverse-players.mjs", import.meta.url), "utf8");
  const parser = source.slice(source.indexOf("export function parsePlay("), source.indexOf("function isEligible("));
  const consumed = [...new Set([...parser.matchAll(/\brow\.([a-z_0-9]+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...PLAYER_SOURCE_REQUIRED_FIELDS].sort(), consumed);
  const row = sourceRow();
  validatePlayerSourceRows([row]);
  for (const field of consumed) {
    await t.test(`missing ${field}`, () => {
      const missing = { ...row };
      delete missing[field];
      assert.throws(() => validatePlayerSourceRows([missing]), new RegExp(`missing required column ${field}`));
    });
  }
  const numeric = [...new Set([...parser.matchAll(/\bnumber\(\s*row\.([a-z_0-9]+)\s*\)/g)]
    .map((match) => match[1]))];
  for (const field of numeric) {
    await t.test(`malformed numeric ${field}`, () => {
      assert.throws(() => validatePlayerSourceRows([{ ...row, [field]: "not-a-number" }]), /invalid/);
      assert.throws(() => validatePlayerSourceRows([{ ...row, [field]: "Infinity" }]), /invalid/);
    });
  }
  const completedTarget = sourceRow({
    receiver_player_name: "Receiver Name", receiver_player_id: "00-0099009",
    receiving_yards: "8", yardline_100: "50", air_yards: "6",
  });
  validatePlayerSourceRows([completedTarget]);
  for (const field of ["yards_after_catch", "receiving_yards", "passing_yards", "air_yards", "yardline_100"]) {
    await t.test(`blank relevant ${field}`, () => {
      assert.throws(() => validatePlayerSourceRows([{ ...completedTarget, [field]: "" }]), /missing relevant numeric/);
    });
  }
  validatePlayerSourceRows([sourceRow({
    complete_pass: "0", passing_yards: "", receiving_yards: "", yards_after_catch: "",
  })]);
});

test("contradictory authoritative GSIS names and cross-team membership fail before fetch", async (t) => {
  for (const scenario of ["names", "teams"]) {
    await t.test(scenario, async () => {
      const target = teamArtifact();
      const original = target.metricsByWeek[7].ARI.expectedLineup.players[0];
      if (scenario === "names") {
        target.metricsByWeek[7].ARI.expectedLineup.players.push({
          ...original, name: "Contradictory Name",
        });
      } else {
        target.metricsByWeek[7].ATL.expectedLineup.players.push({ ...original });
      }
      let fetchCount = 0;
      await assert.rejects(regeneratePlayerMetrics(dependencies({
        targetArtifact: target,
        fetchImpl: async () => { fetchCount += 1; throw new Error("unexpected fetch"); },
      })), /Contradictory authoritative/);
      assert.equal(fetchCount, 0);
    });
  }
});

test("lineup snapshot after observation time fails even when before target cutoff", async () => {
  const target = teamArtifact();
  target.metricsByWeek[7].ARI.expectedLineup.snapshotAt = "2026-10-19T07:00:00.000Z";
  await assert.rejects(regeneratePlayerMetrics(dependencies({
    targetArtifact: target,
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
  })), /snapshot.*later than sourceAsOf/);
});

test("post-fetch clock is sourceAsOf and cannot cross the target cutoff", async () => {
  await withDirectory(async (directory) => {
    const outputPath = path.join(directory, "players.js");
    const { bytes } = await seedArtifact(outputPath);
    let reads = 0;
    let observedPlays;
    const observed = await regeneratePlayerMetrics({
      ...dependencies({
        now: () => new Date(reads++ ? "2026-10-19T07:00:00.000Z" : "2026-10-19T06:00:00.000Z"),
        schedule: [
          ...weekSevenSchedule,
          {
            ...weekSevenSchedule[0], week: 6,
            updated_at: "2026-10-19T06:30:00.000Z",
            visitor_team: { abbreviation: "NYG" },
            home_team: { abbreviation: "KC" },
          },
        ],
        generateWeek: (plays, _schedule, options) => {
          observedPlays = plays;
          return generatedWeek(options.predictionWeek, options.cutoff);
        },
      }),
      outputPath,
    });
    assert.equal(observed.payload.sourceAsOf, "2026-10-19T07:00:00.000Z");
    assert.equal(observedPlays.length, 1);
    await writeFile(outputPath, bytes);
    reads = 0;
    await assert.rejects(regeneratePlayerMetrics({
      ...dependencies({
        now: () => new Date(reads++ ? "2026-10-24T00:15:00.001Z" : "2026-10-19T06:00:00.000Z"),
      }),
      outputPath,
    }), /later than the target cutoff/);
    assert.deepEqual(await readFile(outputPath), bytes);
  });
});
