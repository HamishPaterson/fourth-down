import { getTeamRanks, ordinalRank as ordinal, rankBand } from "../services/teamRatings.js";

// The stats on a team card: division and record, then where the team ranks in the league
// overall, on offence and on defence (from ESPN's power ratings), with a plain-language label.

export default function TeamCardStats({ division, record, team }) {
  const ranks = getTeamRanks(team);
  const stats = [
    ["Overall", ranks.overall, "How strong the team is overall, ranked against all 32 teams (ESPN power rating)"],
    ["Offence", ranks.offense, "How good the offence is, ranked against all 32 teams"],
    ["Defence", ranks.defense, "How good the defence is, ranked against all 32 teams"],
  ];
  return (
    <span className="team-card-stats">
      <span className="team-card-meta">
        {division && <span className="team-card-division">{division}</span>}
        {record && <span className="team-card-record">{record}</span>}
      </span>
      <span className="team-card-ratings">
        {stats.map(([label, rank, title]) => (
          <span key={label} className="team-card-rating" title={title}
            aria-label={`${label}: ${ordinal(rank)} of ${ranks.total}${rankBand(rank) ? `, ${rankBand(rank)}` : ""}`}>
            <span className="team-card-rating-label">{label}</span>
            <span className="team-card-rating-value">{ordinal(rank)}</span>
            <span className="team-card-rating-band">{rankBand(rank) || "No rating"}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
