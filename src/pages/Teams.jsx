import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { getTeams } from "../services/nflApi.js";
import { getTeamTheme } from "../services/teamThemes.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Teams({ onOpenTeam }) {
  const [teams, setTeams] = useState([]);
  const [status, setStatus] = useState("Loading NFL teams...");

  useEffect(() => {
    const controller = new AbortController();

    getTeams(controller.signal)
      .then((data) => {
        setTeams(data);
        setStatus(`${data.length} teams loaded`);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setStatus(error.message);
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <section className="teams-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">LIVE BACKEND DATA</span>
          <h1>NFL Teams</h1>
        </div>

        <span className="count-pill">{status}</span>
      </div>

      <div className="team-grid">
        {teams.map((team) => (
          <button
            type="button"
            className="card api-team team-colour-card"
            key={team.id}
            style={getTeamTheme(team.abbreviation)}
            onClick={() => onOpenTeam(team)}
          >
            <span className="team-card-watermark" aria-hidden="true" />

            <span className="team-card-logo">
              <TeamLogo team={team.abbreviation} size={76} />
            </span>

            <span className="team-card-copy">
              <strong>{team.full_name}</strong>
              <small>
                {team.conference} {team.division}
              </small>
            </span>

            <ArrowRight className="team-card-arrow" size={18} />
          </button>
        ))}
      </div>
    </section>
  );
}
