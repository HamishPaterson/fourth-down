// The stats on a team card: division, record, and ESPN's FPI with its offence and defence parts,
// each in its own labelled box so they read at a glance.
function signed(value) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return "—";
  return `${number > 0 ? "+" : number < 0 ? "−" : ""}${Math.abs(number).toFixed(1)}`;
}

export default function TeamCardStats({ division, record, ratings }) {
  const stats = [
    ["FPI", ratings?.overall, "ESPN Football Power Index: points better than an average team"],
    ["OFF", ratings?.offense, "Offence's share of FPI"],
    ["DEF", ratings?.defense, "Defence's share of FPI"],
  ];
  return (
    <span className="team-card-stats">
      <span className="team-card-meta">
        {division && <span className="team-card-division">{division}</span>}
        {record && <span className="team-card-record">{record}</span>}
      </span>
      <span className="team-card-ratings">
        {stats.map(([label, value, title]) => (
          <span key={label} className="team-card-rating" title={title}>
            <span className="team-card-rating-label">{label}</span>
            <span className="team-card-rating-value">{signed(value)}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
