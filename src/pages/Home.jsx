import { ArrowRight, CalendarDays, Shield, Users } from "lucide-react";
import TeamLogo from "../components/TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme, normalizeTeamCode } from "../services/teamThemes.js";

export default function Home({ favoriteTeam, onNavigate }) {
  const teamCode = normalizeTeamCode(favoriteTeam || "SF");
  const teamName = TEAM_NAMES[teamCode] || teamCode;

  return (
    <section className="home-favourite-page" style={getTeamTheme(teamCode)}>
      <div className="card favourite-hero">
        <div className="favourite-hero-copy">
          <span className="eyebrow">YOUR FAVOURITE TEAM</span>
          <h1>{teamName}</h1>
          <p>
            Follow the roster, explore the franchise and jump straight into the live NFL schedule.
          </p>

          <div className="actions">
            <button
              type="button"
              className="primary favourite-primary"
              onClick={() => onNavigate("teams")}
            >
              Open team hub <ArrowRight size={17} />
            </button>

            <button
              type="button"
              className="secondary"
              onClick={() => onNavigate("schedule")}
            >
              View schedule
            </button>
          </div>
        </div>

        <div className="favourite-logo-stage">
          <TeamLogo team={teamCode} size={210} />
          <strong>{teamCode}</strong>
        </div>
      </div>

      <div className="home-favourite-grid">
        <HomeTile
          icon={<Shield size={21} />}
          title="Franchise hub"
          detail={`${teamName} roster and team information`}
          onClick={() => onNavigate("teams")}
        />
        <HomeTile
          icon={<CalendarDays size={21} />}
          title="Live schedule"
          detail="Week-by-week NFL matchups"
          onClick={() => onNavigate("schedule")}
        />
        <HomeTile
          icon={<Users size={21} />}
          title="Roster data"
          detail="Offense, defense, special teams and reserves"
          onClick={() => onNavigate("teams")}
        />
      </div>
    </section>
  );
}

function HomeTile({ icon, title, detail, onClick }) {
  return (
    <button type="button" className="card home-favourite-tile" onClick={onClick}>
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <ArrowRight size={17} />
    </button>
  );
}
