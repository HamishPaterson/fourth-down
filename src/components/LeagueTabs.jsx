import TeamLogo from "./TeamLogo.jsx";
import { TEAM_THEMES } from "../services/teamThemes.js";

const CONFERENCE_STYLE = {
  AFC: { logo: "/conferences/afc.png", color: "#D50A0A", full: "American Football Conference" },
  NFC: { logo: "/conferences/nfc.png", color: "#013369", full: "National Football Conference" },
};

// A large conference tab: the conference logo on its own colour.
export function ConferenceTab({ name, active, onSelect }) {
  const style = CONFERENCE_STYLE[name];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "league-tile conference-tile active" : "league-tile conference-tile"}
      style={{ "--league-color": style.color }}
      onClick={onSelect}
    >
      <span className="conference-tile-logo"><img src={style.logo} alt="" /></span>
      <span className="league-tile-label">
        <strong>{name}</strong>
        <small>{style.full}</small>
      </span>
    </button>
  );
}

// A division tab: one stripe per team in its colours, with its logo, like a division banner.
export function DivisionTab({ conference, name, teams, active, onSelect }) {
  const label = `${conference} ${name}`;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      className={active ? "league-tile division-tile active" : "league-tile division-tile"}
      style={{ "--league-color": CONFERENCE_STYLE[conference]?.color }}
      onClick={onSelect}
    >
      <span className="division-tile-stripes">
        {teams.map((code) => (
          <span key={code} className="division-tile-stripe" style={{ "--stripe": TEAM_THEMES[code]?.[0] || "#1f2937" }}>
            <TeamLogo team={code} size={52} className="division-tile-logo" />
          </span>
        ))}
      </span>
      <span className="division-tile-label">
        <small>{conference}</small>
        <strong>{name}</strong>
      </span>
    </button>
  );
}
