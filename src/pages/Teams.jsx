import { useEffect, useState } from "react";
import { getTeams } from "../services/nflApi.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Teams() {
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
        setStatus(error.message);
      });

    return () => controller.abort();
  }, []);

  return (
    <section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            LIVE BACKEND DATA
          </span>

          <h1>NFL teams</h1>
        </div>

        <span className="count-pill">
          {status}
        </span>
      </div>

      <div className="team-grid">
        {teams.map((team) => (
          <div
            className="card api-team"
            key={team.id}
          >
            <TeamLogo
              team={team.abbreviation}
              size={72}
            />

            <div>
              <strong>{team.full_name}</strong>

              <small>
                {team.conference}{" "}
                {team.division}
              </small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}