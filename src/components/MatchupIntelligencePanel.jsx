import { TEAM_NAMES } from "../data.js";

const teamName = (code) => TEAM_NAMES[code] || code;

export default function MatchupIntelligencePanel({ prediction }) {
  const intelligence = prediction?.matchupIntelligence;
  if (!intelligence?.available) return null;
  const signals = intelligence.signals.filter((signal) =>
    signal.explanationSafe && Math.abs(signal.modelMarginContribution) >= .05)
    .sort((a, b) => Math.abs(b.modelMarginContribution) - Math.abs(a.modelMarginContribution))
    .slice(0, 4);
  const winner = prediction.winner;
  const reasons = signals.filter((signal) => signal.advantagedTeam === winner).slice(0, 2);
  return (
    <section className="card prediction-explanation-card">
      <span className="eyebrow">KEY MATCHUP ADVANTAGES</span>
      <h3>{teamName(prediction.away.code)} vs {teamName(prediction.home.code)}</h3>
      {signals.length ? (
        <ul className="prediction-explanation-list">
          {signals.map((signal) => (
            <li key={signal.layer}>
              <strong>{signal.category} - {teamName(signal.advantagedTeam)}: </strong>
              {signal.explanation}
            </li>
          ))}
        </ul>
      ) : <p>No measured interaction materially changes the expected margin.</p>}
      <h4>Game style</h4>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Team</th><th>Pass / rush</th><th>Plays / possessions</th></tr></thead>
          <tbody>
            {["away", "home"].map((side) => {
              const mix = intelligence.playMix[side];
              return (
                <tr key={side}>
                  <td>{teamName(prediction[side].code)}</td>
                  <td>{mix.available ? `${(mix.passRate * 100).toFixed(1)}% / ${(mix.rushRate * 100).toFixed(1)}%` : "Eligible play mix unavailable"}</td>
                  <td>{mix.available ? `${mix.expectedPlays.toFixed(1)} / ${mix.expectedPossessions.toFixed(1)}` : `${prediction[side].expectedPossessions.toFixed(1)} possessions`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {["away", "home"].map((side) => {
        const mix = intelligence.playMix[side];
        return <p className="prediction-note" key={side}>{mix.available ? mix.script : `${teamName(prediction[side].code)}: ${mix.reason}.`}</p>;
      })}
      <h4>{winner ? `Why Fourth Down leans ${teamName(winner)}` : "Why Fourth Down sees a balanced matchup"}</h4>
      <p>{reasons.length
        ? `${reasons.map((signal) => signal.category).join(" and ")} favour ${teamName(winner)} in the model. These measured interactions supplement, rather than replace, the scoring baseline and other active layers.`
        : `The measured interactions do not materially support a ${winner ? teamName(winner) : "clear"} lean; the overall projection also reflects the scoring baseline and other active layers.`}</p>
      <details className="prediction-model-details">
        <summary>Coverage and model limits</summary>
        <p>New correlated matchup signals share a maximum one-point pre-simulation margin budget. Pressure reuses the existing layer. Margin effects are single-layer ablations, not additive final-score promises.</p>
        <ul className="prediction-explanation-list">
          {intelligence.signals.filter((signal) => !signal.available).map((signal) => <li key={signal.layer}>{signal.category}: {signal.reason}</li>)}
          {intelligence.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      </details>
    </section>
  );
}
