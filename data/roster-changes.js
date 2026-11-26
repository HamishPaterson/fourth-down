// Roster moves reported before NFLverse or Sleeper reflect them. Each entry removes the
// player from that team everywhere the model uses rosters (roster feed, player ratings,
// injury pricing, quarterback changes). Remove an entry once the official roster shows it.
export default [
  {
    team: "PIT",
    name: "Aaron Rodgers",
    gsisId: "00-0023459",
    sleeperId: "96",
    change: "released",
    reportedAt: "2026-11-26",
    source: "Owner report; NFLverse weekly roster (Week 12) and Sleeper still list him as active",
  },
];
