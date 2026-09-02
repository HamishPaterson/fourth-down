import { ArrowRight, CalendarDays, Database, Shield, Sparkles } from "lucide-react";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Home({ favoriteTeam, onNavigate }) {
  return (
    <section className="home-page">
      <div className="home-hero card">
        <div className="home-hero-copy">
          <span className="eyebrow">NFL ANALYTICS, BUILT YOUR WAY</span>
          <h1>Every matchup.<br />Every roster.<br /><span>One fourth down.</span></h1>
          <p>
            Live schedules, franchise rosters and matchup intelligence in one focused dashboard.
          </p>
          <div className="actions">
            <button type="button" className="primary home-primary" onClick={() => onNavigate("schedule")}>
              Open schedule <ArrowRight size={17} />
            </button>
            <button type="button" className="secondary" onClick={() => onNavigate("teams")}>
              Explore teams
            </button>
          </div>
        </div>

        <div className="home-team-spotlight">
          <span>FAVOURITE TEAM</span>
          <TeamLogo team={favoriteTeam} size={170} />
          <strong>{favoriteTeam}</strong>
        </div>
      </div>

      <div className="home-feature-grid">
        <Feature icon={<CalendarDays size={20} />} title="Live schedule" text="Week-by-week NFL games loaded through your Vercel API." />
        <Feature icon={<Shield size={20} />} title="Franchise hubs" text="Team branding, starters, reserves and position groups." />
        <Feature icon={<Database size={20} />} title="Connected data" text="BALLDONTLIE game data combined with Sleeper player data." />
        <Feature icon={<Sparkles size={20} />} title="Built for predictions" text="A premium foundation for ratings, trends and matchup picks." />
      </div>
    </section>
  );
}

function Feature({ icon, title, text }) {
  return (
    <article className="card home-feature-card">
      <span>{icon}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </article>
  );
}
