import { useMemo } from "react";

const LAYER_ORDER = [
  "rosterHealth", "quarterback", "playerRatings", "teamForm", "opponentNetwork",
  "playByPlayEfficiency", "opponentAdjustedEfficiency", "successRate", "earlyDownEpa",
  "explosivePlays", "driveEfficiency", "situationalEfficiency", "passProtection",
  "pressureMatchup", "coverageMatchup", "turnoverRegression", "expectedLineup",
  "offensiveLineContinuity", "snapParticipation", "specialTeams", "weather", "pace",
];

const LAYER_LABELS = {
  rosterHealth: "Roster health",
  quarterback: "Quarterback",
  playerRatings: "Player ratings",
  teamForm: "Team form",
  opponentNetwork: "Opponent network",
  playByPlayEfficiency: "Play-by-play EPA",
  opponentAdjustedEfficiency: "Opponent-adjusted efficiency",
  successRate: "Success rate",
  earlyDownEpa: "Early-down EPA",
  explosivePlays: "Explosive plays",
  driveEfficiency: "Drive efficiency",
  situationalEfficiency: "Situational efficiency",
  passProtection: "Pass protection",
  pressureMatchup: "Pressure matchup",
  coverageMatchup: "Coverage matchup",
  turnoverRegression: "Turnover regression",
  expectedLineup: "Expected lineup",
  offensiveLineContinuity: "Offensive-line continuity",
  snapParticipation: "Snap participation",
  specialTeams: "Special teams",
  weather: "Weather",
  pace: "Pace",
  homeField: "Home-field advantage",
  rivalry: "Rivalry adjustment",
};

export default function MatchupPrediction({ prediction, awayCode, homeCode, oddsEvent }) {
  const model = useMemo(
    () => normalisePrediction(prediction, awayCode, homeCode),
    [prediction, awayCode, homeCode]
  );

  if (!model) {
    return (
      <section className="matchup-prediction matchup-split-panel">
        <Heading eyebrow="MODEL PROJECTION" title="Predicted result" />
        <div className="team-statistics-empty">
          The shared prediction is not available for this matchup.
        </div>
      </section>
    );
  }

  const market = getMarketScores(oddsEvent, awayCode, homeCode);
  const layers = buildLayerRows(model.payload);
  const sources = buildSourceRows(prediction);

  return (
    <div className="matchup-full-analysis">
      <section className="matchup-prediction matchup-split-panel">
        <Heading
          eyebrow="MODEL PROJECTION"
          title="Predicted result"
          badge={model.confidence}
        />

        <div className="prediction-scoreline">
          <Score code={awayCode} score={model.awayScore} side="away" />
          <div className="prediction-score-divider">
            <small>PROJECTED</small>
            <span>-</span>
          </div>
          <Score code={homeCode} score={model.homeScore} side="home" />
        </div>

        <div className="prediction-summary">
          <span>{model.winner} by {model.margin}</span>
          <span>{model.winnerProbability}% win probability</span>
          <span>Projected total {model.total}</span>
        </div>

        <div className="team-statistics-table prediction-table matchup-stats-table">
          <TableHeader away={awayCode} middle="Projection" home={homeCode} />
          <DataRow label="Win probability" away={formatPercent(model.awayProbability)} home={formatPercent(model.homeProbability)} />
          <DataRow label="Expected points" away={formatNumber(model.awayExpected)} home={formatNumber(model.homeExpected)} />
          <DataRow label="Expected possessions" away={formatNumber(model.awayPossessions)} home={formatNumber(model.homePossessions)} />
          <DataRow label="Scoring baseline" away={formatNumber(model.formBlend?.away)} home={formatNumber(model.formBlend?.home)} />
          <DataRow label="Current-season games" away={formatWhole(model.formBlend?.gamesUsed?.away)} home={formatWhole(model.formBlend?.gamesUsed?.home)} />
        </div>

        <div className="prediction-context-grid">
          <ContextItem label="Current-season weight" value={formatPercent(model.formBlend?.sampleReliability)} />
          <ContextItem label="Home-field adjustment" value={formatSigned(model.payload?.homeField)} />
          <ContextItem label="Data quality" value={formatPercent(model.payload?.confidenceScore)} />
          <ContextItem label="Continuous margin" value={formatSigned(model.payload?.continuousMargin)} />
        </div>
      </section>

      <section className="card prediction-explanation-card">
        <Heading eyebrow={`WHY THE MODEL LEANS ${model.winner}`} title="Prediction explanation" />
        <p>{buildSummary(model)}</p>
        <ul className="prediction-explanation-list">
          {model.confidenceReasons.map((reason) => <li key={reason}>{reason}</li>)}
          {model.formBlend?.source && <li><strong>Scoring baseline:</strong> {model.formBlend.source}</li>}
          {model.weatherText && <li><strong>Weather:</strong> {model.weatherText}</li>}
          {model.rivalryText && <li><strong>Rivalry:</strong> {model.rivalryText}</li>}
        </ul>
      </section>

      <section className="card prediction-comparison-card">
        <Heading eyebrow="ADVANCED ANALYTICS" title="Full model-layer breakdown" />
        <div className="team-statistics-table advanced-analytics-table matchup-stats-table">
          <TableHeader away={awayCode} middle="Model layer" home={homeCode} />
          {layers.map((row) => (
            <LayerRow key={row.key} row={row} awayCode={awayCode} homeCode={homeCode} />
          ))}
        </div>
        <p className="prediction-note">
          EPA and efficiency layers are shown as their point contribution to the final projection. Expandable explanations list the source reason saved by each layer.
        </p>
      </section>

      <section className="card prediction-comparison-card">
        <Heading eyebrow="DATA USED" title="Source coverage" />
        <div className="prediction-source-grid">
          {sources.map((source) => <SourceCard key={source.key} source={source} />)}
        </div>
      </section>

      <section className="card prediction-comparison-card">
        <Heading eyebrow="MODEL VERSUS MARKET" title="Scoring comparison" />
        {market ? (
          <div className="team-statistics-table matchup-stats-table">
            <TableHeader away={awayCode} middle="Comparison" home={homeCode} />
            <DataRow label="Fourth Down score" away={model.awayScore} home={model.homeScore} />
            <DataRow label="Market-implied score" away={formatNumber(market.away)} home={formatNumber(market.home)} />
            <DataRow label="Difference" away={formatSigned(model.awayScore - market.away)} home={formatSigned(model.homeScore - market.home)} />
          </div>
        ) : (
          <div className="team-statistics-empty">Spread and total data are not available for a market-implied score.</div>
        )}
      </section>
    </div>
  );
}

function Heading({ eyebrow, title, badge }) {
  return (
    <div className="team-statistics-heading">
      <div><span className="eyebrow">{eyebrow}</span><h3>{title}</h3></div>
      {badge && <span className="prediction-confidence">{badge}</span>}
    </div>
  );
}
function Score({ code, score, side }) {
  return <div className={`prediction-score prediction-score-${side}`}><small>{code}</small><strong>{score}</strong></div>;
}
function TableHeader({ away, middle, home }) {
  return <div className="team-statistics-row team-statistics-header"><strong>{away}</strong><span>{middle}</span><strong>{home}</strong></div>;
}
function DataRow({ label, away, home }) {
  return <div className="team-statistics-row matchup-stat-row"><strong>{away}</strong><span>{label}</span><strong>{home}</strong></div>;
}
function ContextItem({ label, value }) {
  return <div className="prediction-context-item"><small>{label}</small><strong>{value}</strong></div>;
}
function LayerRow({ row, awayCode, homeCode }) {
  return (
    <details className={`prediction-layer-row prediction-layer-${row.status}`}>
      <summary className="team-statistics-row matchup-stat-row">
        <strong>{formatSigned(row.awayPoints)}</strong>
        <span><b>{row.label}</b><small>{row.statusLabel}</small></span>
        <strong>{formatSigned(row.homePoints)}</strong>
      </summary>
      <div className="prediction-layer-details">
        <strong>{row.lean}</strong>
        {row.confidence !== null && <span>Layer confidence: {formatPercent(row.confidence)}</span>}
        {row.reasons.length ? <ul>{row.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>No separate explanation was saved for this layer.</p>}
        <small>{awayCode} {formatSigned(row.awayPoints)} · {homeCode} {formatSigned(row.homePoints)}</small>
      </div>
    </details>
  );
}
function SourceCard({ source }) {
  return (
    <div className={`prediction-source-card prediction-source-${source.available ? "available" : "unavailable"}`}>
      <div><small>{source.available ? "CONNECTED" : "UNAVAILABLE"}</small><strong>{source.label}</strong></div>
      {source.source && <span>{source.source}</span>}
      {source.warning && <p>{source.warning}</p>}
    </div>
  );
}

function normalisePrediction(row, awayCode, homeCode) {
  if (!row) return null;
  const payload = row.predictionPayload || row?.dataQuality?.predictionPayload || row;
  const awayScore = number(row.fourthDownAwayScore ?? payload?.away?.score);
  const homeScore = number(row.fourthDownHomeScore ?? payload?.home?.score);
  if (awayScore === null || homeScore === null) return null;
  const awayProbability = probability(row.fourthDownAwayWinProbability ?? payload?.awayWinProbability);
  const homeProbability = probability(row.fourthDownHomeWinProbability ?? payload?.homeWinProbability);
  const winner = team(row.fourthDownPick || payload?.winner || (awayScore >= homeScore ? awayCode : homeCode));
  const winnerProbability = winner === team(awayCode) ? awayProbability : homeProbability;
  return {
    payload,
    awayScore: Math.round(awayScore), homeScore: Math.round(homeScore),
    awayExpected: number(payload?.away?.expectedPoints ?? awayScore),
    homeExpected: number(payload?.home?.expectedPoints ?? homeScore),
    awayPossessions: number(payload?.away?.expectedPossessions),
    homePossessions: number(payload?.home?.expectedPossessions),
    awayProbability, homeProbability, winner,
    winnerProbability: Math.round((winnerProbability ?? 0.5) * 100),
    margin: Math.abs(Math.round(awayScore - homeScore)), total: Math.round(awayScore + homeScore),
    confidence: row.confidenceLabel || payload?.confidence || "Model",
    confidenceReasons: Array.isArray(payload?.confidenceReasons) ? payload.confidenceReasons.filter(Boolean) : [],
    formBlend: payload?.formBlend || null,
    weatherText: weatherSummary(payload?.weather),
    rivalryText: rivalrySummary(payload?.rivalry),
  };
}
function buildLayerRows(payload) {
  const source = payload?.modelLayers?.layers || payload?.modelLayers || {};
  const keys = [...new Set([...LAYER_ORDER, ...Object.keys(source)])]
    .filter((key) => key !== "scoringBaseline" && source[key] && typeof source[key] === "object");
  return keys.map((key) => {
    const layer = source[key];
    const awayPoints = number(layer.awayPoints) ?? 0;
    const homePoints = number(layer.homePoints) ?? 0;
    const available = layer.available !== false;
    const active = layer.active === true || Math.abs(awayPoints) > 0.001 || Math.abs(homePoints) > 0.001;
    const status = !available ? "unavailable" : active ? "active" : "neutral";
    const lean = homePoints > awayPoints ? `Leans ${payload?.home?.code || "home"}` : awayPoints > homePoints ? `Leans ${payload?.away?.code || "away"}` : "Measured neutral";
    return { key, label: LAYER_LABELS[key] || pretty(key), awayPoints, homePoints, confidence: number(layer.confidence), reasons: Array.isArray(layer.reasons) ? layer.reasons.filter(Boolean) : [], status, statusLabel: status === "active" ? "Active" : status === "neutral" ? "Measured neutral" : "Unavailable", lean };
  });
}
function buildSourceRows(row) {
  const sources = row?.dataQuality?.sources || {};
  return Object.entries(sources).map(([key, value]) => ({ key, label: value?.label || pretty(key), available: value?.available !== false, source: value?.source || null, warning: value?.warning || null }));
}
function buildSummary(model) {
  const source = model.formBlend?.source ? `The scoring baseline uses ${model.formBlend.source}. ` : "";
  const sample = model.formBlend?.gamesUsed ? `Current-season form includes ${model.formBlend.gamesUsed.away ?? 0} away-team games and ${model.formBlend.gamesUsed.home ?? 0} home-team games. ` : "";
  return `${source}${sample}${model.winner} has the stronger final projection by ${model.margin} points, with a projected total of ${model.total}.`;
}
function getMarketScores(event, awayCode, homeCode) {
  for (const book of event?.bookmakers || []) {
    const spread = book.markets?.find((market) => market.key === "spreads");
    const totalMarket = book.markets?.find((market) => market.key === "totals");
    const homeOutcome = spread?.outcomes?.find((outcome) => sameTeam(outcome.name, event.home_team, homeCode));
    const over = totalMarket?.outcomes?.find((outcome) => String(outcome.name || "").toLowerCase() === "over");
    const homeSpread = number(homeOutcome?.point); const total = number(over?.point);
    if (homeSpread !== null && total !== null) return { away: (total + homeSpread) / 2, home: (total - homeSpread) / 2 };
  }
  return null;
}
function weatherSummary(weather) { if (!weather) return null; if (weather.dome) return "Indoor venue, so no weather adjustment is applied."; const parts = [...(weather.conditions || [])]; if (weather.severity) parts.push(`${weather.severity} impact`); return parts.join(" · ") || null; }
function rivalrySummary(rivalry) { if (!rivalry?.active) return null; return (rivalry.reasons || []).filter(Boolean).join("; ") || "Rivalry adjustment active."; }
function sameTeam(a, b, code) { const values=[normal(a),normal(b),normal(code)]; return values[0]===values[1] || values[0]===values[2] || values[0].endsWith(values[2]) || values[1].endsWith(values[2]); }
function pretty(value) { return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g," ").replace(/^./, (c) => c.toUpperCase()); }
function number(value) { const result=Number(value); return value===null || value===undefined || !Number.isFinite(result) ? null : result; }
function probability(value) { const result=number(value); return result===null ? null : result>1 ? result/100 : result; }
function formatPercent(value) { const result=probability(value); return result===null ? "-" : `${Math.round(result*100)}%`; }
function formatNumber(value) { const result=number(value); return result===null ? "-" : result.toFixed(1); }
function formatWhole(value) { const result=number(value); return result===null ? "-" : String(Math.round(result)); }
function formatSigned(value) { const result=number(value); return result===null ? "-" : `${result>=0?"+":""}${result.toFixed(2)}`; }
function team(value) { return String(value || "").trim().toUpperCase(); }
function normal(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
