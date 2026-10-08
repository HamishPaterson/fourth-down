const MIN_ROLE_OPPORTUNITIES = 3;

export function buildPlayerProjections({
  away,
  home,
  prediction,
  playerMetrics,
  teamMetrics,
}) {
  if (!playerMetrics?.away || !playerMetrics?.home || !prediction) {
    return {
      available: false,
      away: null,
      home: null,
      reasons: ["Player-level nflverse metrics unavailable"],
    };
  }

  return {
    available: true,
    generatedAt: new Date().toISOString(),
    away: projectTeam({
      teamCode: away,
      opponentCode: home,
      side: "away",
      prediction,
      metrics: playerMetrics.away,
      teamMetrics,
    }),
    home: projectTeam({
      teamCode: home,
      opponentCode: away,
      side: "home",
      prediction,
      metrics: playerMetrics.home,
      teamMetrics,
    }),
  };
}

function projectTeam({ teamCode, opponentCode, side, prediction, metrics, teamMetrics }) {
  const teamProjection = prediction?.[side] || {};
  const opponentSide = side === "away" ? "home" : "away";
  const opponentProjection = prediction?.[opponentSide] || {};
  const players = Object.values(metrics?.players || {});
  const totals = metrics?.teamTotals || {};
  const games = Math.max(1, Number(metrics?.games || totals?.games) || 1);

  const expectedPossessions = clamp(
    number(teamProjection.expectedPossessions, 10.8),
    7,
    16
  );
  const expectedPlays = clamp(expectedPossessions * 6.05, 48, 82);
  const historicalPassRate = rate(
    number(totals.passAttempts) + number(totals.sacksAllowed),
    number(totals.passAttempts) + number(totals.sacksAllowed) + number(totals.rushingAttempts),
    0.58
  );
  const scoreEdge = number(teamProjection.score) - number(opponentProjection.score);
  const scriptShift = clamp(-scoreEdge * 0.0025, -0.045, 0.045);
  const passRate = clamp(historicalPassRate + scriptShift, 0.42, 0.72);
  const expectedDropbacks = expectedPlays * passRate;
  const historicalSackRate = rate(
    number(totals.sacksAllowed),
    number(totals.passAttempts) + number(totals.sacksAllowed),
    0.065
  );
  const opponentPressure = getOpponentMetric(
    teamMetrics,
    opponentCode,
    "pressureGeneratedRate",
    historicalSackRate
  );
  const sackRate = clamp(historicalSackRate * 0.65 + opponentPressure * 0.35, 0.025, 0.14);
  const passAttempts = Math.max(1, expectedDropbacks * (1 - sackRate));
  const rushAttempts = Math.max(1, expectedPlays - expectedDropbacks);

  const quarterback = players
    .filter((player) => number(player?.passing?.attempts) > 0)
    .sort((a, b) => number(b.passing.attempts) - number(a.passing.attempts))[0] || null;

  const historicalYpa = quarterback
    ? clamp(number(quarterback?.passing?.yardsPerAttempt, 6.8), 4.5, 10)
    : 6.8;
  const opponentPassAllowed = getOpponentMetric(
    teamMetrics,
    opponentCode,
    "passingEpaAllowedPerPlay",
    0
  );
  const passMatchupMultiplier = clamp(1 + opponentPassAllowed * 0.16, 0.85, 1.18);
  const passingYards = passAttempts * historicalYpa * passMatchupMultiplier;
  const completionRate = quarterback
    ? clamp(number(quarterback?.passing?.completionRate, 0.64), 0.48, 0.78)
    : 0.64;

  const receivingPlayers = players.filter(
    (player) => number(player?.receiving?.targets) >= MIN_ROLE_OPPORTUNITIES
  );
  const rushingPlayers = players.filter(
    (player) => number(player?.rushing?.attempts) >= MIN_ROLE_OPPORTUNITIES
  );

  const passingTouchdowns = Math.max(0, number(teamProjection.passingTD));
  const rushingTouchdowns = Math.max(0, number(teamProjection.rushingTD));

  const receiverRows = allocateReceivers({
    receivingPlayers,
    passAttempts,
    passingYards,
    passingTouchdowns,
    totals,
    games,
  });

  const rusherRows = allocateRushers({
    rushingPlayers,
    rushAttempts,
    rushingTouchdowns,
    totals,
    teamMetrics,
    opponentCode,
    games,
  });

  const combined = mergeCombined(receiverRows, rusherRows);
  const playerIndex = new Map(players.map((player) => [player.playerId, player]));

  const projectedPlayers = [...combined.values()]
    .map((projection) => {
      const source = playerIndex.get(projection.playerId) || {};
      const expectedTouchdowns =
        number(projection.receivingTouchdowns) +
        number(projection.rushingTouchdowns) +
        (source.playerId === quarterback?.playerId ? number(projection.quarterbackRushingTouchdowns) : 0);
      const roleConfidence = calculateRoleConfidence(source, games);

      return {
        ...projection,
        playerNameKey: normalizePlayerName(projection.playerName),
        anytimeTouchdownProbability: round4(1 - Math.exp(-expectedTouchdowns)),
        roleConfidence,
        dataQuality: round4(clamp((Math.min(games, 4) / 4) * 0.55 + roleConfidence * 0.45, 0.25, 0.95)),
      };
    })
    .filter((player) => player.roleConfidence >= 0.35)
    .sort((a, b) => number(b.opportunities) - number(a.opportunities));

  if (quarterback) {
    const qbProjection = {
      playerId: quarterback.playerId,
      playerName: quarterback.playerName,
      playerNameKey: normalizePlayerName(quarterback.playerName),
      team: teamCode,
      position: "QB",
      passingAttempts: round1(passAttempts),
      completions: round1(passAttempts * completionRate),
      passingYards: round1(passingYards),
      passingTouchdowns: round2(passingTouchdowns),
      rushingAttempts: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingAttempts")),
      rushingYards: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingYards")),
      rushingTouchdowns: round2(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingTouchdowns")),
      receptions: 0,
      receivingYards: 0,
      receivingTouchdowns: 0,
      rushingReceivingYards: round1(findProjectedValue(projectedPlayers, quarterback.playerId, "rushingYards")),
      opportunities: round1(passAttempts + findProjectedValue(projectedPlayers, quarterback.playerId, "rushingAttempts")),
      roleConfidence: calculateRoleConfidence(quarterback, games),
    };
    qbProjection.anytimeTouchdownProbability = round4(
      1 - Math.exp(-number(qbProjection.rushingTouchdowns))
    );
    qbProjection.dataQuality = round4(
      clamp((Math.min(games, 4) / 4) * 0.55 + qbProjection.roleConfidence * 0.45, 0.25, 0.95)
    );
    const existingIndex = projectedPlayers.findIndex((player) => player.playerId === quarterback.playerId);
    if (existingIndex >= 0) projectedPlayers[existingIndex] = { ...projectedPlayers[existingIndex], ...qbProjection };
    else projectedPlayers.unshift(qbProjection);
  }

  return {
    team: teamCode,
    opponent: opponentCode,
    gamesUsed: number(metrics?.games || totals?.games),
    expectedPlays: round1(expectedPlays),
    expectedPossessions: round2(expectedPossessions),
    passRate: round4(passRate),
    passAttempts: round1(passAttempts),
    rushAttempts: round1(rushAttempts),
    passingYards: round1(passingYards),
    players: projectedPlayers,
  };
}

function allocateReceivers({ receivingPlayers, passAttempts, passingYards, passingTouchdowns, totals, games }) {
  if (!receivingPlayers.length) return [];
  const weightedShares = receivingPlayers.map((player) => {
    const seasonShare = number(player?.receiving?.targetShare);
    const recentTargets = number(player?.recent?.targetsPerGame);
    const recentShare = recentTargets > 0
      ? recentTargets / Math.max(1, number(totals.targets) / games)
      : seasonShare;
    return clamp(seasonShare * 0.7 + recentShare * 0.3, 0.01, 0.6);
  });
  const shareTotal = weightedShares.reduce((sum, value) => sum + value, 0) || 1;
  const rawYards = receivingPlayers.map((player, index) => {
    const targetShare = weightedShares[index] / shareTotal;
    const targets = passAttempts * targetShare;
    const catchRate = clamp(number(player?.receiving?.catchRate, 0.65), 0.35, 0.9);
    const yardsPerTarget = clamp(number(player?.receiving?.yardsPerTarget, 7), 3.5, 14);
    return { player, targetShare, targets, receptions: targets * catchRate, yards: targets * yardsPerTarget };
  });
  const rawTotal = rawYards.reduce((sum, row) => sum + row.yards, 0) || 1;
  const redZoneWeights = receivingPlayers.map((player, index) => {
    const rz = number(player?.receiving?.redZoneTargetShare);
    const ez = number(player?.receiving?.endZoneTargetShare);
    return Math.max(0.01, rz * 0.65 + ez * 0.35 + weightedShares[index] * 0.25);
  });
  const tdWeightTotal = redZoneWeights.reduce((sum, value) => sum + value, 0) || 1;

  return rawYards.map((row, index) => ({
    playerId: row.player.playerId,
    playerName: row.player.playerName,
    team: row.player.team,
    position: row.player.position,
    targets: round1(row.targets),
    receptions: round1(row.receptions),
    receivingYards: round1(row.yards * (passingYards / rawTotal)),
    receivingTouchdowns: round3(passingTouchdowns * redZoneWeights[index] / tdWeightTotal),
    opportunities: round1(row.targets),
  }));
}

function allocateRushers({ rushingPlayers, rushAttempts, rushingTouchdowns, totals, teamMetrics, opponentCode, games }) {
  if (!rushingPlayers.length) return [];
  const shares = rushingPlayers.map((player) => {
    const seasonShare = number(player?.rushing?.carryShare);
    const recentAttempts = number(player?.recent?.rushingAttemptsPerGame);
    const recentShare = recentAttempts > 0
      ? recentAttempts / Math.max(1, number(totals.rushingAttempts) / games)
      : seasonShare;
    return clamp(seasonShare * 0.7 + recentShare * 0.3, 0.01, 0.8);
  });
  const shareTotal = shares.reduce((sum, value) => sum + value, 0) || 1;
  const opponentRushAllowed = getOpponentMetric(teamMetrics, opponentCode, "rushingEpaAllowedPerPlay", 0);
  const matchupMultiplier = clamp(1 + opponentRushAllowed * 0.18, 0.83, 1.2);
  const goalLineWeights = rushingPlayers.map((player, index) =>
    Math.max(
      0.01,
      number(player?.rushing?.goalLineCarryShare) * 0.65 +
      number(player?.rushing?.redZoneCarryShare) * 0.25 +
      shares[index] * 0.1
    )
  );
  const tdWeightTotal = goalLineWeights.reduce((sum, value) => sum + value, 0) || 1;

  return rushingPlayers.map((player, index) => {
    const share = shares[index] / shareTotal;
    const attempts = rushAttempts * share;
    const ypc = clamp(number(player?.rushing?.yardsPerCarry, 4.1), 2.4, 7.5);
    return {
      playerId: player.playerId,
      playerName: player.playerName,
      team: player.team,
      position: player.position,
      rushingAttempts: round1(attempts),
      rushingYards: round1(attempts * ypc * matchupMultiplier),
      rushingTouchdowns: round3(rushingTouchdowns * goalLineWeights[index] / tdWeightTotal),
      opportunities: round1(attempts),
    };
  });
}

function mergeCombined(receivers, rushers) {
  const map = new Map();
  for (const row of [...receivers, ...rushers]) {
    const existing = map.get(row.playerId) || {
      playerId: row.playerId,
      playerName: row.playerName,
      team: row.team,
      position: row.position,
      targets: 0,
      receptions: 0,
      receivingYards: 0,
      receivingTouchdowns: 0,
      rushingAttempts: 0,
      rushingYards: 0,
      rushingTouchdowns: 0,
      opportunities: 0,
    };
    map.set(row.playerId, {
      ...existing,
      ...row,
      targets: number(existing.targets) + number(row.targets),
      receptions: number(existing.receptions) + number(row.receptions),
      receivingYards: number(existing.receivingYards) + number(row.receivingYards),
      receivingTouchdowns: number(existing.receivingTouchdowns) + number(row.receivingTouchdowns),
      rushingAttempts: number(existing.rushingAttempts) + number(row.rushingAttempts),
      rushingYards: number(existing.rushingYards) + number(row.rushingYards),
      rushingTouchdowns: number(existing.rushingTouchdowns) + number(row.rushingTouchdowns),
      rushingReceivingYards: round1(
        number(existing.receivingYards) + number(row.receivingYards) +
        number(existing.rushingYards) + number(row.rushingYards)
      ),
      opportunities: number(existing.opportunities) + number(row.opportunities),
    });
  }
  return map;
}

function calculateRoleConfidence(player, games) {
  const opportunityShare = Math.max(
    number(player?.combined?.opportunityShare),
    number(player?.rushing?.carryShare),
    number(player?.receiving?.targetShare)
  );
  const volumeConfidence = clamp(opportunityShare / 0.35, 0, 1);
  const sampleConfidence = clamp(games / 4, 0.35, 1);
  return round4(volumeConfidence * 0.7 + sampleConfidence * 0.3);
}

function getOpponentMetric(teamMetrics, opponentCode, field, fallback) {
  const direct = [teamMetrics?.away, teamMetrics?.home]
    .find((entry) => String(entry?.team || "").toUpperCase() === String(opponentCode || "").toUpperCase());
  const payload = teamMetrics?.raw || teamMetrics;
  const teams = payload?.teams || payload?.metrics || payload?.data?.teams || {};
  const value = direct?.[field] ?? teams?.[opponentCode]?.[field];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function findProjectedValue(players, playerId, field) {
  const row = players.find((player) => player.playerId === playerId);
  return number(row?.[field]);
}

function normalizePlayerName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function rate(numerator, denominator, fallback = 0) {
  return denominator ? numerator / denominator : fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round1(value) {
  return Math.round(number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function round3(value) {
  return Math.round(number(value) * 1000) / 1000;
}

function round4(value) {
  return Math.round(number(value) * 10000) / 10000;
}
