import { useEffect, useState } from "react";
import { ArrowRight, ChevronRight, Layers } from "lucide-react";
import { getTeams } from "../services/nflApi.js";
import { getTeamTheme } from "../services/teamThemes.js";
import { getTeamRatings } from "../services/teamRatings.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Teams({ onOpenTeam, onOpenConference }) {
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
        if (error.name !== "AbortError") setStatus(error.message);
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

      <button
        type="button"
        onClick={onOpenConference}
        aria-label="Open conference and division view"
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid rgba(163, 230, 53, 0.5)",
          borderRadius: "18px",
          background: "linear-gradient(135deg, rgba(9, 25, 37, 0.98), rgba(16, 48, 59, 0.96))",
          color: "#ffffff",
          padding: "18px",
          margin: "0 0 22px",
          display: "grid",
          gridTemplateColumns: "48px minmax(0, 1fr) 24px",
          alignItems: "center",
          columnGap: "14px",
          textAlign: "left",
          cursor: "pointer",
          overflow: "hidden",
          appearance: "none",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: "48px",
            height: "48px",
            borderRadius: "14px",
            display: "grid",
            placeItems: "center",
            color: "#a3e635",
            background: "rgba(163, 230, 53, 0.11)",
            border: "1px solid rgba(163, 230, 53, 0.3)",
          }}
        >
          <Layers size={23} />
        </span>

        <span style={{ minWidth: 0, display: "grid", rowGap: "4px" }}>
          <span
            style={{
              color: "#a3e635",
              fontSize: "0.7rem",
              fontWeight: 800,
              lineHeight: 1.2,
              letterSpacing: "0.12em",
            }}
          >
            LEAGUE STRUCTURE
          </span>
          <span
            style={{
              color: "#ffffff",
              fontSize: "clamp(1rem, 2.5vw, 1.25rem)",
              fontWeight: 800,
              lineHeight: 1.25,
              overflowWrap: "anywhere",
            }}
          >
            Conference and division view
          </span>
          <span
            style={{
              color: "rgba(255,255,255,0.7)",
              fontSize: "0.88rem",
              lineHeight: 1.4,
              overflowWrap: "anywhere",
            }}
          >
            Browse the AFC and NFC by division.
          </span>
        </span>

        <ChevronRight aria-hidden="true" size={21} color="#a3e635" />
      </button>

      <div className="team-grid">
        {teams.map((team) => {
          const ratings = getTeamRatings(team);
          return (
            <button
              type="button"
              className="card api-team team-colour-card"
              key={team.id}
              style={getTeamTheme(team.abbreviation)}
              onClick={() => onOpenTeam(team)}
            >
              <span className="team-card-logo-stage">
                <TeamLogo team={team.abbreviation} size={74} />
              </span>
              <span className="team-card-copy">
                <strong>{team.full_name}</strong>
                <small>{team.conference} {team.division}</small>
                <small>
                  OVR {ratings.overall} {" • "}
                  OFF {ratings.offense} {" • "}
                  DEF {ratings.defense}
                </small>
              </span>
              <ArrowRight className="team-card-arrow" size={18} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
