import { MapPin } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Matchup({ game, onBack }) {
  if (!game) {
    return (
      <section className="card empty">
        <h1>No matchup selected</h1>

        <p>Open a game from the Schedule page.</p>

        <button
          className="primary"
          onClick={onBack}
        >
          Go to Schedule
        </button>
      </section>
    );
  }

  return (
    <section>
      <button
        className="secondary back"
        onClick={onBack}
      >
        Back to Schedule
      </button>

      <div className="card matchup-card">
        <div className="game-meta">
          <span>Week {game.week}</span>
          <span>{game.date}</span>
        </div>

        <div className="matchup-row">
          <LargeTeam
            code={game.away}
            label="Away"
          />

          <div className="versus large">
            <small>{game.time}</small>
            <strong>VS</strong>
          </div>

          <LargeTeam
            code={game.home}
            label="Home"
          />
        </div>

        <div className="matchup-info">
          <MapPin size={18} />

          <div>
            <small>VENUE</small>
            <strong>{game.venue}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function LargeTeam({ code, label }) {
  return (
    <div className="large-team">
      <TeamLogo
        team={code}
        size={140}
      />

      <h2>{TEAM_NAMES[code]}</h2>

      <small>{label}</small>
    </div>
  );
}
