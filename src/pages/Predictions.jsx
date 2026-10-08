import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleHelp, CloudSun, MapPin, Swords, Wind, XCircle } from "lucide-react";
import TeamLogo from "../components/TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import {
  hasMigratedSharedLedger,
  migrateLocalPredictionLedger,
  readPredictionLedger,
  refreshPredictionLedger,
  savePredictionSnapshot,
  isCurrentCompletePrediction,
  CURRENT_MODEL_KEY,
  CURRENT_MODEL_VERSION,
} from "../services/predictionLedger.js";
import { findOddsForGame, getNflOdds } from "../services/oddsApi.js";
import { getFullGamePrediction } from "../services/gamePredictionService.js";
import { getPlayerRating, resolveFullPlayerName } from "../services/playerRatings.js";
import { getStadiumWeather } from "../services/weatherApi.js";

const SEASON = 2026;
const SCHEDULE_CACHE_PREFIX = "fourth-down:schedule";
const SCHEDULE_CACHE_TTL_MS = 15 * 60 * 1000;
const pendingScheduleRequests = new Map();

export default function Predictions({ onOpen }) {
  const availableWeek = getCurrentWeek();
  const [week, setWeek] = useState(() => availableWeek);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState("Loading predictions...");

  useEffect(() => {
    if (week > availableWeek) setWeek(availableWeek);
  }, [week, availableWeek]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadPredictions() {
      setStatus(`Loading Week ${week} predictions...`);

      try {
        const cachedSchedule = readScheduleCache(SEASON, week);
        const [scheduleResult, oddsResult] = await Promise.allSettled([
          fetchSchedule(SEASON, week, controller.signal),
          getNflOdds(controller.signal),
        ]);

        const liveSchedule =
          scheduleResult.status === "fulfilled"
            ? scheduleResult.value
            : null;

        const mergedSchedule = mergeSchedulePayloads(
          liveSchedule,
          cachedSchedule
        );

        const scheduleGames = extractScheduleGames(mergedSchedule)
          .map(mapScheduleGame)
          .filter(
            (game) =>
              game.away &&
              game.home &&
              Number(game.week) === Number(week)
          );

        // Weather must be loaded for the Predictions page itself. Do not rely
        // on opening Matchup or on an older shared snapshot containing weather.
        const games = await mapWithConcurrency(
          scheduleGames,
          4,
          async (game) => {
            if (game.weather) return game;
            if (!game.home || !game.sourceDate) return game;

            try {
              const weather = await getStadiumWeather(
                game.home,
                game.sourceDate,
                controller.signal
              );

              return {
                ...game,
                weather: weather || null,
              };
            } catch (error) {
              if (error?.name === "AbortError") throw error;
              console.warn(
                `Weather unavailable for ${game.away} at ${game.home}`,
                error
              );
              return game;
            }
          }
        );

        if (!games.length) {
          if (scheduleResult.status === "rejected") {
            throw scheduleResult.reason;
          }

          throw new Error(`No schedule games were returned for Week ${week}`);
        }

        if (scheduleResult.status === "fulfilled") {
          writeScheduleCache(SEASON, week, mergedSchedule);
        }

        const oddsEvents =
          oddsResult.status === "fulfilled" &&
          Array.isArray(oddsResult.value)
            ? oddsResult.value
            : [];

        let ledger = readPredictionLedger();

        const initialRows = games.map((game) => {
          const saved = findLedgerRow(ledger, game);
          if (saved) {
            return enrichSavedPredictionWithCurrentMarket(saved, game, oddsEvents);
          }

          return buildMarketFallback(
            game,
            oddsEvents,
            new Error("Full model is loading")
          );
        });

        if (active) {
          setRows(initialRows);
          setStatus(`Calculating ${games.length} Week ${week} predictions...`);
        }

        if (!hasMigratedSharedLedger()) {
          void migrateLocalPredictionLedger().catch((sharedError) => {
            console.warn("Initial shared-ledger migration failed", sharedError);
          });
        }

        try {
          await refreshPredictionLedger({
            season: SEASON,
            week,
            signal: controller.signal,
          });
          ledger = readPredictionLedger();

          if (active) {
            const sharedRows = games.map((game) => {
              const saved = findLedgerRow(ledger, game);
              return saved
                ? enrichSavedPredictionWithCurrentMarket(saved, game, oddsEvents)
                : buildMarketFallback(
                    game,
                    oddsEvents,
                    new Error("Full model is loading")
                  );
            });
            setRows(sharedRows);
          }
        } catch (sharedError) {
          if (sharedError?.name !== "AbortError") {
            console.warn("Shared prediction sync failed; local cache retained", sharedError);
          }
        }

        const scheduleRows = await mapWithConcurrency(
          games,
          3,
          async (game) => {
            const saved = findLedgerRow(ledger, game);
            const kickoffTime = new Date(
              saved?.kickoff || game.sourceDate || 0
            ).getTime();
            const gameHasStarted =
              Number.isFinite(kickoffTime) &&
              kickoffTime > 0 &&
              Date.now() >= kickoffTime;

            if (
              hasSavedPrediction(saved) &&
              (
                gameHasStarted ||
                (isCurrentCompletePrediction(saved) && hasClearPlayerPropLabels(saved))
              )
            ) {
              return {
                ...enrichSavedPredictionWithCurrentMarket(saved, game, oddsEvents),
                kickoff: game.sourceDate || saved.kickoff,
              };
            }

            try {
              const generated = await buildFullPredictionRow(
                game,
                oddsEvents,
                controller.signal
              );
              savePredictionSnapshot(generated);
              if (active) {
                setRows((currentRows) =>
                  mergePredictionRows([generated], currentRows)
                );
              }
              return generated;
            } catch (error) {
              console.error(
                `Full prediction generation failed for ${game.away} at ${game.home}`,
                error
              );

              if (saved) {
                return enrichSavedPredictionWithCurrentMarket(saved, game, oddsEvents);
              }

              return buildMarketFallback(game, oddsEvents, error);
            }
          }
        );

        const ledgerRows = ledger
          .filter((row) => Number(row.week) === Number(week))
          .map(mapLedgerPrediction);

        const generated = mergePredictionRows(scheduleRows, ledgerRows);

        if (!active) return;

        setRows(generated);

        const failedCount = generated.filter(
          (row) => row.source === "full-model-error"
        ).length;

        setStatus(
          failedCount > 0
            ? `${generated.length} games loaded for Week ${week}. ${failedCount} could not complete the full model.`
            : `${generated.length} games loaded for Week ${week}`
        );
      } catch (error) {
        if (error?.name === "AbortError" || !active) return;

        console.error("Predictions loading failed", error);

        const savedRows = readPredictionLedger()
          .filter((row) => Number(row.week) === Number(week))
          .map(mapLedgerPrediction);

        setRows(savedRows);
        setStatus(
          error instanceof Error
            ? `${error.message}. Showing saved predictions.`
            : "Showing saved predictions."
        );
      }
    }

    loadPredictions();

    return () => {
      active = false;
      controller.abort();
    };
  }, [week]);

  const predictions = useMemo(() => rows, [rows]);
  const weeklyParlay = useLockedWeeklyParlay(predictions, week, availableWeek);

  const filtered = predictions.filter((row) => {
    if (filter === "agree") {
      return row.oddsPick && row.oddsPick === row.fourthDownPick;
    }

    if (filter === "disagree") {
      return row.oddsPick && row.oddsPick !== row.fourthDownPick;
    }

    if (filter === "close") {
      return projectedMargin(row) <= 3;
    }

    return true;
  });

  const agreement = predictions.filter(
    (row) => row.oddsPick && row.oddsPick === row.fourthDownPick
  ).length;

  const disagreement = predictions.filter(
    (row) => row.oddsPick && row.oddsPick !== row.fourthDownPick
  ).length;

  const closeGames = predictions.filter(
    (row) => projectedMargin(row) <= 3
  ).length;

  return (
    <section className="predictions-page">
      <div className="section-heading predictions-heading">
        <div>
          <span className="eyebrow">WEEKLY FORECAST</span>
          <h1>Predictions</h1>
          <p>
            Fourth Down&apos;s current picks and projected scores before
            kickoff.
          </p>
        </div>

        <div className="predictions-filters">
          <label>
            Week
            <select
              value={week}
              onChange={(event) => setWeek(Number(event.target.value))}
            >
              {Array.from({ length: availableWeek }, (_, index) => index + 1).map(
                (value) => (
                  <option key={value} value={value}>
                    Week {value}
                  </option>
                )
              )}
            </select>
          </label>

          <label>
            View
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All predictions</option>
              <option value="agree">Market agreement</option>
              <option value="disagree">Market disagreement</option>
              <option value="close">Close games</option>
            </select>
          </label>
        </div>
      </div>

      {week === availableWeek && (
        <WeeklyParlay parlay={weeklyParlay} week={week} />
      )}

      <div className="predictions-summary-grid">
        <PredictionSummary
          icon={<Swords size={20} />}
          label="Upcoming predictions"
          value={predictions.length}
        />
        <PredictionSummary
          icon={<CheckCircle2 size={20} />}
          label="Market agreement"
          value={agreement}
        />
        <PredictionSummary
          icon={<CircleHelp size={20} />}
          label="Market disagreement"
          value={disagreement}
        />
        <PredictionSummary
          icon={<CircleHelp size={20} />}
          label="Projected close games"
          value={closeGames}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="card empty predictions-empty">
          <h2>No predictions available</h2>
          <p>{status}</p>
        </div>
      ) : (
        <div className="predictions-game-grid">
          {[...filtered].sort(sortPredictions).map((prediction) => (
            <PredictionCard
              key={
                prediction.id ||
                matchupKey(
                  prediction.week,
                  prediction.awayCode,
                  prediction.homeCode
                )
              }
              prediction={prediction}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}

      <div className="schedule-status">{status}</div>

      <p className="prediction-note predictions-storage-note">
        Upcoming games recalculate with current odds, current-season form,
        player ratings, injuries, nflverse metrics and opponent-network data.
        Predictions freeze at kickoff for grading and sync to the shared Supabase ledger for every device.
      </p>
    </section>
  );
}

async function buildFullPredictionRow(game, oddsEvents, signal) {
  const oddsEvent = findOddsForGame(oddsEvents, game);
  const fullResult = await getFullGamePrediction(game, oddsEvent, {
    season: SEASON,
    week: Number(game.week),
    signal,
  });
  const prediction = fullResult.prediction;
  const marketAway = finiteNumberOrNull(prediction.market?.awayExpected);
  const marketHome = finiteNumberOrNull(prediction.market?.homeExpected);
  const oddsPick =
    marketAway === null || marketHome === null
      ? null
      : marketAway > marketHome
        ? game.away
        : marketHome > marketAway
          ? game.home
          : null;

  return {
    id: `${Number(game.week) || 0}:${game.away}:${game.home}:${game.sourceDate || "unknown"}`,
    source: "shared-full-model",
    dataQuality: {
      ...fullResult.dataQuality,
      modelVersion: CURRENT_MODEL_VERSION,
      modelKey: CURRENT_MODEL_KEY,
      predictionPayload: prediction,
      weather: fullResult.weather || game.weather || null,
      bestBets: fullResult.bestBets || null,
      bestBetsPayload: fullResult.bestBets || null,
    },
    playerProjections: fullResult.playerProjections || null,
    bestBets: fullResult.bestBets || null,
    game: {
      ...game,
      weather: fullResult.weather || game.weather || null,
      oddsEvent,
    },
    week: Number(game.week),
    kickoff: game.sourceDate,
    awayCode: game.away,
    homeCode: game.home,
    fourthDownPick: prediction.winner,
    fourthDownAwayScore: prediction.away.score,
    fourthDownHomeScore: prediction.home.score,
    oddsPick,
    marketAwayScore: marketAway,
    marketHomeScore: marketHome,
    fourthDownAwayWinProbability: prediction.awayWinProbability,
    fourthDownHomeWinProbability: prediction.homeWinProbability,
    fourthDownWinnerProbability: prediction.winnerWinProbability,
    projectedTie: Boolean(prediction.projectedTie),
    continuousMargin: finiteNumberOrNull(prediction.continuousMargin),
    confidenceScore: prediction.confidenceScore,
    confidenceLabel: prediction.confidence,
    marketGameTotal: finiteNumberOrNull(prediction.market?.total),
    marketSpread: finiteNumberOrNull(prediction.market?.homeSpread),
    modelVersion: CURRENT_MODEL_VERSION,
    modelKey: CURRENT_MODEL_KEY,
    predictionPayload: prediction,
    generatedAt: fullResult.generatedAt || new Date().toISOString(),
    savedBeforeKickoff:
      Number.isFinite(new Date(game.sourceDate).getTime()) &&
      Date.now() < new Date(game.sourceDate).getTime(),
    snapshotAt: new Date().toISOString(),
    actualAwayScore: null,
    actualHomeScore: null,
    actualWinner: null,
  };
}

function buildMarketFallback(game, oddsEvents, error) {
  const oddsEvent = findOddsForGame(oddsEvents, game);
  const market = getMarketExpectedScores(oddsEvent);
  const awayScore = market.away;
  const homeScore = market.home;
  const winner =
    awayScore === null || homeScore === null || awayScore === homeScore
      ? null
      : awayScore > homeScore
        ? game.away
        : game.home;

  return {
    id: `${Number(game.week) || 0}:${game.away}:${game.home}:${game.sourceDate || "unknown"}`,
    source: "full-model-error",
    game: { ...game, oddsEvent },
    week: Number(game.week),
    kickoff: game.sourceDate,
    awayCode: game.away,
    homeCode: game.home,
    fourthDownPick: winner,
    fourthDownAwayScore: awayScore === null ? null : Math.round(awayScore),
    fourthDownHomeScore: homeScore === null ? null : Math.round(homeScore),
    oddsPick: winner,
    marketAwayScore: awayScore,
    marketHomeScore: homeScore,
    actualAwayScore: null,
    actualHomeScore: null,
    actualWinner: null,
    modelError: error instanceof Error ? error.message : String(error),
  };
}

function PredictionCard({ prediction, onOpen }) {
  const [activeTab, setActiveTab] = useState("prediction");
  const awayTheme = getTeamTheme(prediction.awayCode);
  const homeTheme = getTeamTheme(prediction.homeCode);
  const style = {
    "--away-primary": awayTheme["--team-primary"],
    "--away-secondary": awayTheme["--team-secondary"],
    "--away-watermark": awayTheme["--team-watermark"],
    "--home-primary": homeTheme["--team-primary"],
    "--home-secondary": homeTheme["--team-secondary"],
    "--home-watermark": homeTheme["--team-watermark"],
  };
  const agrees =
    prediction.oddsPick &&
    prediction.oddsPick === prediction.fourthDownPick;
  const isFinal = hasFinalResult(prediction);
  const awayScore = isFinal
    ? prediction.actualAwayScore
    : prediction.fourthDownAwayScore;
  const homeScore = isFinal
    ? prediction.actualHomeScore
    : prediction.fourthDownHomeScore;
  const projectedTie =
    !isFinal &&
    Number(prediction.fourthDownAwayScore) ===
      Number(prediction.fourthDownHomeScore);
  const currentWeek = getCurrentWeek();
  const bestBetsAvailable =
    !isFinal && Number(prediction.week) === Number(currentWeek);

  return (
    <article className="card predictions-game-card" style={style}>
      <span className="predictions-away-watermark" aria-hidden="true" />
      <span className="predictions-home-watermark" aria-hidden="true" />
      <span className="predictions-centre-line" aria-hidden="true" />

      <div className="game-meta predictions-game-meta">
        <span>Regular season · Week {prediction.week}</span>
        <strong>{isFinal ? "FINAL" : formatKickoff(prediction.kickoff)}</strong>
      </div>

      <div
        className="prediction-card-tabs"
        role="tablist"
        aria-label="Game card view"
        style={{ gridTemplateColumns: bestBetsAvailable ? "1fr 1fr" : "1fr" }}
      >
        <button
          type="button"
          className={activeTab === "prediction" ? "active" : ""}
          onClick={() => setActiveTab("prediction")}
          role="tab"
          aria-selected={activeTab === "prediction"}
        >
          Prediction
        </button>
        {bestBetsAvailable && (
          <button
            type="button"
            className={activeTab === "best-bets" ? "active" : ""}
            onClick={() => setActiveTab("best-bets")}
            role="tab"
            aria-selected={activeTab === "best-bets"}
          >
            Best Bets
            {prediction.bestBets?.qualified > 0 && (
              <span>{prediction.bestBets.qualified}</span>
            )}
          </button>
        )}
      </div>
      {!bestBetsAvailable && (
        <p style={{ margin: "0 0 12px", opacity: 0.62, fontSize: "11px" }}>
          Best Bets are available for the current week only.
        </p>
      )}
      {activeTab === "prediction" || !bestBetsAvailable ? (
        <>
      <div className="predictions-scoreboard">
        <PredictionTeam
          code={prediction.awayCode}
          score={awayScore}
          picked={
            normalizeTeamCode(
              isFinal ? prediction.actualWinner : prediction.fourthDownPick
            ) === normalizeTeamCode(prediction.awayCode)
          }
          side="away"
        />

        <div className="predictions-score-divider">
          <small>{isFinal ? "FINAL" : "PROJECTED"}</small>
          <strong>
            {displayScore(awayScore)} - {displayScore(homeScore)}
          </strong>
          <span>
            {isFinal
              ? `${prediction.actualWinner} WON`
              : prediction.source === "full-model-error"
                ? "MODEL FALLBACK"
                : projectedTie
                  ? "PROJECTED TIE"
                  : projectedMargin(prediction) <= 3
                    ? "CLOSE GAME"
                    : "FOURTH DOWN"}
          </span>
        </div>

        <PredictionTeam
          code={prediction.homeCode}
          score={homeScore}
          picked={
            normalizeTeamCode(
              isFinal ? prediction.actualWinner : prediction.fourthDownPick
            ) === normalizeTeamCode(prediction.homeCode)
          }
          side="home"
        />
      </div>

      <div
        className="predictions-game-details"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "10px",
          margin: "14px 0",
          padding: "12px 14px",
          borderTop: "1px solid rgba(255,255,255,0.16)",
          borderBottom: "1px solid rgba(255,255,255,0.16)",
        }}
      >
        <PredictionDetail
          icon={<MapPin size={16} />}
          label="Venue"
          value={prediction.game?.venue || "Venue unavailable"}
        />
        <PredictionDetail
          icon={<CloudSun size={16} />}
          label="Weather"
          value={formatPredictionWeather(prediction.game?.weather)}
        />
        <PredictionDetail
          icon={<Wind size={16} />}
          label="Wind"
          value={formatPredictionWind(prediction.game?.weather)}
        />
      </div>

      <div className="predictions-picks-grid">
        <PickPanel
          label={projectedTie && prediction.fourthDownPick ? "Fourth Down lean" : "Fourth Down pick"}
          code={prediction.fourthDownPick}
          fallbackValue={projectedTie ? "Projected tie" : "Not available"}
          detail={
            prediction.fourthDownWinnerProbability != null
              ? `${Math.round(prediction.fourthDownWinnerProbability * 100)}% win probability`
              : projectedTie
                ? "No team has an unrounded scoring advantage"
                : prediction.modelError || null
          }
        />
        <PickPanel label="Odds makers pick" code={prediction.oddsPick} />
        <div
          className={`predictions-pick-panel ${
            prediction.oddsPick
              ? agrees
                ? "agree"
                : "disagree"
              : "unavailable"
          }`}
        >
          <small>Market comparison</small>
          <strong>
            {prediction.oddsPick
              ? agrees
                ? "Agreement"
                : projectedTie
                  ? "Market lean differs"
                  : "Disagreement"
              : "Unavailable"}
          </strong>
          <span>
            {prediction.oddsPick
              ? agrees
                ? "Both favour the same team"
                : projectedTie
                  ? "Fourth Down projects a tied score"
                  : "Fourth Down sees it differently"
              : "No current market pick"}
          </span>
        </div>
      </div>

        </>
      ) : (
        <BestBetsPanel bestBets={prediction.bestBets} kickoff={prediction.kickoff} awayCode={prediction.awayCode} homeCode={prediction.homeCode} />
      )}
      {typeof onOpen === "function" && prediction.game && (
        <button
          type="button"
          className="predictions-open-button"
          style={{
            width: "100%",
            background: "#000",
            color: "#fff",
            border: "1px solid #fff",
            borderRadius: "8px",
            padding: "11px 16px",
            fontWeight: 800,
            cursor: "pointer",
          }}
          onClick={() => onOpen(prediction.game)}
        >
          Open matchup
        </button>
      )}
    </article>
  );
}

function BestBetsPanel({ bestBets, kickoff, awayCode, homeCode }) {
  const recommendations = bestBets?.recommendations || [];
  const started = Number.isFinite(new Date(kickoff || 0).getTime()) && Date.now() >= new Date(kickoff).getTime();
  return (
    <div className="best-bets-panel" role="tabpanel">
      <BestBetHighlights
        highlights={buildDisplayHighlights(bestBets)}
        awayCode={awayCode}
        homeCode={homeCode}
      />
      <AnytimeTdScorer scorer={bestBets?.anytimeTdScorer} awayCode={awayCode} homeCode={homeCode} />
      {bestBets?.marketDiagnostics?.playerMarkets === 0 && (
        <p className="best-bets-market-note">
          No player-prop prices were returned for this game, so only moneyline, spread and total markets could be assessed.
        </p>
      )}
      {bestBets?.marketDiagnostics?.playerMarkets > 0 && bestBets?.marketDiagnostics?.matchedPlayerMarkets === 0 && (
        <p className="best-bets-market-note">
          Player-prop prices were returned, but player names still did not match the projection feed. The provider and projection names are now included in the saved diagnostics.
        </p>
      )}
      {!recommendations.length ? (
        <div className="best-bets-empty">
          <strong>No Best Bets</strong>
          <span>{bestBets?.message || "No markets meet the model edge and expected-value thresholds for this matchup."}</span>
        </div>
      ) : (
        <div className="best-bets-list">
          {[...recommendations]
            .sort((a, b) => {
              const aGame = a.category === "Game" ? 1 : 0;
              const bGame = b.category === "Game" ? 1 : 0;
              return aGame - bGame || Number(a.rank || 0) - Number(b.rank || 0);
            })
            .map((bet) => (
            <article className="best-bet-card" key={`${bet.market}:${bet.selection}:${bet.sportsbook}`} style={getBetTeamStyle(bet, awayCode, homeCode)}>
              <div className="best-bet-heading">
                <div>
                  <small>{bet.category} · {bet.market}</small>
                  <strong>{formatFullPlayerSelection(bet.selection)}</strong>
                  {bet.rawMarketType && (
                    <em style={{ display: "block", marginTop: "3px", opacity: 0.55, fontSize: "8px", fontStyle: "normal" }}>
                      Provider market: {bet.rawMarketType} · Full game
                    </em>
                  )}
                </div>
                <span className="best-bet-price">{formatAustralianOdds(bet.decimalOdds, bet.price)}</span>
              </div>
              <div className="best-bet-metrics">
                <span><small>Model</small><strong>{formatPercent(bet.modelProbability)}</strong></span>
                <span><small>Market</small><strong>{formatPercent(bet.marketProbability)}</strong></span>
                <span><small>Edge</small><strong>+{formatPercent(bet.edge)}</strong></span>
                <span><small>Est. EV</small><strong>+{formatPercent(bet.expectedValue)}</strong></span>
              </div>
              <p>{bet.reason}</p>
              <p style={{ marginTop: "8px", padding: "9px", borderRadius: "8px", background: "rgba(255,255,255,0.06)" }}>
                <strong>Why it qualified:</strong> {bet.qualificationReason}
              </p>
              <small style={{ display: "inline-flex", margin: "2px 8px 5px 0", padding: "4px 8px", borderRadius: "999px", background: bet.confidenceLevel === "High" ? "#b9ff55" : bet.confidenceLevel === "Medium" ? "#ffd166" : "#ff9f6e", color: "#090b08", fontWeight: 900 }}>
                {bet.confidenceLevel || "Cautious"} confidence
              </small>
              <small className="best-bet-risk">Risk: {bet.risk}</small>
              <footer>{bet.sportsbook || "Market"}{bet.updatedAt ? ` · Updated ${formatOddsTime(bet.updatedAt)}` : ""}</footer>
            </article>
))}
</div>
      )}
      <p className="best-bets-disclaimer">Model-based market comparison only. Odds can move and no outcome is guaranteed.</p>
    </div>
  );
}

function buildDisplayHighlights(bestBets) {
  const stored = bestBets?.highlights || {};
  const pool = [
    ...(bestBets?.recommendations || []),
    stored.mostLikely,
    stored.bestValue,
    stored.longshot,
  ].filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const bet of pool) {
    const key = [bet.market, bet.selection, bet.sportsbook].join(":");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(bet);
    }
  }
  if (!unique.length) return { mostLikely: null, bestValue: null, longshot: null };

  const playerBets = unique.filter((bet) => bet.category !== "Game");
  const likelyPool = playerBets.length ? playerBets : unique;
  const mostLikely = [...likelyPool].sort(
    (a, b) => Number(b.modelProbability || 0) - Number(a.modelProbability || 0)
  )[0] || unique[0];
  const afterLikely = unique.filter((bet) => bet !== mostLikely);
  const bestValue = [...afterLikely].sort(
    (a, b) => Number(b.expectedValue || 0) - Number(a.expectedValue || 0)
  )[0] || mostLikely;
  const afterValue = unique.filter((bet) => bet !== mostLikely && bet !== bestValue);
  const longshot = [...afterValue].sort((a, b) => {
    const aFive = Number(a.decimalOdds || 0) >= 5 ? 1 : 0;
    const bFive = Number(b.decimalOdds || 0) >= 5 ? 1 : 0;
    return bFive - aFive || Number(b.decimalOdds || 0) - Number(a.decimalOdds || 0);
  })[0] || bestValue || mostLikely;

  return {
    mostLikely: { ...mostLikely, highlightExplanation: "Highest model probability among the available markets" },
    bestValue: {
      ...bestValue,
      highlightExplanation: bestValue === mostLikely
        ? "Only available selection, reused so Best Value is never empty"
        : "Highest estimated value among the remaining available markets",
    },
    longshot: {
      ...longshot,
      highlightExplanation: longshot === bestValue || longshot === mostLikely
        ? "Best available fallback, reused so Longshot is never empty"
        : Number(longshot.decimalOdds) >= 5
          ? "Highest-priced separate selection at $5.00 or higher"
          : "Highest-priced separate selection available",
    },
  };
}

function displayBetFamily(bet) {
  if (bet?.category === "Game") return "game";
  const market = String(bet?.market || "").toLowerCase();
  if (market.includes("touchdown")) return "touchdown";
  if (market.includes("passing")) return "passing";
  if (market.includes("rushing")) return "rushing";
  if (market.includes("receiving") || market.includes("reception")) return "receiving";
  return market || "player";
}

function AnytimeTdScorer({ scorer, awayCode, homeCode }) {
  const selection = scorer?.selection || "No eligible scorer projection";
  const modelProbability = Number(scorer?.modelProbability || 0);
  const decimalOdds = Number(scorer?.decimalOdds);
  const americanPrice = Number(scorer?.price);
  const hasPrice =
    (Number.isFinite(decimalOdds) && decimalOdds > 1) ||
    (Number.isFinite(americanPrice) && americanPrice !== 0);

  return (
    <article
      className="best-bet-card"
      style={{
        ...getBetTeamStyle(scorer, awayCode, homeCode),
        marginBottom: "12px",
      }}
    >
      <div className="best-bet-heading">
        <div>
          <small style={{ color: "#ffad5c" }}>ANYTIME TD SCORER</small>
          <strong>{selection}</strong>
        </div>
        <span className="best-bet-price">
          {hasPrice
            ? formatAustralianOdds(scorer.decimalOdds, scorer.price)
            : "Model pick"}
        </span>
      </div>
      <div className="best-bet-metrics" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <span><small>TD chance</small><strong>{formatPercent(modelProbability)}</strong></span>
        <span><small>Confidence</small><strong>{scorer?.confidenceLevel || "Cautious"}</strong></span>
        <span><small>Price</small><strong>{hasPrice ? formatAustralianOdds(scorer.decimalOdds, scorer.price) : "Unavailable"}</strong></span>
      </div>
      <p>{scorer?.explanation || "No player touchdown projection was available."}</p>
      {scorer?.qualificationReason && (
        <p style={{ marginTop: "8px", padding: "9px", borderRadius: "8px", background: "rgba(255,255,255,0.06)" }}>
          <strong>Why this scorer:</strong> {scorer.qualificationReason}
        </p>
      )}
      <small className="best-bet-risk">Risk: {scorer?.risk || "Touchdowns are high-variance events."}</small>
    </article>
  );
}

function BestBetHighlights({ highlights, awayCode, homeCode }) {
  const items = [
    ["Most likely", highlights?.mostLikely],
    ["Best value", highlights?.bestValue],
    ["Longshot", highlights?.longshot],
  ];
  return (
    <div className="best-bet-highlights">
      {items.map(([label, bet]) => (
        <div className={`best-bet-highlight best-bet-highlight-${label.toLowerCase().replace(/\s+/g, "-")}`} key={label} style={bet ? getBetTeamStyle(bet, awayCode, homeCode) : undefined}>
          <small>{label}</small>
          {bet ? (
            <>
              <strong>{formatFullPlayerSelection(bet.selection)}</strong>
              <span>{formatAustralianOdds(bet.decimalOdds, bet.price)} · {formatPercent(bet.modelProbability)} model chance</span>
              <p>{bet.highlightExplanation}</p>
              {label === "Longshot" && Number(bet.decimalOdds) < 5 && (
                <em style={{ display: "block", marginTop: "5px", color: "#ffd166", fontSize: "9px" }}>
                  Fallback: below the preferred $5.00 threshold
                </em>
              )}
            </>
          ) : (
            <>
              <strong>None qualified</strong>
              <span>{label === "Longshot" ? "No separate market priced at $5.00 or higher was returned for this game" : "No qualifying selection"}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const BET_TEAM_COLOURS = {
  ARI: ["#97233F", "#000000"], ATL: ["#A71930", "#000000"], BAL: ["#241773", "#000000"],
  BUF: ["#00338D", "#C60C30"], CAR: ["#0085CA", "#101820"], CHI: ["#0B162A", "#C83803"],
  CIN: ["#FB4F14", "#000000"], CLE: ["#311D00", "#FF3C00"], DAL: ["#041E42", "#869397"],
  DEN: ["#FB4F14", "#002244"], DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"],
  HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#A2AAAD"], JAX: ["#006778", "#D7A22A"],
  KC: ["#E31837", "#FFB81C"], LV: ["#000000", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"],
  LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"], MIN: ["#4F2683", "#FFC62F"],
  NE: ["#002244", "#C60C30"], NO: ["#D3BC8D", "#101820"], NYG: ["#0B2265", "#A71930"],
  NYJ: ["#125740", "#000000"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#101820", "#FFB612"],
  SF: ["#AA0000", "#B3995D"], SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#34302B"],
  TEN: ["#0C2340", "#4B92DB"], WSH: ["#5A1414", "#FFB612"],
};

function getBetTeamStyle(bet, awayCode, homeCode) {
  const teamCode = resolveBetTeamCode(bet, awayCode, homeCode);
  const colours = BET_TEAM_COLOURS[teamCode];
  if (!colours) return undefined;
  const [primary, secondary] = colours;
  return {
    borderColor: secondary,
    background: `linear-gradient(135deg, ${hexToRgba(primary, 0.94)} 0%, ${hexToRgba(primary, 0.82)} 58%, ${hexToRgba(secondary, 0.48)} 100%)`,
    boxShadow: `inset 5px 0 0 ${secondary}`,
  };
}

function resolveBetTeamCode(bet, awayCode, homeCode) {
  const direct = normalizeTeamCode(bet?.team || bet?.teamCode || bet?.teamAbbreviation);
  if (BET_TEAM_COLOURS[direct]) return direct;

  const playerName = extractPlayerNameFromSelection(bet?.selection);
  if (playerName) {
    const rating = getPlayerRating(playerName);
    const ratedTeam = normalizeTeamCode(rating?.team);
    if (BET_TEAM_COLOURS[ratedTeam]) return ratedTeam;
  }

  const selection = String(bet?.selection || "").toUpperCase();
  const away = normalizeTeamCode(awayCode);
  const home = normalizeTeamCode(homeCode);
  if (away && selection.includes(away)) return away;
  if (home && selection.includes(home)) return home;
  return null;
}

function extractPlayerNameFromSelection(selection) {
  return String(selection || "")
    .replace(/\s+(?:anytime TD|over|under)\b.*$/i, "")
    .trim();
}

function hexToRgba(hex, alpha) {
  const value = String(hex || "").replace("#", "");
  const integer = Number.parseInt(value, 16);
  return `rgba(${(integer >> 16) & 255}, ${(integer >> 8) & 255}, ${integer & 255}, ${alpha})`;
}

function formatFullPlayerSelection(value) {
  const text = String(value || "");
  const suffixMatch = text.match(/(\s+(?:anytime TD|over|under)\b.*)$/i);
  const suffix = suffixMatch?.[1] || "";
  const playerName = suffix ? text.slice(0, -suffix.length).trim() : text.trim();
  const resolved = resolveFullPlayerName(playerName);
  return `${resolved || playerName}${suffix}`;
}

function formatAustralianOdds(decimalOdds, americanPrice) {
  let decimal = Number(decimalOdds);
  if (!Number.isFinite(decimal)) {
    const price = Number(americanPrice);
    if (!Number.isFinite(price)) return "Odds unavailable";
    decimal = price > 0
      ? 1 + price / 100
      : 1 + 100 / Math.abs(price);
  }
  return `$${decimal.toFixed(2)}`;
}
function formatPercent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function formatOddsTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function PredictionTeam({ code, score, picked, side }) {
  return (
    <div
      className={`predictions-team predictions-team-${side}${
        picked ? " picked" : ""
      }`}
    >
      <span className="predictions-logo-stage">
        <TeamLogo team={code} size={108} />
      </span>
      <strong>{teamName(code)}</strong>
      <small
        className={`predictions-home-away-tag predictions-home-away-tag-${side}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: "4px",
          padding: "3px 9px",
          borderRadius: "999px",
          background: "rgba(0,0,0,0.62)",
          border: "1px solid rgba(255,255,255,0.2)",
          color: "#fff",
          fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {side === "away" ? "Away" : "Home"}
      </small>
      <span className="predictions-team-score">{displayScore(score)}</span>
      {picked && <span className="predictions-pick-pill">PICK</span>}
    </div>
  );
}

function PickPanel({ label, code, detail, fallbackValue = "Not available" }) {
  return (
    <div className="predictions-pick-panel">
      <small>{label}</small>
      <strong>{code ? teamName(code) : fallbackValue}</strong>
      <span>{detail || code || "No saved pick"}</span>
    </div>
  );
}

function PredictionDetail({ icon, label, value }) {
  return (
    <div
      className="predictions-game-detail"
      style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0 }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", color: "#ff8a00" }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <small style={{ display: "block", opacity: 0.72 }}>{label}</small>
        <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>
          {value}
        </strong>
      </div>
    </div>
  );
}

function formatPredictionWeather(weather) {
  if (!weather) return "Forecast unavailable";
  const temperature = finiteNumberOrNull(
    weather.temperature ?? weather.temperatureC ?? weather.temp_c
  );
  const condition =
    weather.condition || weather.description || weather.summary || weather.weather || null;
  const parts = [];
  if (temperature !== null) parts.push(`${Math.round(temperature)}°C`);
  if (condition) parts.push(String(condition));
  return parts.length ? parts.join(" · ") : "Forecast unavailable";
}

function formatPredictionWind(weather) {
  if (!weather) return "Wind unavailable";
  const speed = finiteNumberOrNull(
    weather.windKph ?? weather.wind_kph ?? weather.windSpeedKph ?? weather.windSpeed
  );
  const direction = weather.windDirection || weather.wind_dir || null;
  if (speed === null && !direction) return "Wind unavailable";
  return [speed === null ? null : `${Math.round(speed)} km/h`, direction]
    .filter(Boolean)
    .join(" · ");
}

const WEEKLY_PARLAY_STORAGE_PREFIX = "fourth-down:weekly-best-multi";

function useLockedWeeklyParlay(predictions, week, availableWeek) {
  const liveParlay = useMemo(() => week === availableWeek ? buildWeeklyParlay(predictions, week) : null, [predictions, week, availableWeek]);
  const [lockedParlay, setLockedParlay] = useState(null);
  useEffect(() => {
    if (week !== availableWeek) { setLockedParlay(null); return; }
    const key = `${WEEKLY_PARLAY_STORAGE_PREFIX}:${SEASON}:${week}`;
    const stored = readLockedWeeklyParlay(key);
    const isLocked = Date.now() >= getWeeklyParlayLockTime(week).getTime();

    if (!isLocked) {
      removeLockedWeeklyParlay(key);
      setLockedParlay({
        week,
        legs: [],
        decimalOdds: null,
        modelProbability: null,
        complete: false,
        locked: false,
      });
      return;
    }

    if (stored?.legs?.length) {
      const graded = gradeLockedWeeklyParlay(stored, predictions);
      setLockedParlay(graded);
      writeLockedWeeklyParlay(key, graded);
      return;
    }

    if (liveParlay?.complete) {
      const snapshot = { ...liveParlay, locked: true, lockedAt: new Date().toISOString(), legs: liveParlay.legs.map((leg) => ({ ...leg, result: "pending" })) };
      setLockedParlay(snapshot);
      writeLockedWeeklyParlay(key, snapshot);
      return;
    }

    setLockedParlay({
      week,
      legs: [],
      decimalOdds: null,
      modelProbability: null,
      complete: false,
      locked: true,
    });
  }, [predictions, week, availableWeek, liveParlay]);
  return lockedParlay;
}

function buildWeeklyParlay(predictions, week) {
  const candidates = [];
  const seen = new Set();
  for (const prediction of predictions || []) {
    for (const bet of prediction?.bestBets?.recommendations || []) {
      const decimalOdds = getDecimalOddsValue(bet);
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) continue;
      const key = [bet.market, bet.selection, bet.sportsbook].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...bet, decimalOdds, awayCode: prediction.awayCode, homeCode: prediction.homeCode, matchup: `${prediction.awayCode} at ${prediction.homeCode}`, matchupKey: matchupKey(prediction.week, prediction.awayCode, prediction.homeCode), kickoff: prediction.kickoff });
    }
  }
  const legs = candidates.sort((a, b) => weeklyParlayScore(b) - weeklyParlayScore(a)).slice(0, 5);
  return {
    week,
    legs,
    decimalOdds: legs.length ? legs.reduce((total, leg) => total * leg.decimalOdds, 1) : null,
    modelProbability: legs.length ? legs.reduce((total, leg) => total * Math.max(0, Math.min(1, Number(leg.modelProbability || 0))), 1) : null,
    complete: legs.length === 5,
  };
}

function getWeeklyParlayLockTime(week) {
  return new Date(Date.UTC(2026, 8, 8, 0, 0, 0) + (Number(week) - 1) * 7 * 86400000 + 2 * 86400000);
}
function readLockedWeeklyParlay(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeLockedWeeklyParlay(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the lock in memory. */ }
}
function removeLockedWeeklyParlay(key) {
  try { localStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ }
}
function gradeLockedWeeklyParlay(parlay, predictions) {
  const rows = new Map((predictions || []).map((row) => [matchupKey(row.week, row.awayCode, row.homeCode), row]));
  return { ...parlay, legs: (parlay.legs || []).map((leg) => ({ ...leg, result: gradeWeeklyParlayLeg(leg, rows.get(leg.matchupKey)) })) };
}
function gradeWeeklyParlayLeg(leg, prediction) {
  const explicit = String(leg.result || leg.status || leg.outcome || "").toLowerCase();
  if (["won", "win", "success", "successful", "hit"].includes(explicit)) return "won";
  if (["lost", "loss", "failed", "fail", "miss"].includes(explicit)) return "lost";
  if (!hasFinalResult(prediction)) return "pending";
  const awayScore = Number(prediction.actualAwayScore);
  const homeScore = Number(prediction.actualHomeScore);
  const market = String(leg.market || "").toLowerCase();
  const selection = String(leg.selection || "").toLowerCase();
  const line = Number(leg.line ?? leg.point ?? leg.handicap);
  if (market.includes("total") || selection.startsWith("over") || selection.startsWith("under")) {
    if (!Number.isFinite(line)) return "pending";
    const total = awayScore + homeScore;
    if (selection.includes("over")) return total > line ? "won" : total < line ? "lost" : "push";
    if (selection.includes("under")) return total < line ? "won" : total > line ? "lost" : "push";
  }
  const team = resolveSelectedTeam(leg);
  if (!team) return "pending";
  const selected = team === normalizeTeamCode(prediction.awayCode) ? awayScore : homeScore;
  const opponent = team === normalizeTeamCode(prediction.awayCode) ? homeScore : awayScore;
  if (market.includes("spread")) {
    if (!Number.isFinite(line)) return "pending";
    return selected + line > opponent ? "won" : selected + line < opponent ? "lost" : "push";
  }
  if (market.includes("moneyline") || market.includes("winner") || leg.category === "Game") return selected > opponent ? "won" : "lost";
  return "pending";
}
function resolveSelectedTeam(leg) {
  const direct = normalizeTeamCode(leg.team || leg.teamCode || leg.teamAbbreviation);
  if ([normalizeTeamCode(leg.awayCode), normalizeTeamCode(leg.homeCode)].includes(direct)) return direct;
  const selection = String(leg.selection || "").toUpperCase();
  if (selection.includes(normalizeTeamCode(leg.awayCode))) return normalizeTeamCode(leg.awayCode);
  if (selection.includes(normalizeTeamCode(leg.homeCode))) return normalizeTeamCode(leg.homeCode);
  return null;
}

function weeklyParlayScore(bet) {
  return (
    Number(bet.score || 0) * 0.5 +
    Number(bet.expectedValue || 0) * 0.3 +
    Number(bet.edge || 0) * 0.12 +
    Number(bet.modelProbability || 0) * 0.08
  );
}

function getDecimalOddsValue(bet) {
  const decimal = Number(bet?.decimalOdds);
  if (Number.isFinite(decimal)) return decimal;
  const american = Number(bet?.price);
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function WeeklyParlay({ parlay, week }) {
  const legs = parlay?.legs || [];
  return (
    <section
      className="card weekly-parlay-card"
      style={{
        position: "relative",
        marginBottom: "22px",
        padding: "22px",
        border: "1px solid rgba(185, 255, 85, 0.42)",
        borderRadius: "18px",
        background: "linear-gradient(145deg, rgba(10, 25, 30, .98), rgba(5, 11, 14, .99))",
        boxShadow: "0 18px 46px rgba(0, 0, 0, .26)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "start",
          gap: "24px",
          marginBottom: "20px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">WEEK {week}</span>
          <h2 style={{ margin: "7px 0 5px", fontSize: "clamp(1.3rem, 2.5vw, 1.75rem)" }}>
            Weekly Best Multi
          </h2>
          <p style={{ margin: 0, color: "rgba(255,255,255,.64)", fontSize: "12px" }}>
            The five strongest priced Best Bets across the week.
          </p>
        </div>

        <div
          style={{
            minWidth: "150px",
            padding: "13px 15px",
            border: "1px solid rgba(185,255,85,.24)",
            borderRadius: "13px",
            background: "rgba(185,255,85,.065)",
            textAlign: "right",
          }}
        >
          <small style={{ display: "block", color: "rgba(255,255,255,.58)", fontSize: "9px", fontWeight: 800, letterSpacing: ".08em" }}>
            COMBINED ODDS
          </small>
          <strong style={{ display: "block", marginTop: "3px", color: "#b9ff55", fontSize: "1.55rem", lineHeight: 1.05 }}>
            {parlay?.decimalOdds ? `$${parlay.decimalOdds.toFixed(2)}` : "Pending"}
          </strong>
          {parlay?.modelProbability !== null && parlay?.modelProbability !== undefined && (
            <span style={{ display: "block", marginTop: "6px", color: "rgba(255,255,255,.55)", fontSize: "9px" }}>
              {formatPercent(parlay.modelProbability)} model chance
            </span>
          )}
        </div>
      </div>

      {legs.length ? (
        <div style={{ display: "grid", gap: "11px" }}>
          {legs.map((bet, index) => {
            const result = bet.result || "pending";
            const resultColour = result === "won" ? "#43d17a" : result === "lost" ? "#ff5d68" : "#b9ff55";
            return (
            <article
              key={`${bet.market}:${bet.selection}:${bet.sportsbook}`}
              style={{
                ...getBetTeamStyle(bet, bet.awayCode, bet.homeCode),
                display: "grid",
                gridTemplateColumns: "44px minmax(0, 1fr) auto",
                alignItems: "center",
                gap: "14px",
                minHeight: "72px",
                padding: "12px 16px",
                border: "1px solid rgba(255,255,255,.14)",
                borderRadius: "12px",
              }}
            >
              <span
                style={{
                  display: "grid",
                  width: "30px",
                  height: "30px",
                  placeItems: "center",
                  borderRadius: "9px",
                  background: "rgba(0,0,0,.24)",
                  color: "#b9ff55",
                  fontSize: "12px",
                  fontWeight: 900,
                }}
              >
                {result === "won" ? (
                  <CheckCircle2 size={30} color="#43d17a" strokeWidth={3} aria-label="Successful leg" />
                ) : result === "lost" ? (
                  <XCircle size={30} color="#ff5d68" strokeWidth={3} aria-label="Failed leg" />
                ) : (
                  index + 1
                )}
              </span>

              <div style={{ minWidth: 0 }}>
                <small style={{ display: "block", color: "rgba(255,255,255,.68)", fontSize: "10px", lineHeight: 1.35 }}>
                  {bet.matchup} · {bet.market}
                </small>
                <strong style={{ display: "block", marginTop: "4px", color: "#fff", fontSize: "14px", lineHeight: 1.35 }}>
                  {formatFullPlayerSelection(bet.selection)}
                </strong>
                <span style={{ display: "block", marginTop: "4px", color: "rgba(255,255,255,.48)", fontSize: "9px" }}>
                  {bet.sportsbook || "Best available price"}
                </span>
                {result !== "pending" && (
                  <strong style={{ display: "block", marginTop: "6px", color: resultColour, fontSize: "11px", textTransform: "uppercase" }}>
                    {result === "won" ? "Successful" : result === "lost" ? "Failed" : "Push"}
                  </strong>
                )}
              </div>

              <strong
                style={{
                  minWidth: "66px",
                  padding: "8px 10px",
                  borderRadius: "9px",
                  background: "rgba(0,0,0,.25)",
                  color: "#fff",
                  fontSize: "14px",
                  textAlign: "center",
                }}
              >
                {formatAustralianOdds(bet.decimalOdds, bet.price)}
              </strong>
            </article>
);
})}
        </div>
      ) : (
        <div style={{ padding: "22px", border: "1px dashed rgba(255,255,255,.14)", borderRadius: "12px", color: "rgba(255,255,255,.6)", textAlign: "center" }}>
          Weekly Best Multi will be selected and locked at 10:00am AEST Thursday.
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px",
          marginTop: "15px",
          color: "rgba(255,255,255,.44)",
          fontSize: "9px",
        }}
      >
        <span>Same-game and correlated legs may not be accepted by every sportsbook.</span>
        {legs.length > 0 && !parlay.complete && (
          <strong style={{ color: "#ffd166" }}>{legs.length} of 5 selections available</strong>
        )}
      </div>
    </section>
  );
}

function getBetAccentColour(bet, awayCode, homeCode) {
  const teamCode = resolveBetTeamCode(bet, awayCode, homeCode);
  return BET_TEAM_COLOURS[teamCode]?.[1] || BET_TEAM_COLOURS[teamCode]?.[0] || "#b9ff55";
}

function PredictionSummary({ icon, label, value }) {
  return (
    <div className="card predictions-summary-card">
      <span className="predictions-summary-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function enrichSavedPredictionWithCurrentMarket(saved, game, oddsEvents) {
  const oddsEvent = findOddsForGame(oddsEvents, game);
  const market = getMarketExpectedScores(oddsEvent);
  const hasMarket = market.away !== null && market.home !== null;
  const oddsPick = hasMarket
    ? market.away > market.home
      ? game.away
      : market.home > market.away
        ? game.home
        : null
    : saved.oddsPick || null;
  const storedWeather =
    saved?.game?.weather ||
    saved?.dataQuality?.weather ||
    saved?.weather ||
    null;
  return {
    ...mapLedgerPrediction(saved),
    bestBets:
      saved.bestBets ||
      saved?.dataQuality?.bestBetsPayload ||
      (typeof saved?.dataQuality?.bestBets === "object" ? saved.dataQuality.bestBets : null),
    oddsPick,
    marketAwayScore: hasMarket ? market.away : saved.marketAwayScore,
    marketHomeScore: hasMarket ? market.home : saved.marketHomeScore,
    game: {
      ...game,
      weather: game.weather || storedWeather,
      oddsEvent,
    },
  };
}

function findLedgerRow(ledger, game) {
  return ledger.find(
    (row) =>
      Number(row.week) === Number(game.week) &&
      normalizeTeamCode(row.awayCode) === game.away &&
      normalizeTeamCode(row.homeCode) === game.home
  );
}

function hasClearPlayerPropLabels(saved) {
  const bestBets =
    saved?.bestBets ||
    saved?.dataQuality?.bestBetsPayload ||
    (typeof saved?.dataQuality?.bestBets === "object"
      ? saved.dataQuality.bestBets
      : null);
  const bets = [
    ...(bestBets?.recommendations || []),
    bestBets?.highlights?.mostLikely,
    bestBets?.highlights?.bestValue,
    bestBets?.highlights?.longshot,
    bestBets?.anytimeTdScorer,
  ].filter(Boolean);

  return bets.every((bet) => {
    if (bet.category === "Game") return true;
    const market = String(bet.market || "").toLowerCase();
    const selection = String(bet.selection || "").toLowerCase();
    const providerMarket = String(bet.rawMarketType || "").toLowerCase().replace(/[\s-]+/g, "_");
    const period = String(bet.period || "full_game").toLowerCase().replace(/[\s-]+/g, "_");
    if (isPeriodOrAlternateProp(providerMarket) || isPeriodOrAlternateProp(period)) return false;
    if (market.includes("touchdown")) return selection.includes("touchdown") || selection.includes("anytime td");

    const expectedUnit = market.includes("receiving yards")
      ? "receiving yards"
      : market.includes("rushing yards")
        ? "rushing yards"
        : market.includes("passing yards")
          ? "passing yards"
          : market.includes("receptions")
            ? "receptions"
            : market.includes("attempts")
              ? "attempts"
              : market.includes("completions")
                ? "completions"
                : null;

    const line = Number(bet.line);
    return Boolean(
      expectedUnit &&
      selection.includes(expectedUnit) &&
      isPlausibleDisplayedPropLine(market, line)
    );
  });
}

function isPeriodOrAlternateProp(value) {
  return [
    "1st_half", "first_half", "firsthalf", "1h_", "_1h",
    "2nd_half", "second_half", "secondhalf", "2h_", "_2h",
    "1st_quarter", "first_quarter", "q1", "quarter_1",
    "2nd_quarter", "second_quarter", "q2", "quarter_2",
    "3rd_quarter", "third_quarter", "q3", "quarter_3",
    "4th_quarter", "fourth_quarter", "q4", "quarter_4",
    "alternate", "alt_line", "alternative",
  ].some((marker) => String(value || "").includes(marker));
}

function isPlausibleDisplayedPropLine(market, line) {
  if (market.includes("touchdown")) return true;
  if (!Number.isFinite(line) || line < 0) return false;
  if (market.includes("passing yards")) return line >= 150 && line <= 400;
  if (market.includes("passing attempts")) return line >= 10.5 && line <= 60.5;
  if (market.includes("passing touchdowns")) return line >= 0.5 && line <= 5.5;
  if (market.includes("completions")) return line >= 5.5 && line <= 45.5;
  if (market.includes("rush + receiving yards")) return line >= 4.5 && line <= 220.5;
  if (market.includes("rushing yards")) return line >= 5.5 && line <= 160.5;
  if (market.includes("rushing attempts")) return line >= 0.5 && line <= 35.5;
  if (market.includes("receiving yards")) return line >= 15.5 && line <= 160.5;
  if (market.includes("receptions")) return line >= 0.5 && line <= 10.5;
  return false;
}

function hasSavedPrediction(row) {
  return Boolean(
    row &&
      Number.isFinite(Number(row.fourthDownAwayScore)) &&
      Number.isFinite(Number(row.fourthDownHomeScore))
  );
}

function mapLedgerPrediction(row) {
  return {
    ...row,
    awayCode: normalizeTeamCode(row.awayCode),
    homeCode: normalizeTeamCode(row.homeCode),
  };
}

function mergePredictionRows(scheduleRows, ledgerRows) {
  const merged = new Map();

  for (const row of scheduleRows) {
    if (!row) continue;
    merged.set(matchupKey(row.week, row.awayCode, row.homeCode), row);
  }

  for (const row of ledgerRows) {
    if (!row) continue;
    const key = matchupKey(row.week, row.awayCode, row.homeCode);
    const existing = merged.get(key);

    if (hasFinalResult(row) || !existing) {
      merged.set(key, {
        ...existing,
        ...row,
        game: row.game || existing?.game || null,
      });
    }
  }

  return [...merged.values()].filter(Boolean).sort(sortPredictions);
}

function hasFinalResult(row) {
  const away = Number(row?.actualAwayScore);
  const home = Number(row?.actualHomeScore);
  return Boolean(
    row?.actualWinner &&
      Number.isFinite(away) &&
      Number.isFinite(home) &&
      !(away === 0 && home === 0)
  );
}

function matchupKey(week, away, home) {
  return `${Number(week) || 0}:${normalizeTeamCode(away)}:${normalizeTeamCode(home)}`;
}

function scheduleCacheKey(season, week) {
  return `${SCHEDULE_CACHE_PREFIX}:${season}:${week}`;
}

function readScheduleCache(season, week) {
  try {
    const raw = sessionStorage.getItem(scheduleCacheKey(season, week));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    const age = Date.now() - Number(cached.savedAt || 0);

    if (!Array.isArray(cached.games) || age > SCHEDULE_CACHE_TTL_MS) {
      sessionStorage.removeItem(scheduleCacheKey(season, week));
      return null;
    }

    return { games: cached.games };
  } catch {
    return null;
  }
}

function writeScheduleCache(season, week, payload) {
  try {
    const games = extractScheduleGames(payload);
    if (!games.length) return;
    sessionStorage.setItem(
      scheduleCacheKey(season, week),
      JSON.stringify({ games, savedAt: Date.now() })
    );
  } catch {
    // Optional cache only.
  }
}

function fetchSchedule(season, week, signal) {
  const requestKey = `${season}:${week}`;
  if (pendingScheduleRequests.has(requestKey)) {
    return pendingScheduleRequests.get(requestKey);
  }

  const params = new URLSearchParams({
    season: String(season),
    week: String(week),
    refresh: String(Math.floor(Date.now() / 60000)),
  });

  const request = fetch(`/api/nfl/schedule?${params.toString()}`, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
    .then(async (response) => {
      const text = await response.text();
      let body;

      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          response.ok
            ? "The schedule endpoint returned invalid JSON"
            : text.slice(0, 200) ||
                `Schedule request failed (${response.status})`
        );
      }

      if (!response.ok) {
        throw new Error(extractErrorMessage(body, response.status));
      }

      return body;
    })
    .finally(() => pendingScheduleRequests.delete(requestKey));

  pendingScheduleRequests.set(requestKey, request);
  return request;
}

function extractErrorMessage(body, status) {
  const value =
    body?.error?.message ||
    body?.details ||
    body?.message ||
    body?.error;

  if (typeof value === "string" && value.trim()) return value;
  return `Schedule request failed (${status})`;
}

function extractScheduleGames(body) {
  return (
    [body?.games, body?.data, body?.response, body?.schedule?.games].find(
      Array.isArray
    ) || []
  );
}

function mergeSchedulePayloads(livePayload, cachedPayload) {
  const merged = new Map();
  const games = [
    ...extractScheduleGames(cachedPayload),
    ...extractScheduleGames(livePayload),
  ];

  for (const rawGame of games) {
    const mapped = mapScheduleGame(rawGame);
    if (!mapped.away || !mapped.home || !mapped.week) continue;
    const key = matchupKey(mapped.week, mapped.away, mapped.home);
    merged.set(key, rawGame);
  }

  return { games: [...merged.values()] };
}

function mapScheduleGame(apiGame) {
  const away = normalizeTeamCode(
    apiGame?.visitor_team?.abbreviation ||
      apiGame?.away_team?.abbreviation ||
      apiGame?.away?.abbreviation ||
      apiGame?.away_team_abbreviation ||
      apiGame?.away
  );

  const home = normalizeTeamCode(
    apiGame?.home_team?.abbreviation ||
      apiGame?.home?.abbreviation ||
      apiGame?.home_team_abbreviation ||
      apiGame?.home
  );

  const sourceDate =
    apiGame?.date ||
    apiGame?.datetime ||
    apiGame?.start_time ||
    apiGame?.commence_time ||
    null;

  return {
    id: String(apiGame?.id || `${away}-${home}-${sourceDate}`),
    week: Number(apiGame?.week || 0),
    away,
    home,
    awayName:
      TEAM_NAMES[away] || apiGame?.visitor_team?.full_name || away,
    homeName: TEAM_NAMES[home] || apiGame?.home_team?.full_name || home,
    sourceDate,
    date: sourceDate,
    time: sourceDate,
    venue:
      typeof apiGame?.venue === "string"
        ? apiGame.venue
        : apiGame?.venue?.fullName ||
          apiGame?.venue?.name ||
          "Venue unavailable",
    status: apiGame?.status || apiGame?.status_state || "Scheduled",
    scheduleContext: apiGame?.scheduleContext || null,
    weather: apiGame?.weather || null,
  };
}

function getMarketExpectedScores(event) {
  if (!event?.bookmakers?.length) return { away: null, home: null };

  for (const bookmaker of event.bookmakers) {
    const spread = bookmaker.markets?.find((market) => market.key === "spreads");
    const totals = bookmaker.markets?.find((market) => market.key === "totals");
    const homeOutcome = spread?.outcomes?.find(
      (outcome) =>
        normalizeName(outcome.name) === normalizeName(event.home_team)
    );
    const overOutcome = totals?.outcomes?.find(
      (outcome) => String(outcome.name || "").toLowerCase() === "over"
    );
    const homeSpread = finiteNumberOrNull(homeOutcome?.point);
    const total = finiteNumberOrNull(overOutcome?.point);

    if (homeSpread !== null && total !== null) {
      return {
        away: (total + homeSpread) / 2,
        home: (total - homeSpread) / 2,
      };
    }
  }

  return { away: null, home: null };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    )
  );

  return results;
}

function getCurrentWeek() {
  const weekOneStart = Date.UTC(2026, 8, 8, 0, 0, 0);
  const elapsed = Date.now() - weekOneStart;
  const week = Math.floor(elapsed / (7 * 24 * 60 * 60 * 1000)) + 1;
  return Math.min(18, Math.max(1, week));
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeTeamCode(code) {
  const value = String(code || "").trim().toUpperCase();
  return (
    {
      WAS: "WSH",
      LA: "LAR",
      JAC: "JAX",
      OAK: "LV",
      SD: "LAC",
      STL: "LAR",
    }[value] || value
  );
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function projectedMargin(row) {
  const away = Number(row.fourthDownAwayScore);
  const home = Number(row.fourthDownHomeScore);
  return Number.isFinite(away) && Number.isFinite(home)
    ? Math.abs(away - home)
    : 99;
}

function displayScore(value) {
  return Number.isFinite(Number(value)) ? Number(value) : "-";
}

function teamName(code) {
  return TEAM_NAMES[normalizeTeamCode(code)] || code || "Not available";
}

function formatKickoff(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Kickoff TBC";
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sortPredictions(first, second) {
  const firstDate = new Date(first.kickoff || 0).getTime();
  const secondDate = new Date(second.kickoff || 0).getTime();
  return firstDate - secondDate;
}
