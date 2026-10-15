import { TEAM_NAMES } from "../data.js";

const teamName = (code) => TEAM_NAMES[code] || code;

const footballLabels = {
  rushMatchup: "Running game",
  passMatchup: "Passing game",
  successMatchup: "Keeping drives alive",
  explosiveMatchup: "Explosive plays",
  pressureMatchup: "Pass protection and pressure",
};

function matchupFootballExplanation(signal) {
  const side = signal.advantagedTeam === signal.homeTeam ? "home" : "away";
  const otherSide = side === "home" ? "away" : "home";
  const own = signal.matchups[side], other = signal.matchups[otherSide];
  const team = teamName(signal.advantagedTeam), rival = teamName(signal.disadvantagedTeam);
  const betterAttack = own.offensiveMetric.value >= other.offensiveMetric.value;
  const weakerRivalDefense = own.defensiveMetric.value >= other.defensiveMetric.value;
  let text;
  if (signal.layer === "pressureMatchup") {
    const morePressure = other.defensiveMetric.value >= own.defensiveMetric.value;
    const moreExposed = other.offensiveMetric.value >= own.offensiveMetric.value;
    text = `${team} ${morePressure ? "have generated pressure more consistently" : "have generated less pressure than " + rival}, while ${rival} ${moreExposed ? "have had more trouble with pass protection" : "have protected the passing game more reliably"}. ${team} still hold the overall edge in the balance between creating pressure and avoiding disruption.`;
    if (morePressure && moreExposed) text = `${team} have generated pressure more consistently, while ${rival} have had more trouble with pass protection. That gives ${team} opportunities to disrupt ${rival} through the air.`;
    else if (moreExposed) text = `${team} have protected the passing game more reliably than ${rival}. ${rival} have generated more pressure, but better pass protection gives ${team} the overall edge in avoiding disruption.`;
  } else {
    const phrases = {
      rushMatchup: ["run the ball more efficiently", "contain the run", "sustain drives on the ground", "rushing"],
      passMatchup: ["been more efficient through the air", "limit passing efficiency", "move the ball through the air", "passing"],
      successMatchup: ["been more consistent at keeping drives on schedule", "stop efficient possessions", "keep drives alive", "drive-to-drive"],
      explosiveMatchup: ["created big plays more often", "prevent big plays", "create chunk yardage", "big-play"],
    };
    const [attack, prevention, benefit, label] = phrases[signal.layer];
    text = betterAttack
      ? `${team} have ${attack}, ${weakerRivalDefense ? `while ${rival} have found it harder to ${prevention}` : `but ${rival} have done more to ${prevention}`}.`
      : `${rival} have ${attack}, ${weakerRivalDefense ? `but ${team} have done more to ${prevention}` : `and ${rival} have also done more to ${prevention}`}.`;
    text += betterAttack && weakerRivalDefense
      ? ` That gives ${team} a favourable path to ${benefit}.`
      : ` Fourth Down still gives ${team} a relative ${label} edge, though this is not a one-sided matchup.`;
    if (betterAttack && weakerRivalDefense && signal.layer === "successMatchup") {
      text = `${team} have kept drives on schedule more consistently. ${rival} have found it harder to stop efficient possessions, giving ${team} a useful advantage in sustaining drives.`;
    }
    if (betterAttack && weakerRivalDefense && signal.layer === "explosiveMatchup") {
      text = `${team} create big plays more often than ${rival}, who have also been more vulnerable to chunk yardage. That gives ${team} another route to scoring chances.`;
    }
    const adjusted = own.opponentAdjustedMetric;
    const netAdjustment = signal.metricAdjustmentHomePoints * (side === "home" ? 1 : -1);
    if (adjusted && Math.abs(netAdjustment) >= .005) {
      const delta = adjusted.unit === "rate" ? adjusted.value : adjusted.value - own.offensiveMetric.value;
      if (delta > 0 && netAdjustment > 0) text += ` The ${label} results for ${team} also hold up after accounting for the teams ${team} have faced.`;
      if (delta < 0 && netAdjustment < 0) text += ` The ${label} results for ${team} soften after accounting for the teams ${team} have faced, limiting that advantage.`;
    }
  }
  return text;
}

function leanOpportunity(signal) {
  return {
    rushMatchup: "sustaining drives on the ground",
    passMatchup: "moving the ball through the air",
    successMatchup: "keeping drives alive",
    explosiveMatchup: "creating big plays",
    pressureMatchup: "balancing pressure with reliable pass protection",
  }[signal.layer];
}

function gameStyle(prediction) {
  const mix = prediction.matchupIntelligence.playMix;
  const lines = ["away", "home"].filter((side) => mix[side]?.available).map((side) => {
    const own = mix[side], team = teamName(prediction[side].code);
    const rival = teamName(prediction[side === "home" ? "away" : "home"].code);
    const style = own.passRate >= .62 ? "lean on the passing game"
      : own.passRate <= .45 ? "lean on the running game"
        : own.passRate >= .53 ? "stay fairly balanced with a slight lean toward the pass"
          : "keep a balanced mix of passing and rushing";
    return `${team} are expected to ${style}.${own.scriptShift > .005
      ? ` ${team} may need to throw more if ${rival} play from ahead.`
      : own.scriptShift < -.005 ? ` Playing from ahead would give ${team} more opportunity to run.` : ""}`;
  });
  if (["away", "home"].every((side) => mix[side]?.available && mix[side].expectedPlays >= 68)) {
    lines.push(`This projects as a relatively high-volume game, with ${teamName(prediction.away.code)} and ${teamName(prediction.home.code)} each expected to have around ${Math.round((mix.away.expectedPossessions + mix.home.expectedPossessions) / 2)} possessions.`);
  }
  return lines;
}

export default function MatchupIntelligencePanel({ prediction }) {
  const intelligence = prediction?.matchupIntelligence;
  if (!intelligence?.available) return null;
  const signals = intelligence.signals.filter((signal) =>
    signal.explanationSafe && Math.abs(signal.modelMarginContribution) >= .05)
    .sort((a, b) => Math.abs(b.modelMarginContribution) - Math.abs(a.modelMarginContribution))
    .slice(0, 4);
  const winner = prediction.winner;
  const reasons = signals.filter((signal) => signal.advantagedTeam === winner).slice(0, 2);
  const style = gameStyle(prediction);
  return (
    <section className="card prediction-explanation-card">
      <span className="eyebrow">KEY MATCHUP ADVANTAGES</span>
      <h3>{teamName(prediction.away.code)} vs {teamName(prediction.home.code)}</h3>
      {signals.length ? (
        <ul className="prediction-explanation-list">
          {signals.map((signal) => (
            <li key={signal.layer}>
              <strong>{footballLabels[signal.layer]} - {teamName(signal.advantagedTeam)}: </strong>
              {matchupFootballExplanation(signal)}
            </li>
          ))}
        </ul>
      ) : <p>Neither {teamName(prediction.away.code)} nor {teamName(prediction.home.code)} has a standout matchup advantage.</p>}
      {style.length > 0 && <><h4>Game style</h4>{style.map((line) => <p key={line}>{line}</p>)}</>}
      <h4>{winner ? `Why Fourth Down leans ${teamName(winner)}` : "Why Fourth Down sees a balanced matchup"}</h4>
      <p>{reasons.length
        ? `${teamName(winner)} hold the stronger overall projection. The clearest opportunities for ${teamName(winner)} against ${teamName(reasons[0].disadvantagedTeam)} come from ${reasons.map(leanOpportunity).join(" and ")}.`
        : winner ? `Fourth Down's ${teamName(winner)} lean comes primarily from the broader team projection rather than one dominant matchup advantage.`
          : `${teamName(prediction.away.code)} and ${teamName(prediction.home.code)} are closely matched, with no clear overall lean.`}</p>
    </section>
  );
}
