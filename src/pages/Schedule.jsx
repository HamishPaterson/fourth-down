import { MapPin } from "lucide-react";
import { GAMES, TEAM_NAMES } from "../data.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Schedule({ onOpen }) {
  return (
    <section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">2026 REGULAR SEASON</span>
          <h1>Week 1 schedule</h1>
        </div>

        <span className="count-pill">
          {GAMES.length} games
        </span>
      </div>

      <div className="game-grid">
        {GAMES.map((game) => (
          <button
            type="button"
            className="game-card card"
            key={game.id}
            onClick={() => onOpen(game)}
          >
            <div className="game-meta">
              <span>Week {game.week}</span>
              <span>{game.date}</span>
            </div>

            <div className="teams-row">
              <Team code={game.away} />

              <div className="versus">
                <small>{game.time}</small>
                <strong>VS</strong>
              </div>

              <Team code={game.home} />
            </div>

            <div className="venue">
              <MapPin size={15} />
              <span>{game.venue}</span>
              <strong>View matchup</strong>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function Team({ code }) {
  return (
    <div className="team">
      <TeamLogo team={code} size={80} />
      <strong>{TEAM_NAMES[code]}</strong>
    </div>
  );
}