import TeamLogo from "./TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";

// Brand mark on the left; on the right, the user's favourite team, which opens its team page.
export default function Header({ onHome, favoriteTeam, onOpenFavorite, canGoBack = false }) {
  return (
    <header className={`header premium-header app-header${canGoBack ? " has-back" : ""}`}>
      <button type="button" className="brand" onClick={onHome} aria-label="Fourth Down, this week's picks">
        <span className="brand-mark" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24">
            <g transform="rotate(-40 12 12)">
              <path d="M1.5 12C5 5.6 19 5.6 22.5 12 19 18.4 5 18.4 1.5 12Z" fill="currentColor" />
              <g fill="none" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round">
                <path d="M8.6 12h6.8" />
                <path d="M9.9 10.7v2.6M12 10.5v3M14.1 10.7v2.6" />
                <path d="M4.6 9.6c.6 1.5.6 3.3 0 4.8M19.4 9.6c-.6 1.5-.6 3.3 0 4.8" />
              </g>
            </g>
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
