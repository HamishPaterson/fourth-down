import { CheckCircle2 } from "lucide-react";

export default function Home({ favoriteTeam, onNavigate }) {
  return (
    <section>
      <div className="card hero">
        <span className="eyebrow">NFL PREDICTION PLATFORM</span>
        <h1>Fourth Down</h1>
        <p>
          Live NFL schedules, matchup data, team pages and rosters in one place.
        </p>

        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => onNavigate("schedule")}
          >
            View schedule
          </button>

          <button
            type="button"
            className="secondary"
            onClick={() => onNavigate("teams")}
          >
            Browse teams
          </button>
        </div>
      </div>

      <div className="status-grid">
        <StatusCard title="Live schedule" detail="BALLDONTLIE connected" />
        <StatusCard title="Team rosters" detail="Sleeper connected" />
        <StatusCard title="Favourite team" detail={favoriteTeam || "Not selected"} />
      </div>
    </section>
  );
}

function StatusCard({ title, detail }) {
  return (
    <article className="card status-card">
      <span>
        <CheckCircle2 size={22} />
      </span>

      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}
