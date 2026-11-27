import { ChevronRight } from "lucide-react";
import TeamLogo from "./TeamLogo.jsx";
import { getTeamTheme } from "../services/teamThemes.js";
import { teamNickname } from "../services/teamAccent.js";

// Standings as in the design prototype: the leader on a light card, then a compact table.
// teams: [{ code, team, standing }] already in standings order. Rows open the team page.
export default function StandingsTable({ teams, leaderLabel, onSelectTeam, showSeeds = false }) {
  if (!teams.length) return null;
  const [leader] = teams;

  return (
    <div className="standings-block">
      <button type="button" className="standings-leader" style={getTeamTheme(leader.code)}
        onClick={() => onSelectTeam?.(leader.team)} aria-label={`${leader.team.full_name}, ${leaderLabel}. Open team page`}>
        <span className="standings-leader-logo"><TeamLogo team={leader.code} size={48} /></span>
        <span className="standings-leader-copy">
          <small>{leaderLabel}</small>
          <strong>{teamNickname(leader.code)}</strong>
          <span>{leaderDetail(leader.standing)}</span>
        </span>
        <span className="standings-leader-record">
          <strong>{record(leader.standing)}</strong>
          {leader.standing?.playoffSeed && <span>Seed {leader.standing.playoffSeed}</span>}
        </span>
      </button>

      <div className="standings-table" role="table" aria-label="Standings">
        <div className="standings-row standings-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Team</span>
          <span role="columnheader">W–L</span>
          <span role="columnheader">+/−</span>
          <span role="columnheader">Run</span>
        </div>
        {teams.map(({ code, team, standing }, index) => {
          const diff = Number(standing?.pointDifferential);
          const streak = String(standing?.streak || "");
          const seed = standing?.playoffSeed;
          return (
            <button type="button" role="row" key={code} className="standings-row" style={getTeamTheme(code)}
              onClick={() => onSelectTeam?.(team)} aria-label={`${index + 1}. ${team.full_name}, ${record(standing)}. Open team page`}>
              <span role="cell" className="standings-rank">{standing ? index + 1 : "—"}</span>
              <span role="cell" className="standings-team">
                <span className="standings-logo"><TeamLogo team={code} size={26} /></span>
                <span>{teamNickname(code)}</span>
                {showSeeds && seed && <small className="standings-seed" title="Playoff seed">{seed}</small>}
              </span>
              <span role="cell" className="standings-record">{record(standing)}</span>
              <span role="cell" className="standings-diff">{Number.isFinite(diff) ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff)}` : "—"}</span>
              <span role="cell" className={`standings-streak${streak.startsWith("W") ? " winning" : ""}`}>{streak || "—"}</span>
              <ChevronRight className="standings-chevron" size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {showSeeds && <p className="standings-note">Numbers beside a team are playoff seeds (top 7 make the playoffs).</p>}
    </div>
  );
}

function record(standing) {
  if (!standing) return "0–0";
  const { wins = 0, losses = 0, ties = 0 } = standing;
  return ties > 0 ? `${wins}–${losses}–${ties}` : `${wins}–${losses}`;
}

function leaderDetail(standing) {
  if (!standing) return "Season not started";
  const streak = String(standing.streak || "");
  const run = /^W(\d+)$/.exec(streak) ? `Won ${streak.slice(1)} straight` : /^L(\d+)$/.exec(streak) ? `Lost ${streak.slice(1)} straight` : null;
  const diff = Number(standing.pointDifferential);
  const points = Number.isFinite(diff) ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff)} points` : null;
  return [run, points].filter(Boolean).join(" · ") || "Leading";
}
