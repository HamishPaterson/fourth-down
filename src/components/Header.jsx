import TeamLogo from "./TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";

// Brand mark on the left; on the right, the user's favourite team, which opens its team page.
export default function Header({ onHome, favoriteTeam, onOpenFavorite }) {
  return (
    <header className="header premium-header app-header">
      <button type="button" className="brand" onClick={onHome} aria-label="Fourth Down, this week's picks">
        <span className="brand-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 18 L12 6 L19 18" />
            <path d="M8.5 13h7" />
          </svg>
        </span>
        <strong>Fourth Down</strong>
      </button>

      {favoriteTeam && (
        <button type="button" className="header-round-button header-team-button" onClick={onOpenFavorite}
          aria-label={`Open ${TEAM_NAMES[favoriteTeam] || favoriteTeam}`}>
          <TeamLogo team={favoriteTeam} size={30} />
        </button>
      )}
    </header>
  );
}
