// services/predictionEngine.js
// Deterministic matchup projection with component-level weather effects.
import { getTeamRatings } from "./teamRatings.js";
import { getHomeFieldAdvantage } from "./homeFieldAdvantage.js";

const RATING_BASELINE = 75;
const BASE_PASS_RATIO = 0.6;

const NFL_DIVISIONS = {
  "AFC East": ["BUF", "MIA", "NE", "NYJ"],
  "AFC North": ["BAL", "CIN", "CLE", "PIT"],
  "AFC South": ["HOU", "IND", "JAX", "TEN"],
  "AFC West": ["DEN", "KC", "LV", "LAC"],
  "NFC East": ["DAL", "NYG", "PHI", "WSH"],
  "NFC North": ["CHI", "DET", "GB", "MIN"],
  "NFC South": ["ATL", "CAR", "NO", "TB"],
  "NFC West": ["ARI", "LAR", "SF", "SEA"],
};

const TEAM_DIVISION = Object.fromEntries(
  Object.entries(NFL_DIVISIONS).flatMap(([division, teams]) =>
    teams.map((team) => [team, division])
  )
);

// Public aggregate evidence suggests comparable divisional matchups finish with
// margins roughly 1.2 points tighter. This is applied to the projected margin,
// not the total, and can later be replaced by a fitted historical coefficient.
const DIVISIONAL_MARGIN_COMPRESSION_POINTS = 1.2;

export function predictMatchup(awayCode, homeCode, options = {}) {
  const awayTeam = normalizeTeamCode(awayCode);
  const homeTeam = normalizeTeamCode(homeCode);

  const hfa = getHomeFieldAdvantage(homeTeam, awayTeam, {
    kickoff: options.kickoff,
    homeSplit: options.homeSplit,
    awaySplit: options.awaySplit,
  });

  const weatherImpact = computeWeatherImpact(options.weather);
  const rivalry = computeDivisionalRivalryImpact(awayTeam, homeTeam, options.rivalry);
  const schedule = computeScheduleImpact(options.scheduleContext);
  const modelLayers = createModelLayers(options.modelLayers);
  const market = computeMarketProjection(options.market, options.week);
  const ratingAdjustments = {
    away: getRatingAdjustment(awayTeam, homeTeam, 0),
    home: getRatingAdjustment(homeTeam, awayTeam, hfa.total),
  };
  const formBlend = buildTeamSpecificProjection(
    ratingAdjustments,
    modelLayers.scoringBaseline,
    market,
    options.week,
    awayTeam,
    homeTeam
  );
  const fourthDownAway = formBlend.away
    + schedule.awayPoints
    + modelLayers.awayPoints;
  const fourthDownHome = formBlend.home
    + schedule.homePoints
    + modelLayers.homePoints;
  const rivalryAdjusted = applyRivalryToExpectedPoints(
    clamp(fourthDownAway, 6, 45),
    clamp(fourthDownHome, 6, 45),
    rivalry
  );
  const adjustedExpected = rivalryAdjusted;

  const playerLayer = modelLayers.playerRatings;
  const expectedPossessions = possessionsFromPaceLayer(modelLayers.pace);
  const away = projectTeam(awayTeam, homeTeam, adjustedExpected.away, weatherImpact, {
    expectedPossessions,
    passingMultiplier: playerLayer.awayPassingMultiplier,
    rushingMultiplier: playerLayer.awayRushingMultiplier,
    fieldGoalOpportunityMultiplier: playerLayer.awayFieldGoalOpportunityMultiplier,
    seed: `${awayTeam}-${homeTeam}-${options.week || 1}-away`,
  });
  const home = projectTeam(homeTeam, awayTeam, adjustedExpected.home, weatherImpact, {
    expectedPossessions,
    passingMultiplier: playerLayer.homePassingMultiplier,
    rushingMultiplier: playerLayer.homeRushingMultiplier,
    fieldGoalOpportunityMultiplier: playerLayer.homeFieldGoalOpportunityMultiplier,
    seed: `${awayTeam}-${homeTeam}-${options.week || 1}-home`,
  });
  const projectedMargin = home.score - away.score;
  const continuousMargin = Number(home.expectedPoints) - Number(away.expectedPoints);
  const probability = calculateWinProbability(continuousMargin, modelLayers, market);
  const projectedTie = home.score === away.score;
  let winner = null;
  if (!projectedTie) winner = home.score > away.score ? homeTeam : awayTeam;
  else if (probability.home > probability.away) winner = homeTeam;
  else if (probability.away > probability.home) winner = awayTeam;

  return {
    away: { code: awayTeam, ...away },
    home: { code: homeTeam, ...home },
    winner,
    projectedTie,
    continuousMargin: round3(continuousMargin),
    margin: Math.abs(projectedMargin),
    total: home.score + away.score,
    confidence: probability.confidenceLabel,
    awayWinProbability: probability.away,
    homeWinProbability: probability.home,
    winnerWinProbability: winner === homeTeam ? probability.home : winner === awayTeam ? probability.away : 0.5,
    confidenceScore: probability.dataQuality,
    confidenceReasons: probability.reasons,
    homeField: hfa,
    weather: weatherImpact,
    rivalry,
    schedule,
    modelLayers,
    formBlend,
    market,
  };
}

export function computeMarketProjection(event, week = 1) {
  const neutral = {
    active: false,
    baseWeight: 0,
    effectiveWeight: 0,
    reliability: 0,
    booksUsed: 0,
    homeSpread: null,
    total: null,
    awayExpected: null,
    homeExpected: null,
  };
  if (!event || !Array.isArray(event.bookmakers)) return neutral;

  const spreads = [];
  const totals = [];
  const homeName = normalizeMarketName(event.home_team);
  const homeNickname = marketNickname(homeName);

  for (const bookmaker of event.bookmakers) {
    const markets = Array.isArray(bookmaker?.markets) ? bookmaker.markets : [];
    const spreadMarket = markets.find((market) => market.key === "spreads");
    const totalMarket = markets.find((market) => market.key === "totals");
    const homeOutcome = spreadMarket?.outcomes?.find((outcome) => {
      const outcomeName = normalizeMarketName(outcome.name);
      return outcomeName === homeName || (
        homeNickname && marketNickname(outcomeName) === homeNickname
      );
    });
    const totalOutcome = totalMarket?.outcomes?.find(
      (outcome) => ["over", "under"].includes(String(outcome.name || "").toLowerCase())
    );
    const spread = nullableNum(homeOutcome?.point);
    const total = nullableNum(totalOutcome?.point);
    if (spread != null) spreads.push(spread);
    if (total != null) totals.push(total);
  }

  if (!spreads.length || !totals.length) return neutral;
  const homeSpread = median(spreads);
  const total = median(totals);
  if (total < 20 || total > 90 || Math.abs(homeSpread) > 30) return neutral;

  const booksUsed = Math.min(spreads.length, totals.length);
  const reliability = booksUsed >= 5
    ? 1
    : booksUsed >= 3
      ? 0.9
      : booksUsed === 2
        ? 0.8
        : 0.65;
  const baseWeight = marketWeightForWeek(week);
  const effectiveWeight = baseWeight * reliability;

  return {
    active: effectiveWeight > 0,
    baseWeight: round3(baseWeight),
    effectiveWeight: round3(effectiveWeight),
    reliability: round3(reliability),
    booksUsed,
    homeSpread: round3(homeSpread),
    total: round3(total),
    awayExpected: round3((total + homeSpread) / 2),
    homeExpected: round3((total - homeSpread) / 2),
  };
}

function buildTeamSpecificProjection(
  ratingAdjustments,
  scoringBaseline,
  market,
  week,
  awayCode,
  homeCode
) {
  const awayExpected = nullableNum(scoringBaseline?.awayExpected);
  const homeExpected = nullableNum(scoringBaseline?.homeExpected);

  const awayGamesUsed =
    Number(
      scoringBaseline?.gamesUsed?.away ??
      scoringBaseline?.gamesUsed
    ) || 0;

  const homeGamesUsed =
    Number(
      scoringBaseline?.gamesUsed?.home ??
      scoringBaseline?.gamesUsed
    ) || 0;

  const sampleGames = Math.max(
    0,
    Math.min(awayGamesUsed, homeGamesUsed)
  );

  const sampleReliability = clamp(
    Math.min(sampleGames / 4, 1) * currentSeasonWeightForWeek(week),
    0,
    0.9
  );

  const marketWeight = market?.active
    ? clamp(market.effectiveWeight, 0, 0.4)
    : 0;

  const hasTeamProjection =
    scoringBaseline?.active &&
    awayExpected != null &&
    homeExpected != null &&
    sampleGames > 0;

  let awayBase;
  let homeBase;
  let source;

  if (hasTeamProjection) {
    const awayFallback = market?.active
      ? market.awayExpected
      : getRatingOnlyScoringLevel(awayCode, homeCode);

    const homeFallback = market?.active
      ? market.homeExpected
      : getRatingOnlyScoringLevel(homeCode, awayCode);

    const awayTeamLevel =
      awayExpected * sampleReliability +
      awayFallback * (1 - sampleReliability);

    const homeTeamLevel =
      homeExpected * sampleReliability +
      homeFallback * (1 - sampleReliability);

    awayBase = market?.active
      ? awayTeamLevel * (1 - marketWeight) +
        market.awayExpected * marketWeight
      : awayTeamLevel;

    homeBase = market?.active
      ? homeTeamLevel * (1 - marketWeight) +
        market.homeExpected * marketWeight
      : homeTeamLevel;

    source = "current-season team scoring";
  } else if (market?.active) {
    awayBase = market.awayExpected;
    homeBase = market.homeExpected;
    source = "market-implied team totals";
  } else {
    awayBase = getRatingOnlyScoringLevel(awayCode, homeCode);
    homeBase = getRatingOnlyScoringLevel(homeCode, awayCode);
    source = "team-rating scoring fallback";
  }

  return {
    active: true,
    source,
    week: Number(week) || 1,
    weight: round3(sampleReliability),
    configuredWeight: 1,
    sampleReliability: round3(sampleReliability),
    marketWeight: round3(marketWeight),
    gamesUsed: {
      away: awayGamesUsed,
      home: homeGamesUsed,
    },
    ratingAdjustmentAway: round3(ratingAdjustments.away),
    ratingAdjustmentHome: round3(ratingAdjustments.home),
    formAway: awayExpected,
    formHome: homeExpected,
    away: clamp(
      awayBase + ratingAdjustments.away,
      3,
      48
    ),
    home: clamp(
      homeBase + ratingAdjustments.home,
      3,
      48
    ),
  };
}

function currentSeasonWeightForWeek(week) {
  const value = Math.max(1, Number(week) || 1);
  if (value <= 1) return 0;
  if (value === 2) return 0.30;
  if (value === 3) return 0.45;
  if (value === 4) return 0.60;
  if (value === 5) return 0.75;
  if (value === 6) return 0.85;
  return 0.90;
}

function blendMarketProjection(model, market) {
  if (!market?.active) return model;
  const weight = market.effectiveWeight;
  return {
    away: clamp(model.away * (1 - weight) + market.awayExpected * weight, 6, 45),
    home: clamp(model.home * (1 - weight) + market.homeExpected * weight, 6, 45),
  };
}

function marketWeightForWeek(week) {
  const value = Math.max(1, Number(week) || 1);
  if (value === 1) return 0.40;
  if (value <= 3) return 0.30;
  if (value === 4) return 0.20;
  if (value === 5) return 0.15;
  if (value === 6) return 0.10;
  return 0.10;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeMarketName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function marketNickname(value) {
  const name = normalizeMarketName(value);
  const nicknames = [
    "cardinals", "falcons", "ravens", "bills", "panthers", "bears",
    "bengals", "browns", "cowboys", "broncos", "lions", "packers",
    "texans", "colts", "jaguars", "chiefs", "raiders", "chargers",
    "rams", "dolphins", "vikings", "patriots", "saints", "giants",
    "jets", "eagles", "steelers", "49ers", "seahawks", "buccaneers",
    "titans", "commanders"
  ];
  return nicknames.find((nickname) => name === nickname || name.endsWith(nickname)) || "";
}

export function computeScheduleImpact(context) {
  const neutral = {
    active: false,
    awayPoints: 0,
    homePoints: 0,
    differential: 0,
    summary: "No schedule adjustment",
    awayReasons: [],
    homeReasons: [],
  };

  if (!context?.away || !context?.home) return neutral;

  const away = computeTeamSchedulePoints(context.away);
  const home = computeTeamSchedulePoints(context.home);

  // Relative rest is more informative than independently rewarding both teams.
  // Apply a conservative differential adjustment and cap the whole layer.
  const awayRest = nullableNum(context.away.daysRest);
  const homeRest = nullableNum(context.home.daysRest);
  const restDifferential =
    awayRest == null || homeRest == null ? 0 : homeRest - awayRest;

  let relativeHome = 0;
  if (Math.abs(restDifferential) >= 7) relativeHome = Math.sign(restDifferential) * 0.8;
  else if (Math.abs(restDifferential) >= 3) relativeHome = Math.sign(restDifferential) * 0.4;

  const awayPoints = clamp(away.points - relativeHome / 2, -1.5, 1.5);
  const homePoints = clamp(home.points + relativeHome / 2, -1.5, 1.5);
  const differential = homePoints - awayPoints;
  const reasons = [...away.reasons.map((reason) => `Away: ${reason}`), ...home.reasons.map((reason) => `Home: ${reason}`)];

  if (relativeHome > 0) reasons.push(`Home has ${Math.abs(restDifferential)} more rest days`);
  if (relativeHome < 0) reasons.push(`Away has ${Math.abs(restDifferential)} more rest days`);

  return {
    active: Math.abs(awayPoints) > 0.001 || Math.abs(homePoints) > 0.001,
    awayPoints: round3(awayPoints),
    homePoints: round3(homePoints),
    differential: round3(differential),
    restDifferentialDays: restDifferential,
    summary: reasons.length ? `${reasons.join(" · ")} (${formatSigned(differential)} pts toward home)` : "Balanced rest and schedule",
    awayReasons: away.reasons,
    homeReasons: home.reasons,
  };
}

function computeTeamSchedulePoints(team) {
  let points = 0;
  const reasons = [];
  const daysRest = nullableNum(team?.daysRest);
  const roadRun = num(team?.consecutiveRoadGamesIncludingCurrent, 0);

  if (daysRest != null && daysRest <= 4) {
    points -= 0.7;
    reasons.push("very short week");
  } else if (daysRest === 5) {
    points -= 0.4;
    reasons.push("short week");
  } else if (daysRest != null && daysRest >= 12) {
    points += 0.6;
    reasons.push("post-bye rest");
  } else if (daysRest != null && daysRest >= 9) {
    points += 0.3;
    reasons.push("extended rest");
  }

  if (roadRun >= 3) {
    points -= 0.4;
    reasons.push(`${roadRun}th consecutive road game`);
  } else if (roadRun === 2) {
    points -= 0.2;
    reasons.push("second consecutive road game");
  }

  return { points: clamp(points, -1.1, 0.8), reasons };
}

// Neutral extension points for the next data-backed phases. Nothing here changes
// a score until a future layer supplies explicit homePoints or awayPoints.
export function createModelLayers(input = {}) {
  const layerNames = [
    "quarterback",
    "rosterHealth",
    "specialTeams",
    "playerRatings",
    "opponentNetwork",
    "playByPlayEfficiency",
    "opponentAdjustedEfficiency",
    "successRate",
    "scoringBaseline",
    "turnoverRegression",
    "redZone",
    "explosivePlays",
    "earlyDownEpa",
    "schemeMatchup",
    "passProtection",
    "pressureMatchup",
    "offensiveLineContinuity",
    "coverageMatchup",
    "driveEfficiency",
    "situationalEfficiency",
    "snapParticipation",
    "expectedLineup",
    "pace",
  ];

  const totalMovingLayers = new Set(["scoringBaseline", "pace"]);
  const layers = Object.fromEntries(
    layerNames.map((name) => {
      const normalised = normaliseModelLayer(input?.[name]);
      return [name, totalMovingLayers.has(name) ? normalised : centreComparativeLayer(normalised)];
    })
  );

  return {
    ...layers,
    awayPoints: round3(clamp(layerNames.reduce((total, name) => total + layers[name].awayPoints, 0), -7.5, 7.5)),
    homePoints: round3(clamp(layerNames.reduce((total, name) => total + layers[name].homePoints, 0), -7.5, 7.5)),
  };
}

function centreComparativeLayer(layer) {
  const edge = clamp((layer.homePoints - layer.awayPoints) / 2, -2.5, 2.5);
  return {
    ...layer,
    awayPoints: round3(-edge),
    homePoints: round3(edge),
  };
}

function normaliseModelLayer(layer) {
  return {
    active: Boolean(layer?.active),
    available: layer?.available !== false,
    awayPoints: clamp(num(layer?.awayPoints, 0), -7.5, 7.5),
    homePoints: clamp(num(layer?.homePoints, 0), -7.5, 7.5),
    confidence: clamp(num(layer?.confidence, 0), 0, 1),
    reasons: Array.isArray(layer?.reasons) ? layer.reasons : [],
    awayPassingMultiplier: clamp(num(layer?.awayPassingMultiplier, 1), 0.8, 1.2),
    homePassingMultiplier: clamp(num(layer?.homePassingMultiplier, 1), 0.8, 1.2),
    awayRushingMultiplier: clamp(num(layer?.awayRushingMultiplier, 1), 0.8, 1.2),
    homeRushingMultiplier: clamp(num(layer?.homeRushingMultiplier, 1), 0.8, 1.2),
    awayFieldGoalOpportunityMultiplier: clamp(num(layer?.awayFieldGoalOpportunityMultiplier, 1), 0.8, 1.2),
    homeFieldGoalOpportunityMultiplier: clamp(num(layer?.homeFieldGoalOpportunityMultiplier, 1), 0.8, 1.2),
    awayExpected: nullableNum(layer?.awayExpected),
    homeExpected: nullableNum(layer?.homeExpected),
    leagueAverage: nullableNum(layer?.leagueAverage),
    gamesUsed: layer?.gamesUsed || null,
  };
}

export function computeDivisionalRivalryImpact(awayCode, homeCode, context = {}) {
  const awayTeam = normalizeTeamCode(awayCode);
  const homeTeam = normalizeTeamCode(homeCode);
  const awayDivision = TEAM_DIVISION[awayTeam] || null;
  const homeDivision = TEAM_DIVISION[homeTeam] || null;
  const isDivisional = Boolean(awayDivision && awayDivision === homeDivision);

  if (!isDivisional) {
    return {
      active: false,
      isDivisional: false,
      division: null,
      marginCompressionPoints: 0,
      meetingNumber: 0,
      description: "Non-divisional matchup",
    };
  }

  const meetingNumber = Number(context?.meetingNumber) === 2 ? 2 : 1;
  const previousMargin = Math.abs(Number(context?.previousMargin) || 0);
  const closePreviousMeeting = meetingNumber === 2 && previousMargin > 0 && previousMargin <= 3;

  // The base adjustment is evidence-led. The small second-meeting and close-game
  // additions are deliberately capped until Fourth Down trains its own history.
  const contextualAddition = meetingNumber === 2 ? 0.2 : 0;
  const closeGameAddition = closePreviousMeeting ? 0.2 : 0;
  const marginCompressionPoints = clamp(
    DIVISIONAL_MARGIN_COMPRESSION_POINTS + contextualAddition + closeGameAddition,
    0,
    1.6
  );

  return {
    active: true,
    isDivisional: true,
    division: awayDivision,
    marginCompressionPoints: round3(marginCompressionPoints),
    meetingNumber,
    closePreviousMeeting,
    description: `${awayDivision} divisional rivalry`,
  };
}

function applyRivalryToExpectedPoints(awayExpected, homeExpected, rivalry) {
  if (!rivalry?.active) return { away: awayExpected, home: homeExpected };

  const midpoint = (awayExpected + homeExpected) / 2;
  const originalMargin = Math.abs(homeExpected - awayExpected);
  const adjustedMargin = Math.max(0, originalMargin - rivalry.marginCompressionPoints);
  const homeIsFavourite = homeExpected >= awayExpected;

  return homeIsFavourite
    ? { away: midpoint - adjustedMargin / 2, home: midpoint + adjustedMargin / 2 }
    : { away: midpoint + adjustedMargin / 2, home: midpoint - adjustedMargin / 2 };
}

// Conservative public-evidence starting model. Coefficients are isolated here
// so they can later be replaced by values fitted from nflverse play-by-play.
export function computeWeatherImpact(weather) {
  const neutral = {
    active: false,
    dome: false,
    coefficient: 1,
    severity: "None",
    conditions: [],
    passingTD: 1,
    rushingTD: 1,
    defensiveTD: 1,
    fieldGoals: 1,
    extraPoints: 1,
    twoPoint: 1,
    passRatioShift: 0,
    turnoverRisk: 1,
  };

  if (!weather) return neutral;
  if (weather.dome) return { ...neutral, dome: true };

  const windKmh = num(weather.windSpeed, 0);
  const gustKmh = Math.max(windKmh, num(weather.windGust, windKmh));
  const windMph = windKmh * 0.621371;
  const gustMph = gustKmh * 0.621371;
  const rain = Math.max(0, num(weather.rain, weather.precipitation));
  const peakRain = Math.max(0, num(weather.maxHourlyRain, 0));
  const snow = Math.max(0, num(weather.snowfall, 0));
  const tempC = nullableNum(weather.temperature);
  const humidity = num(weather.humidity, 0);
  const visibilityKm = nullableNum(weather.visibility) == null
    ? null
    : Number(weather.visibility) / 1000;
  const code = num(weather.weatherCode, 0);

  const windLoad = clamp((windMph - 10) / 15, 0, 1.35);
  const gustLoad = clamp((gustMph - Math.max(18, windMph)) / 20, 0, 1);
  const rainLoad = clamp(Math.max(rain / 8, peakRain / 3), 0, 1.25);
  const snowLoad = clamp(snow / 4, 0, 1.25);
  const lowVisibilityLoad = visibilityKm == null ? 0 : clamp((8 - visibilityKm) / 7, 0, 1);
  const extremeHeatLoad = tempC == null ? 0 : clamp((tempC - 32) / 8, 0, 1);
  const extremeColdLoad = tempC == null ? 0 : clamp((-7 - tempC) / 13, 0, 1);
  const humidHeatLoad = extremeHeatLoad * clamp((humidity - 65) / 25, 0, 1);
  const thunderLoad = code >= 95 && code <= 99 ? 1 : 0;

  const windRain = windLoad * rainLoad;
  const windSnow = windLoad * snowLoad;
  const coldWind = extremeColdLoad * windLoad;
  const precipVisibility = Math.max(rainLoad, snowLoad) * lowVisibilityLoad;

  const passingTD = expClamp(
    -0.065 * windLoad - 0.025 * gustLoad - 0.025 * rainLoad - 0.045 * snowLoad
    -0.035 * windRain - 0.05 * windSnow - 0.015 * lowVisibilityLoad,
    0.78, 1
  );

  const rushingTD = expClamp(
    -0.01 * snowLoad - 0.01 * extremeHeatLoad + 0.008 * Math.max(rainLoad, windLoad),
    0.95, 1.02
  );

  const fieldGoals = expClamp(
    -0.08 * windLoad - 0.05 * gustLoad - 0.025 * rainLoad - 0.05 * snowLoad
    -0.055 * windRain - 0.07 * windSnow - 0.025 * coldWind,
    0.68, 1
  );

  const extraPoints = expClamp(
    -0.025 * windLoad - 0.015 * gustLoad - 0.012 * rainLoad - 0.025 * snowLoad
    -0.02 * windRain - 0.025 * windSnow,
    0.86, 1
  );

  const twoPoint = expClamp(
    -0.035 * windLoad - 0.02 * rainLoad - 0.04 * snowLoad - 0.02 * lowVisibilityLoad,
    0.84, 1
  );

  const turnoverRisk = expClamp(
    0.035 * windLoad + 0.05 * rainLoad + 0.075 * snowLoad + 0.035 * windRain
    +0.045 * windSnow + 0.025 * precipVisibility,
    1, 1.25
  );

  const defensiveTD = clamp(1 + (turnoverRisk - 1) * 0.35, 1, 1.09);
  const passRatioShift = clamp(
    0.025 * windLoad + 0.018 * rainLoad + 0.03 * snowLoad + 0.015 * thunderLoad,
    0, 0.09
  );

  // Weighted scoring coefficient for display and overall model diagnostics.
  const coefficient = clamp(
    0.58 * passingTD + 0.22 * rushingTD + 0.15 * fieldGoals + 0.05 * extraPoints
      -0.012 * thunderLoad -0.008 * humidHeatLoad,
    0.78, 1
  );

  const conditions = [];
  if (windLoad > 0) conditions.push("Wind");
  if (rainLoad > 0.05) conditions.push("Rain");
  if (snowLoad > 0.05) conditions.push("Snow");
  if (lowVisibilityLoad > 0) conditions.push("Low visibility");
  if (extremeHeatLoad > 0) conditions.push("Extreme heat");
  if (extremeColdLoad > 0) conditions.push("Extreme cold");
  if (thunderLoad) conditions.push("Thunderstorm");

  const reduction = 1 - coefficient;
  const severity = reduction >= 0.12 ? "Severe" : reduction >= 0.07 ? "High" : reduction >= 0.03 ? "Moderate" : conditions.length ? "Low" : "None";

  return {
    active: conditions.length > 0,
    dome: false,
    coefficient: round3(coefficient),
    severity,
    conditions,
    passingTD: round3(passingTD),
    rushingTD: round3(rushingTD),
    defensiveTD: round3(defensiveTD),
    fieldGoals: round3(fieldGoals),
    extraPoints: round3(extraPoints),
    twoPoint: round3(twoPoint),
    passRatioShift: round3(passRatioShift),
    turnoverRisk: round3(turnoverRisk),
  };
}

function getRatingAdjustment(code, oppCode, homeEdge) {
  const ratings = getTeamRatings(code);
  const opponent = getTeamRatings(oppCode);
  const offense = num(ratings.offense, RATING_BASELINE);
  const defense = num(opponent.defense, RATING_BASELINE);
  const overall = num(ratings.overall, RATING_BASELINE);
  const opponentOverall = num(opponent.overall, RATING_BASELINE);

  return clamp(
    (offense - defense) * 0.1 +
      (overall - opponentOverall) * 0.04 +
      num(homeEdge, 0),
    -4,
    4
  );
}

function getRatingOnlyScoringLevel(code, oppCode) {
  const ratings = getTeamRatings(code);
  const opponent = getTeamRatings(oppCode);
  const offense = num(ratings.offense, RATING_BASELINE);
  const defense = num(opponent.defense, RATING_BASELINE);

  return clamp(
    8 + offense * 0.22 - (defense - RATING_BASELINE) * 0.1,
    6,
    42
  );
}

function possessionsFromPaceLayer(layer) {
  const totalShift = num(layer?.awayPoints, 0) + num(layer?.homePoints, 0);
  return clamp(10.7 + totalShift * 0.75, 9.2, 12.8);
}
function projectTeam(code, oppCode, calibratedPoints, weatherImpact, playerImpact = {}) {
  const ratings = getTeamRatings(code);
  const opponent = getTeamRatings(oppCode);
  const passRatio = clamp(BASE_PASS_RATIO - weatherImpact.passRatioShift, 0.45, 0.6);

  return buildScoringEvents(
    calibratedPoints,
    ratings,
    opponent,
    passRatio,
    weatherImpact,
    playerImpact
  );
}

function buildScoringEvents(
  calibratedPoints,
  ratings,
  opponent,
  passRatio,
  weather,
  playerImpact
) {
  const offenseRating = num(ratings.offense, RATING_BASELINE);
  const opponentDefense = num(opponent.defense, RATING_BASELINE);
  const ownDefense = num(ratings.defense, RATING_BASELINE);
  const opponentOffense = num(opponent.offense, RATING_BASELINE);
  const matchupEdge = offenseRating - opponentDefense;
  const defensiveEdge = ownDefense - opponentOffense;

  const expectedPossessions = clamp(
    num(playerImpact.expectedPossessions, 10.7),
    9.2,
    12.8
  );

  const fieldGoalAttemptRate =
    clamp(
      0.15 - matchupEdge * 0.001,
      0.07,
      0.24
    ) *
    num(playerImpact.fieldGoalOpportunityMultiplier, 1);


  const passingShare = clamp(
    passRatio * num(playerImpact.passingMultiplier, 1),
    0.42,
    0.72
  );
  const rushingShareRaw =
    (1 - passRatio) * num(playerImpact.rushingMultiplier, 1);
  const totalTouchdownShare = passingShare + rushingShareRaw;
  const passingTouchdownShare = passingShare / totalTouchdownShare;

  const fieldGoalMakeRate = clamp(
    0.84 * weather.fieldGoals,
    0.56,
    0.95
  );
  const extraPointMakeRate = clamp(
    0.945 * weather.extraPoints,
    0.78,
    0.97
  );
  const defensiveTouchdownRate = clamp(
    0.055 + defensiveEdge * 0.0018,
    0.018,
    0.105
  );

  const expectedFieldGoalPoints =
    expectedPossessions *
    fieldGoalAttemptRate *
    fieldGoalMakeRate *
    3;

  const expectedDefensivePoints =
    defensiveTouchdownRate *
    (6 + extraPointMakeRate);

  const touchdownDriveRate = clamp(
    (
      calibratedPoints -
      expectedFieldGoalPoints -
      expectedDefensivePoints
    ) /
      Math.max(
        1,
        expectedPossessions *
          (6 + extraPointMakeRate)
      ),
    0.035,
    0.5
  );

  const rawExpectedPoints =
    expectedPossessions * touchdownDriveRate *
      (6 + extraPointMakeRate) +
    expectedPossessions * fieldGoalAttemptRate *
      fieldGoalMakeRate * 3 +
    defensiveTouchdownRate * (6 + extraPointMakeRate);

  const calibrationScale = clamp(
    calibratedPoints / Math.max(1, rawExpectedPoints),
    0.65,
    1.45
  );

  const calibratedTouchdownRate = clamp(
    touchdownDriveRate * Math.pow(calibrationScale, 0.72),
    0.09,
    0.39
  );
  const calibratedFieldGoalRate = clamp(
    fieldGoalAttemptRate * Math.pow(calibrationScale, 0.45),
    0.07,
    0.24
  );

  const simulations = simulateScoringOutcomes({
    count: 4000,
    seed: playerImpact.seed || `${offenseRating}-${opponentDefense}-${calibratedPoints}`,
    expectedPossessions,
    touchdownDriveRate: calibratedTouchdownRate,
    fieldGoalAttemptRate: calibratedFieldGoalRate,
    passingTouchdownShare,
    fieldGoalMakeRate,
    extraPointMakeRate,
    defensiveTouchdownRate,
  });

  const representative = selectRepresentativeSimulation(
    simulations,
    calibratedPoints
  );
  const expectedPoints =
    simulations.reduce((total, result) => total + result.score, 0) /
    simulations.length;

  return {
    ...representative,
    expectedPoints: round3(expectedPoints),
    expectedPossessions: round3(expectedPossessions),
  };
}

function simulateScoringOutcomes({
  count,
  seed,
  expectedPossessions,
  touchdownDriveRate,
  fieldGoalAttemptRate,
  passingTouchdownShare,
  fieldGoalMakeRate,
  extraPointMakeRate,
  defensiveTouchdownRate,
}) {
  const random = createSeededRandom(seed);
  const outcomes = [];

  for (let simulation = 0; simulation < count; simulation += 1) {
    const possessions = stochasticRound(expectedPossessions, random);
    let passingTD = 0;
    let rushingTD = 0;
    let defensiveTD = random() < defensiveTouchdownRate ? 1 : 0;
    let fieldGoalAttempts = 0;
    let fieldGoals = 0;

    for (let drive = 0; drive < possessions; drive += 1) {
      const outcome = random();

      if (outcome < touchdownDriveRate) {
        if (random() < passingTouchdownShare) passingTD += 1;
        else rushingTD += 1;
        continue;
      }

      if (outcome < touchdownDriveRate + fieldGoalAttemptRate) {
        fieldGoalAttempts += 1;
        if (random() < fieldGoalMakeRate) fieldGoals += 1;
      }
    }

    // Defensive scores are deliberately limited to one representative event.
    defensiveTD = Math.min(defensiveTD, 1);
    fieldGoals = Math.min(fieldGoals, 4);
    fieldGoalAttempts = Math.max(fieldGoals, Math.min(fieldGoalAttempts, 5));

    const touchdowns = passingTD + rushingTD + defensiveTD;
    let extraPoints = 0;
    for (let attempt = 0; attempt < touchdowns; attempt += 1) {
      if (random() < extraPointMakeRate) extraPoints += 1;
    }

    const twoPoint = 0;
    const safeties = 0;
    const score =
      touchdowns * 6 +
      fieldGoals * 3 +
      extraPoints +
      twoPoint * 2 +
      safeties * 2;

    outcomes.push({
      score,
      passingTD,
      rushingTD,
      defensiveTD,
      fieldGoals,
      fieldGoalAttempts,
      extraPoints,
      twoPoint,
      safeties,
    });
  }

  return outcomes;
}

function selectRepresentativeSimulation(simulations, targetPoints) {
  const averages = averageSimulationEvents(simulations);
  let best = simulations[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of simulations) {
    const distance =
      Math.abs(candidate.score - targetPoints) * 2.5 +
      Math.abs(candidate.passingTD - averages.passingTD) * 1.2 +
      Math.abs(candidate.rushingTD - averages.rushingTD) * 1.15 +
      Math.abs(candidate.defensiveTD - averages.defensiveTD) * 1.8 +
      Math.abs(candidate.fieldGoals - averages.fieldGoals) * 1.1 +
      Math.abs(candidate.extraPoints - averages.extraPoints) * 0.4;

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function averageSimulationEvents(simulations) {
  const totals = simulations.reduce(
    (result, simulation) => ({
      passingTD: result.passingTD + simulation.passingTD,
      rushingTD: result.rushingTD + simulation.rushingTD,
      defensiveTD: result.defensiveTD + simulation.defensiveTD,
      fieldGoals: result.fieldGoals + simulation.fieldGoals,
      extraPoints: result.extraPoints + simulation.extraPoints,
    }),
    { passingTD: 0, rushingTD: 0, defensiveTD: 0, fieldGoals: 0, extraPoints: 0 }
  );

  const divisor = Math.max(1, simulations.length);
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, value / divisor])
  );
}

function stochasticRound(value, random) {
  const lower = Math.floor(value);
  return lower + (random() < value - lower ? 1 : 0);
}

function createSeededRandom(seedValue) {
  let seed = 2166136261;
  const text = String(seedValue || "fourth-down");

  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }

  return function random() {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function calculateWinProbability(projectedMargin, modelLayers, market) {
  const layers = Object.values(modelLayers || {}).filter(
    (layer) => layer && typeof layer === "object" && "confidence" in layer
  );
  const available = layers.filter((layer) => layer.available !== false && Number(layer.confidence) > 0);
  const active = available.filter((layer) => layer.active);
  const meanConfidence = available.length
    ? available.reduce((sum, layer) => sum + Number(layer.confidence || 0), 0) / available.length
    : 0.35;
  const coverage = Math.min(1, available.length / 12);
  const dataQuality = clamp(meanConfidence * 0.6 + coverage * 0.4, 0.25, 0.9);
  const marketReliability = market?.active ? clamp(Number(market.reliability || 0), 0, 1) : 0;
  const effectiveMargin = projectedMargin * (0.78 + dataQuality * 0.22);
  const rawHome = 1 / (1 + Math.exp(-effectiveMargin / 6.5));
  const home = clamp(0.5 + (rawHome - 0.5) * (0.72 + dataQuality * 0.28), 0.08, 0.92);
  const reasons = [
    `${active.length} active model layers`,
    `${Math.round(dataQuality * 100)}% data-quality score`,
  ];
  if (marketReliability > 0) reasons.push(`${Math.round(marketReliability * 100)}% market reliability`);
  if (Math.abs(projectedMargin) <= 3) reasons.push("Projected margin is three points or fewer");
  const favourite = Math.max(home, 1 - home);
  return {
    home: round3(home),
    away: round3(1 - home),
    dataQuality: round3(dataQuality),
    confidenceLabel: favourite >= 0.72 ? "High" : favourite >= 0.6 ? "Medium" : "Low",
    reasons,
  };
}

function confidenceLabel(margin) {
  if (margin <= 3) return "Coin flip";
  if (margin <= 7) return "Slight lean";
  if (margin <= 14) return "Favoured";
  return "Strong edge";
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
  return aliases[normalized] || normalized;
}

function formatSigned(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

function expClamp(logEffect, min, max) { return clamp(Math.exp(logEffect), min, max); }
function num(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function nullableNum(value) { const n = Number(value); return value == null || !Number.isFinite(n) ? null : n; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function clampInt(value, min, max) { return Math.min(max, Math.max(min, Math.round(value))); }
function round3(value) { return Math.round(value * 1000) / 1000; }
