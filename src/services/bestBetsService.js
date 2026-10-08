import { resolveFullPlayerName } from "./playerRatings.js";
const MIN_GAME_EDGE = 0.045;
const MIN_GAME_EV = 0.03;
const MIN_PROP_EDGE = 0.045;
const MIN_PROP_EV = 0.03;

export function buildBestBets({ game, prediction, playerProjections, oddsEvent, dataQuality }) {
  const markets = flattenMarkets(oddsEvent);
  const coreDataReady = ["playByPlay", "teamForm", "personnel"]
    .every((key) => dataQuality?.[key] !== false);
  const marketDiagnostics = {
    bookmakerCount: Array.isArray(oddsEvent?.bookmakers) ? oddsEvent.bookmakers.length : 0,
    marketCount: markets.length,
  };
  const gameBets = buildGameBets(game, prediction, markets, dataQuality);
  const consensusPlayerMarkets = selectConsensusPlayerMarkets(markets);
  const playerBets = buildPlayerBets(playerProjections, consensusPlayerMarkets);
  const assessed = gameBets.assessed + playerBets.assessed;
  const allCandidates = dedupeBetCandidates([
    ...gameBets.recommendations,
    ...playerBets.recommendations,
  ]);

  const qualifiedGameBets = allCandidates
    .filter(() => coreDataReady)
    .filter((bet) => bet.category === "Game")
    .filter((bet) => bet.edge >= MIN_GAME_EDGE && bet.expectedValue >= MIN_GAME_EV);

  const qualifiedPlayerBets = selectUniquePlayerProps(
    allCandidates.filter((bet) => bet.category !== "Game")
  )
    .filter((bet) => coreDataReady && bet.edge >= MIN_PROP_EDGE && bet.expectedValue >= MIN_PROP_EV)
    .sort((a, b) => b.score - a.score);

  const selectedPlayerBets = selectDiversePlayerProps(qualifiedPlayerBets, 6);
  const selectedGameBets = selectDiverseGameBets(qualifiedGameBets, 1);

  // Player markets are deliberately placed first. Game markets are capped at
  // one recommendation, preventing moneyline, spread and total from
  // dominating the matchup while player props are available.
  const recommendations = [
    ...selectedPlayerBets,
    ...selectedGameBets,
  ]
    .slice(0, 8)
    .map((bet, index) => ({ ...bet, rank: index + 1 }));
  const highlights = selectHighlights(recommendations, allCandidates);
  const anytimeTdScorer = selectAnytimeTdScorer({
    playerProjections,
    markets,
    playerBetCandidates: playerBets.recommendations,
  });

  return {
    available: markets.length > 0,
    assessed,
    marketDiagnostics: {
      ...marketDiagnostics,
      rawPlayerMarkets: markets.filter((market) => isPlayerMarket(market.marketKey)).length,
      consensusPlayerMarkets: consensusPlayerMarkets.length,
      playerMarkets: playerBets.playerMarkets,
      matchedPlayerMarkets: playerBets.matchedPlayerMarkets,
      projectedPlayers: playerBets.projectedPlayers,
      qualifiedPlayerProps: qualifiedPlayerBets.length,
      displayedPlayerProps: selectedPlayerBets.length,
      qualifiedGameMarkets: qualifiedGameBets.length,
      displayedGameMarkets: selectedGameBets.length,
    },
    highlights,
    anytimeTdScorer,
    qualified: recommendations.length,
    rejected: Math.max(0, assessed - recommendations.length),
    generatedAt: new Date().toISOString(),
    recommendations,
    message: recommendations.length
      ? null
      : coreDataReady
        ? "No Best Bets meet the model threshold for this matchup."
        : "Best Bets withheld because core prediction data are incomplete.",
  };
}

function buildGameBets(game, prediction, markets, dataQuality) {
  const result = [];
  let assessed = 0;
  const away = normalizeTeam(game?.away || prediction?.away?.code);
  const home = normalizeTeam(game?.home || prediction?.home?.code);
  const modelAway = number(prediction?.awayWinProbability, 0.5);
  const modelHome = number(prediction?.homeWinProbability, 0.5);
  const modelMarginHome = number(prediction?.home?.expectedPoints, prediction?.home?.score) -
    number(prediction?.away?.expectedPoints, prediction?.away?.score);
  const modelTotal = number(prediction?.home?.expectedPoints, prediction?.home?.score) +
    number(prediction?.away?.expectedPoints, prediction?.away?.score);
  const quality = overallQuality(dataQuality, prediction);

  const h2h = markets.filter((row) => row.marketKey === "h2h");
  const awayMoney = bestOutcome(h2h, (row) => teamMatches(row.name, away));
  const homeMoney = bestOutcome(h2h, (row) => teamMatches(row.name, home));
  if (awayMoney && homeMoney) {
    assessed += 2;
    const noVig = noVigPair(awayMoney.price, homeMoney.price);
    result.push(gameBet("Moneyline", away, awayMoney, modelAway, noVig.first, quality,
      explainMoneyline(away, modelAway, noVig.first, prediction, "away")));
    result.push(gameBet("Moneyline", home, homeMoney, modelHome, noVig.second, quality,
      explainMoneyline(home, modelHome, noVig.second, prediction, "home")));
  }

  const spreads = markets.filter((row) => row.marketKey === "spreads");
  for (const [team, opponent, modelMargin] of [[away, home, -modelMarginHome], [home, away, modelMarginHome]]) {
    const row = bestOutcome(spreads, (item) => teamMatches(item.name, team));
    if (!row || !Number.isFinite(row.point)) continue;
    assessed += 1;
    const coverMargin = modelMargin + row.point;
    const probability = logisticProbability(coverMargin, 6.5);
    const marketProbability = impliedProbability(row.price);
    result.push(gameBet("Spread", `${team} ${formatLine(row.point)}`, row, probability, marketProbability, quality,
      explainSpread(team, opponent, modelMargin, row.point, coverMargin, prediction)));
  }

  const totals = markets.filter((row) => row.marketKey === "totals");
  for (const side of ["Over", "Under"]) {
    const row = bestOutcome(totals, (item) => normalize(item.name) === side.toLowerCase());
    if (!row || !Number.isFinite(row.point)) continue;
    assessed += 1;
    const difference = side === "Over" ? modelTotal - row.point : row.point - modelTotal;
    const probability = logisticProbability(difference, 8.5);
    const marketProbability = impliedProbability(row.price);
    result.push(gameBet("Game total", `${side} ${row.point}`, row, probability, marketProbability, quality,
      explainTotal(side, modelTotal, row.point, prediction)));
  }

  return { assessed, recommendations: result.filter(Boolean) };
}

function selectAnytimeTdScorer({ playerProjections, markets, playerBetCandidates }) {
  const players = collectProjectedPlayers(playerProjections)
    .map((player) => ({
      player,
      playerName: resolvePlayerDisplayName(player),
      probability: findMetric(player, "anytimeTouchdownProbability"),
      roleConfidence: normaliseConfidence(
        player.roleConfidence ?? player.confidence ?? player.role?.confidence
      ),
      dataQuality: normaliseConfidence(
        player.dataQuality ?? player.quality ?? player.dataQualityScore
      ),
    }))
    .filter((row) => row.playerName && Number.isFinite(row.probability))
    .sort((a, b) =>
      b.probability * b.roleConfidence * b.dataQuality -
      a.probability * a.roleConfidence * a.dataQuality
    );

  const pricedCandidates = (playerBetCandidates || [])
    .filter((bet) => bet.market === "Anytime touchdown")
    .sort((a, b) => b.score - a.score);

  const topPlayer = players[0] || null;
  const directPricedMarket = topPlayer
    ? markets
        .filter((market) => market.marketKey === "player_anytime_td")
        .filter((market) => namesMatch(topPlayer.playerName, market.playerName))
        .filter((market) => Number.isFinite(Number(market.price)))
        .sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))[0] || null
    : null;
  let bestPriced = pricedCandidates.find((bet) =>
    topPlayer ? namesMatch(normalisePlayerFromSelection(bet.selection), topPlayer.playerName) : true
  ) || pricedCandidates[0] || null;
  if (!bestPriced && topPlayer && directPricedMarket) {
    bestPriced = buildBet({
      category: "Anytime touchdowns", market: "Anytime touchdown",
      rawMarketType: directPricedMarket.rawMarketType,
      period: directPricedMarket.period || "full_game",
      selection: `${topPlayer.playerName} anytime TD`, line: null,
      price: directPricedMarket.price, sportsbook: directPricedMarket.sportsbook,
      modelProjection: topPlayer.probability,
      modelProbability: clamp(topPlayer.probability, 0.02, 0.95),
      marketProbability: impliedProbability(directPricedMarket.price),
      dataQuality: topPlayer.dataQuality, roleConfidence: topPlayer.roleConfidence,
      reason: `Fourth Down gives ${topPlayer.playerName} a ${percent(topPlayer.probability)} chance to score a touchdown.`,
      risk: playerRisk(topPlayer.player, "player_anytime_td", topPlayer.roleConfidence),
      updatedAt: directPricedMarket.updatedAt,
    });
  }

  if (bestPriced) {
    return {
      ...bestPriced,
      source: "priced-market",
      title: "Anytime TD scorer",
      confidenceLevel: bestPriced.confidenceLevel || confidenceLabel(bestPriced.confidenceScore || 0),
      explanation:
        `${bestPriced.selection.replace(/ anytime TD$/i, "")} is Fourth Down's top touchdown scorer for this game. ` +
        `The model gives the player a ${percent(bestPriced.modelProbability)} chance at ${formatDecimalOdds(bestPriced.decimalOdds)}.`,
    };
  }

  if (!topPlayer) {
    return {
      source: "unavailable",
      title: "Anytime TD scorer",
      selection: "No eligible scorer projection",
      modelProbability: 0,
      decimalOdds: null,
      confidenceLevel: "Cautious",
      explanation: "Player touchdown projections were not available for this matchup.",
      risk: "No player-level touchdown projection was available.",
    };
  }

  const confidenceScore = clamp(
    topPlayer.probability * 0.45 +
      topPlayer.roleConfidence * 0.3 +
      topPlayer.dataQuality * 0.25,
    0,
    1
  );

  return {
    source: "model-only",
    title: "Anytime TD scorer",
    selection: `${topPlayer.playerName} anytime TD`,
    modelProbability: round4(topPlayer.probability),
    decimalOdds: null,
    confidenceScore: round4(confidenceScore),
    confidenceLevel: confidenceLabel(confidenceScore),
    dataQuality: topPlayer.dataQuality,
    roleConfidence: topPlayer.roleConfidence,
    explanation:
      `${topPlayer.playerName} has the highest projected touchdown probability in this game at ${percent(topPlayer.probability)}. ` +
      `No bookmaker anytime-touchdown price matched this player, so this is a model pick rather than a priced value bet.`,
    qualificationReason:
      `Selected because this is the highest touchdown probability among the projected players for this matchup.`,
    risk: "No matched bookmaker price is available, so expected value cannot be calculated.",
  };
}

function formatDecimalOdds(value) {
  const odds = Number(value);
  return Number.isFinite(odds) ? `$${odds.toFixed(2)}` : "price unavailable";
}

function isFullGamePropMarket(market) {
  const text = [market?.rawMarketType, market?.period]
    .filter(Boolean).join("_").toLowerCase().replace(/[\s-]+/g, "_");
  return ![
    "1st_half", "first_half", "firsthalf", "1h_", "_1h",
    "2nd_half", "second_half", "secondhalf", "2h_", "_2h",
    "1st_quarter", "first_quarter", "q1", "quarter_1",
    "2nd_quarter", "second_quarter", "q2", "quarter_2",
    "3rd_quarter", "third_quarter", "q3", "quarter_3",
    "4th_quarter", "fourth_quarter", "q4", "quarter_4",
    "alternate", "alt_line", "alternative",
  ].some((marker) => text.includes(marker));
}

function selectConsensusPlayerMarkets(markets) {
  const playerMarkets = markets.filter(
    (market) => isPlayerMarket(market.marketKey) && isFullGamePropMarket(market)
  );
  const groups = new Map();

  for (const market of playerMarkets) {
    const playerName = canonicalPlayerName(market.playerName);
    if (!playerName) continue;
    const groupKey = [normalize(playerName), market.marketKey].join(":");
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ ...market, playerName });
  }

  const selected = [];
  for (const rows of groups.values()) {
    const key = rows[0]?.marketKey;
    if (key === "player_anytime_td") {
      // Keep the best real price per scorer.
      const best = [...rows].sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))[0];
      if (best) selected.push(best);
      continue;
    }

    const lineGroups = new Map();
    for (const row of rows) {
      if (!Number.isFinite(Number(row.point))) continue;
      const lineKey = Number(row.point).toFixed(2);
      if (!lineGroups.has(lineKey)) lineGroups.set(lineKey, []);
      lineGroups.get(lineKey).push(row);
    }

    const rankedLines = [...lineGroups.values()].sort((a, b) => {
      const bookDifference = distinctBooks(b) - distinctBooks(a);
      if (bookDifference) return bookDifference;
      const pairedDifference = hasBothSides(b) - hasBothSides(a);
      if (pairedDifference) return pairedDifference;
      return b.length - a.length;
    });

    const mainLineRows = rankedLines[0] || [];
    for (const side of ["over", "under"]) {
      const sideRows = mainLineRows.filter((row) => normaliseSide(row.name) === side);
      const best = sideRows.sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))[0];
      if (best) selected.push(best);
    }
  }

  return selected;
}

function distinctBooks(rows) {
  return new Set(rows.map((row) => row.sportsbook).filter(Boolean)).size;
}
function hasBothSides(rows) {
  const sides = new Set(rows.map((row) => normaliseSide(row.name)));
  return sides.has("over") && sides.has("under") ? 1 : 0;
}

function canonicalPlayerName(value) {
  const text = String(value || "").trim();
  const key = normalize(text);
  const legacyAliases = {
    dboston: "Denzel Boston",
    hfannin: "Harold Fannin Jr.",
    qjudkins: "Quinshon Judkins",
    dwatson: "Deshaun Watson",
    kconcepcion: "KC Concepcion",
    jallen: "Josh Allen",
  };
  return legacyAliases[key] || text;
}

function resolvePlayerDisplayName(player, providerName) {
  const team = player?.team || player?.teamAbbreviation || player?.team_code;
  const candidates = [
    player?.fullName,
    player?.full_name,
    player?.displayName,
    player?.display_name,
    player?.name,
    player?.playerName,
    player?.player_name,
    providerName,
  ]
    .map((value) => canonicalPlayerName(value))
    .filter(Boolean);

  const full = candidates.find(isFullPlayerName);
  if (full) return resolveFullPlayerName(full, team);

  for (const candidate of candidates) {
    const resolved = resolveFullPlayerName(candidate, team);
    if (resolved && isFullPlayerName(resolved)) return resolved;
  }

  return candidates.sort((a, b) => b.length - a.length)[0] || "Unknown player";
}

function isFullPlayerName(value) {
  const tokens = String(value || "")
    .replace(/\b(Jr|Sr|II|III|IV)\.?$/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens[0].replace(/[^A-Za-z]/g, "").length > 1;
}

function buildPlayerBets(playerProjections, markets) {
  const result = [];
  let assessed = 0;
  let matchedPlayerMarkets = 0;
  const players = collectProjectedPlayers(playerProjections);
  const playerMarkets = markets.filter((market) => isPlayerMarket(market.marketKey)).length;
  const fields = {
    player_pass_yds: ["passingYards", 42, "Passing yards", "passing yards"],
    player_pass_tds: ["passingTouchdowns", 0.85, "Passing touchdowns", "passing touchdowns"],
    player_pass_attempts: ["passingAttempts", 6.5, "Passing attempts", "passing attempts"],
    player_completions: ["completions", 5.5, "Completions", "completions"],
    player_rush_yds: ["rushingYards", 18, "Rushing yards", "rushing yards"],
    player_rush_attempts: ["rushingAttempts", 4.5, "Rushing attempts", "rushing attempts"],
    player_receptions: ["receptions", 2.4, "Receptions", "receptions"],
    player_reception_yds: ["receivingYards", 16, "Receiving yards", "receiving yards"],
    player_receiving_yds: ["receivingYards", 16, "Receiving yards", "receiving yards"],
    player_rush_reception_yds: ["rushingReceivingYards", 20, "Rush + receiving yards", "rushing + receiving yards"],
    player_anytime_td: ["anytimeTouchdownProbability", null, "Anytime touchdown", "touchdown"],
  };

  for (const market of markets) {
    const config = fields[market.marketKey];
    if (!config || !market.playerName) continue;
    const player = players.find((item) =>
      namesMatch(canonicalPlayerName(getPlayerName(item)), canonicalPlayerName(market.playerName))
    );
    if (!player) continue;
    const displayName = resolvePlayerDisplayName(player, market.playerName);
    if (!isPlausiblePlayerPropLine(market.marketKey, market.point)) continue;
    matchedPlayerMarkets += 1;
    const roleConfidence = normaliseConfidence(player.roleConfidence ?? player.confidence ?? player.role?.confidence);
    const quality = normaliseConfidence(player.dataQuality ?? player.quality ?? player.dataQualityScore);
    if (roleConfidence < 0.55 || quality < 0.5) continue;
    assessed += 1;
    const [field, deviation, marketLabel, unitLabel] = config;
    const projection = findMetric(player, field);
    if (!Number.isFinite(projection)) continue;
    let modelProbability;
    let selection;
    let line = market.point;
    if (market.marketKey === "player_anytime_td") {
      modelProbability = clamp(projection, 0.02, 0.95);
      selection = `${displayName} anytime TD`;
      line = null;
    } else {
      const over = normaliseSide(market.name) !== "under";
      if (!Number.isFinite(line)) continue;
      const difference = over ? projection - line : line - projection;
      modelProbability = logisticProbability(difference, deviation);
      selection = `${displayName} ${over ? "Over" : "Under"} ${line} ${unitLabel}`;
    }
    const marketProbability = impliedProbability(market.price);
    const differenceText = line === null
      ? `Fourth Down gives ${displayName} a ${percent(modelProbability)} chance to score a touchdown.`
      : `Fourth Down projects ${projection.toFixed(field.includes("Touchdown") ? 2 : 1)} ${unitLabel} for ${displayName}. The line is ${line} ${unitLabel}, so the model is ${Math.abs(projection - line).toFixed(1)} ${unitLabel} ${projection >= line ? "above" : "below"} the market.`;
    const bet = buildBet({
      category: categoryForMarket(market.marketKey),
      market: marketLabel,
      rawMarketType: market.rawMarketType,
      period: market.period || "full_game",
      selection,
      line,
      price: market.price,
      sportsbook: market.sportsbook,
      modelProjection: projection,
      modelProbability,
      marketProbability,
      dataQuality: quality,
      roleConfidence,
      reason: differenceText,
      risk: playerRisk(player, market.marketKey, roleConfidence),
      updatedAt: market.updatedAt,
    });
    if (bet) result.push(bet);
  }
  return {
    assessed,
    recommendations: result,
    playerMarkets,
    matchedPlayerMarkets,
    projectedPlayers: players.length,
    providerPlayerNames: [...new Set(markets.filter((market) => isPlayerMarket(market.marketKey)).map((market) => market.playerName).filter(Boolean))].slice(0, 20),
    projectionPlayerNames: players.map(getPlayerName).filter(Boolean).slice(0, 20),
  };
}


function isPlausiblePlayerPropLine(marketKey, point) {
  if (marketKey === "player_anytime_td") return true;
  const line = Number(point);
  if (!Number.isFinite(line) || line < 0) return false;

  const ranges = {
    player_pass_yds: [150, 400],
    player_pass_tds: [0.5, 5.5],
    player_pass_attempts: [10.5, 60.5],
    player_completions: [5.5, 45.5],
    player_rush_yds: [5.5, 160.5],
    player_rush_attempts: [0.5, 35.5],
    player_receptions: [0.5, 10.5],
    player_reception_yds: [15.5, 160.5],
    player_receiving_yds: [15.5, 160.5],
    player_rush_reception_yds: [4.5, 220.5],
  };

  const range = ranges[marketKey];
  return Boolean(range && line >= range[0] && line <= range[1]);
}

function collectProjectedPlayers(value) {
  const found = [];
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const name = getPlayerName(node);
    const hasProjection = [
      "passingYards", "passing_yards", "rushingYards", "rushing_yards",
      "receivingYards", "receiving_yards", "receptions", "targets",
      "anytimeTouchdownProbability", "anytime_touchdown_probability",
    ].some((key) => Number.isFinite(Number(node[key])));
    if (name && hasProjection) {
      const key = normalize(name);
      if (!seen.has(key)) { seen.add(key); found.push(node); }
    }
    Object.values(node).forEach(visit);
  }
  visit(value);
  return found;
}

function getPlayerName(player) {
  return (
    player?.fullName ||
    player?.full_name ||
    player?.displayName ||
    player?.display_name ||
    player?.name ||
    player?.playerName ||
    player?.player_name ||
    ""
  );
}
function findMetric(player, field) {
  const aliases = {
    passingYards: ["passingYards", "passing_yards", "passYards"],
    passingTouchdowns: ["passingTouchdowns", "passing_touchdowns", "passTds"],
    passingAttempts: ["passingAttempts", "passing_attempts", "attempts"],
    completions: ["completions", "passingCompletions", "passing_completions"],
    rushingYards: ["rushingYards", "rushing_yards", "rushYards"],
    rushingAttempts: ["rushingAttempts", "rushing_attempts", "carries"],
    receivingYards: ["receivingYards", "receiving_yards", "recYards"],
    receptions: ["receptions", "catches"],
    rushingReceivingYards: ["rushingReceivingYards", "rushing_receiving_yards", "combinedYards"],
    anytimeTouchdownProbability: ["anytimeTouchdownProbability", "anytime_touchdown_probability", "touchdownProbability"],
  };
  for (const key of aliases[field] || [field]) {
    const value = Number(player?.[key]);
    if (Number.isFinite(value)) return value;
  }
  if (field === "rushingReceivingYards") {
    const rushing = findMetric(player, "rushingYards");
    const receiving = findMetric(player, "receivingYards");
    if (Number.isFinite(rushing) || Number.isFinite(receiving)) return number(rushing, 0) + number(receiving, 0);
  }
  return NaN;
}
function normaliseConfidence(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.65;
  return clamp(numberValue > 1 ? numberValue / 100 : numberValue, 0, 1);
}
function normaliseSide(value) { return normalize(value).includes("under") ? "under" : "over"; }
function isPlayerMarket(key) { return String(key || "").startsWith("player_"); }
function categoryForMarket(key) {
  if (key === "player_anytime_td") return "Anytime touchdowns";
  if (key.includes("pass") || key.includes("completion")) return "Passing props";
  if (key.includes("reception") || key.includes("receiving")) return "Receiving props";
  return "Rushing props";
}
function playerRisk(player, key, confidence) {
  const parts = [];
  if (confidence < 0.72) parts.push("the projected role is not fully secure");
  if (key === "player_anytime_td") parts.push("touchdowns are high-variance events");
  else parts.push("game script can change player volume");
  const position = player?.position || player?.pos;
  if (position) parts.push(`${position} usage can move with personnel packages`);
  return parts.join("; ");
}

function explainMoneyline(team, modelProbability, marketProbability, prediction, side) {
  const score = side === "away" ? prediction?.away?.score : prediction?.home?.score;
  const opponentScore = side === "away" ? prediction?.home?.score : prediction?.away?.score;
  const probabilityGap = (modelProbability - marketProbability) * 100;
  return `Fourth Down gives ${team} a ${percent(modelProbability)} chance to win. The market is closer to ${percent(marketProbability)}. The projected score is ${score}-${opponentScore}, so the model sees a ${Math.abs(probabilityGap).toFixed(1)} percentage-point advantage at the current price.`;
}
function explainSpread(team, opponent, modelMargin, line, coverMargin, prediction) {
  const total = number(prediction?.home?.score, 0) + number(prediction?.away?.score, 0);
  return `${team} is getting ${formatLine(line)} points from the market. Fourth Down expects ${team} to finish ${modelMargin >= 0 ? `${Math.abs(modelMargin).toFixed(1)} points ahead` : `${Math.abs(modelMargin).toFixed(1)} points behind ${opponent}`}. That gives this bet a ${Math.abs(coverMargin).toFixed(1)}-point cushion against the line. The projected total is ${total}.`;
}
function explainTotal(side, modelTotal, line, prediction) {
  const difference = Math.abs(modelTotal - line);
  const away = number(prediction?.away?.score, 0);
  const home = number(prediction?.home?.score, 0);
  return `Fourth Down expects ${modelTotal.toFixed(1)} total points. The betting line is ${line}, a difference of ${difference.toFixed(1)} points. The projected score is ${away}-${home}, which supports the ${side.toLowerCase()}.`;
}

function selectDiversePlayerProps(props, limit) {
  const categoryOrder = [
    "Passing props",
    "Rushing props",
    "Receiving props",
    "Anytime touchdowns",
  ];
  const selected = [];
  const used = new Set();

  // First pass: one strongest prop from every available category.
  for (const category of categoryOrder) {
    const bet = props
      .filter((item) => item.category === category)
      .sort((a, b) => b.score - a.score)[0];
    if (bet) {
      selected.push(bet);
      used.add(betIdentity(bet));
    }
  }

  // Second pass: fill remaining slots with the strongest unique prop markets.
  for (const bet of props) {
    if (selected.length >= limit) break;
    if (used.has(betIdentity(bet))) continue;
    selected.push(bet);
    used.add(betIdentity(bet));
  }

  return selected.slice(0, limit);
}

function selectDiverseGameBets(gameBets, limit) {
  const selected = [];
  const usedMarkets = new Set();
  const priority = ["Moneyline", "Spread", "Game total"];

  for (const market of priority) {
    if (selected.length >= limit) break;
    const bet = gameBets
      .filter((item) => item.market === market)
      .sort((a, b) => b.score - a.score)[0];
    if (!bet || usedMarkets.has(market)) continue;
    selected.push(bet);
    usedMarkets.add(market);
  }

  return selected;
}

function dedupeBetCandidates(candidates) {
  const chosen = new Map();
  for (const bet of candidates.filter(Boolean)) {
    const key = betCandidateKey(bet);
    const existing = chosen.get(key);
    if (!existing || bet.score > existing.score) chosen.set(key, bet);
  }
  return [...chosen.values()];
}

function selectUniquePlayerProps(props) {
  const chosen = new Map();

  for (const bet of props) {
    const player = normalisePlayerFromSelection(bet.selection);
    if (!player) continue;

    // Allow multiple different prop types for the same player, such as
    // passing yards and anytime touchdown. Only collapse duplicate offers
    // for the same player and market, keeping the strongest price/model edge.
    const key = [player, normalisePropMarket(bet.market)].join(":");
    const existing = chosen.get(key);

    if (!existing || comparePropOffer(bet, existing) > 0) {
      chosen.set(key, bet);
    }
  }

  return [...chosen.values()];
}

function normalisePropMarket(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function comparePropOffer(first, second) {
  const firstScore =
    Number(first.expectedValue || 0) * 0.5 +
    Number(first.edge || 0) * 0.3 +
    Number(first.decimalOdds || 0) * 0.02 +
    Number(first.score || 0) * 0.2;
  const secondScore =
    Number(second.expectedValue || 0) * 0.5 +
    Number(second.edge || 0) * 0.3 +
    Number(second.decimalOdds || 0) * 0.02 +
    Number(second.score || 0) * 0.2;

  return firstScore - secondScore;
}

function betCandidateKey(bet) {
  if (bet.category === "Game") {
    return ["game", bet.market, bet.selection].join(":");
  }
  return [
    "player",
    normalisePlayerFromSelection(bet.selection),
    normalisePropMarket(bet.market),
  ].join(":");
}

function normalisePlayerFromSelection(selection) {
  return String(selection || "")
    .replace(/\b(over|under|anytime td)\b.*$/i, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

function selectHighlights(recommendations, allCandidates) {
  const offered = dedupeBetCandidates(allCandidates)
    .filter((bet) => Number.isFinite(Number(bet.decimalOdds)));
  const playerOffered = offered.filter((bet) => bet.category !== "Game");
  const pool = playerOffered.length >= 2 ? playerOffered : offered;

  const mostLikely = [...pool]
    .sort((a, b) => b.modelProbability - a.modelProbability)[0] || null;

  const used = new Set(mostLikely ? [betIdentity(mostLikely)] : []);
  const bestValue = [...pool]
    .filter((bet) => !used.has(betIdentity(bet)))
    .sort((a, b) => b.expectedValue - a.expectedValue)[0] ||
    [...offered]
      .filter((bet) => !used.has(betIdentity(bet)))
      .sort((a, b) => b.expectedValue - a.expectedValue)[0] || null;

  if (bestValue) used.add(betIdentity(bestValue));
  const remaining = [...offered].filter((bet) => !used.has(betIdentity(bet)));
  const pricedLongshots = remaining
    .filter((bet) => bet.decimalOdds >= 5)
    .sort((a, b) => b.expectedValue - a.expectedValue || b.decimalOdds - a.decimalOdds);
  const fallbackLongshots = remaining
    .sort((a, b) => b.decimalOdds - a.decimalOdds || b.expectedValue - a.expectedValue);
  const longshot = pricedLongshots[0] || fallbackLongshots[0] || null;
  const longshotMeetsPrice = Boolean(longshot && longshot.decimalOdds >= 5);

  return {
    mostLikely: highlight(
      mostLikely,
      "Most likely",
      "Highest model probability, prioritising a player market when available"
    ),
    bestValue: highlight(
      bestValue,
      "Best value",
      "Highest estimated value after excluding Most likely, prioritising a different player market"
    ),
    longshot: longshot
      ? {
          ...highlight(
            longshot,
            "Longshot",
            longshotMeetsPrice
              ? "Highest-value separate selection priced at $5.00 or higher"
              : "Highest-priced separate selection available because no $5.00 market was returned"
          ),
          meetsLongshotPrice: longshotMeetsPrice,
        }
      : null,
  };
}

function betIdentity(bet) {
  return [bet?.market, bet?.selection, bet?.sportsbook].join(":");
}

function highlight(bet, label, explanation) { return bet ? { ...bet, highlightLabel: label, highlightExplanation: explanation } : null; }

function confidenceLabel(score) {
  if (score >= 0.76) return "High";
  if (score >= 0.6) return "Medium";
  return "Cautious";
}
function explainQualification(edge, expectedValue, dataQuality, roleConfidence) {
  const parts = [
    `Fourth Down rates this outcome ${(edge * 100).toFixed(1)} percentage points higher than the market`,
    `the estimated value is ${(expectedValue * 100).toFixed(1)}%`,
  ];
  if (roleConfidence < 0.99) parts.push(`the player's role confidence is ${(roleConfidence * 100).toFixed(0)}%`);
  parts.push(`the supporting data quality is ${(dataQuality * 100).toFixed(0)}%`);
  return `${parts.join(", ")}.`;
}

function gameBet(market, selection, row, modelProbability, marketProbability, quality, reason) {
  return buildBet({
    category: "Game",
    market,
    selection,
    line: row.point,
    price: row.price,
    sportsbook: row.sportsbook,
    modelProjection: null,
    modelProbability,
    marketProbability,
    dataQuality: quality,
    roleConfidence: 1,
    reason,
    risk: "Market movement, injuries and late lineup changes can reduce the edge",
    updatedAt: row.updatedAt,
  });
}

function buildBet(input) {
  const price = number(input.price, NaN);
  if (!Number.isFinite(price)) return null;
  const decimalOdds = americanToDecimal(price);
  const edge = input.modelProbability - input.marketProbability;
  const expectedValue = input.modelProbability * (decimalOdds - 1) - (1 - input.modelProbability);
  const confidenceScore = clamp(
    input.modelProbability * 0.3 +
      input.dataQuality * 0.3 +
      input.roleConfidence * 0.2 +
      clamp(Math.max(0, edge) / 0.15, 0, 1) * 0.2,
    0,
    1
  );
  return {
    ...input,
    confidenceScore: round4(confidenceScore),
    confidenceLevel: confidenceLabel(confidenceScore),
    qualificationReason: explainQualification(edge, expectedValue, input.dataQuality, input.roleConfidence),
    modelProbability: round4(input.modelProbability),
    marketProbability: round4(input.marketProbability),
    edge: round4(edge),
    expectedValue: round4(expectedValue),
    decimalOdds: round3(decimalOdds),
    score: round4(edge * 0.55 + expectedValue * 0.3 + input.dataQuality * 0.1 + input.roleConfidence * 0.05),
  };
}

function flattenMarkets(event) {
  const rows = [];
  const books = Array.isArray(event?.bookmakers)
    ? event.bookmakers
    : Array.isArray(event?.books)
      ? event.books
      : [];

  for (const book of books) {
    const markets = Array.isArray(book?.markets)
      ? book.markets
      : Object.entries(book?.markets || {}).map(([key, value]) => ({
          key,
          ...(value || {}),
        }));

    for (const market of markets) {
      const outcomes = Array.isArray(market?.outcomes)
        ? market.outcomes
        : Array.isArray(market?.selections)
          ? market.selections
          : [];

      for (const outcome of outcomes) {
        rows.push({
          marketKey: normaliseMarketKey(market.key || market.marketKey || market.type),
          rawMarketType: outcome.rawMarketType || market.rawMarketType || market.type || market.key || null,
          period: outcome.period || market.period || "full_game",
          name: outcome.name || outcome.selection || outcome.side || "",
          playerName:
            outcome.playerName ||
            outcome.player_name ||
            outcome.description ||
            market.playerName ||
            null,
          point: nullable(outcome.point ?? outcome.line),
          price: normaliseAmericanPrice(outcome.price ?? outcome.odds ?? outcome.american),
          sportsbook: book.title || book.name || book.key || "Market",
          updatedAt: market.last_update || market.updatedAt || book.last_update || book.updatedAt || null,
        });
      }
    }
  }

  return rows.filter((row) => row.marketKey && Number.isFinite(row.price));
}

function normaliseMarketKey(value) {
  const key = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    moneyline: "h2h",
    money_line: "h2h",
    ml: "h2h",
    point_spread: "spreads",
    spread: "spreads",
    total_points: "totals",
    total: "totals",
    over_under: "totals",
  };
  return aliases[key] || key;
}

function normaliseAmericanPrice(value) {
  const price = nullable(value);
  if (price === null) return null;
  // Some providers return decimal odds. Convert those to the internal
  // American representation used for probability and EV calculations.
  if (price > 1 && price < 20) {
    return price >= 2
      ? Math.round((price - 1) * 100)
      : Math.round(-100 / (price - 1));
  }
  return price;
}

function bestOutcome(rows, predicate) {
  return rows.filter(predicate).filter((row) => Number.isFinite(row.price))
    .sort((a, b) => americanToDecimal(b.price) - americanToDecimal(a.price))[0] || null;
}
function noVigPair(first, second) {
  const a = impliedProbability(first), b = impliedProbability(second), total = a + b || 1;
  return { first: a / total, second: b / total };
}
function impliedProbability(price) { return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100); }
function americanToDecimal(price) { return price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price); }
function logisticProbability(edge, scale) { return clamp(1 / (1 + Math.exp(-edge / scale)), 0.05, 0.95); }
function overallQuality(dataQuality, prediction) {
  const values = Object.values(dataQuality || {}).filter((value) => typeof value === "boolean");
  const coverage = values.length ? values.filter(Boolean).length / values.length : 0.5;
  return clamp((coverage + number(prediction?.confidenceScore, 0.5)) / 2, 0.25, 0.95);
}
function teamMatches(name, code) { return normalize(name).includes(normalize(code)) || normalizeTeam(name) === code; }
function normalizeTeam(value) {
  const text = normalize(value); const names = { arizonacardinals:"ARI", atlantafalcons:"ATL", baltimoreravens:"BAL", buffalobills:"BUF", carolinapanthers:"CAR", chicagobears:"CHI", cincinnatibengals:"CIN", clevelandbrowns:"CLE", dallascowboys:"DAL", denverbroncos:"DEN", detroitlions:"DET", greenbaypackers:"GB", houstontexans:"HOU", indianapoliscolts:"IND", jacksonvillejaguars:"JAX", kansascitychiefs:"KC", lasvegasraiders:"LV", losangeleschargers:"LAC", losangelesrams:"LAR", miamidolphins:"MIA", minnesotavikings:"MIN", newenglandpatriots:"NE", neworleanssaints:"NO", newyorkgiants:"NYG", newyorkjets:"NYJ", philadelphiaeagles:"PHI", pittsburghsteelers:"PIT", sanfrancisco49ers:"SF", seattleseahawks:"SEA", tampabaybuccaneers:"TB", tennesseetitans:"TEN", washingtoncommanders:"WSH" };
  return names[text] || String(value || "").toUpperCase();
}
function namesMatch(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xTokens = nameTokens(a);
  const yTokens = nameTokens(b);
  const xLast = xTokens[xTokens.length - 1];
  const yLast = yTokens[yTokens.length - 1];
  if (!xLast || xLast !== yLast) return false;
  const xFirst = xTokens[0] || "";
  const yFirst = yTokens[0] || "";
  return !xFirst || !yFirst || xFirst[0] === yFirst[0];
}
function nameTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function nullable(value) { if (value === null || value === undefined || value === "") return null; const n=Number(value); return Number.isFinite(n)?n:null; }
function number(value, fallback=0) { const n=Number(value); return Number.isFinite(n)?n:fallback; }
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function round3(v){return Math.round(v*1000)/1000;} function round4(v){return Math.round(v*10000)/10000;}
function percent(v){return `${Math.round(v*100)}%`;}
function formatLine(v){return `${v>0?"+":""}${v}`;} function formatSigned(v){return `${v>=0?"+":""}${v.toFixed(1)}`;}
function formatProjection(value,key){return key.includes("td")?value.toFixed(2):value.toFixed(1);}
