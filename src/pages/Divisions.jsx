import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { getTeams, getStandings } from "../services/nflApi.js";
import { getTeamTheme } from "../services/teamThemes.js";
import { getTeamRatings } from "../services/teamRatings.js";
import TeamLogo from "../components/TeamLogo.jsx";

// Canonical league structure. Controls dropdown order and division buckets.
const LEAGUE_STRUCTURE = [
  {
    conference: "AFC",
    divisions: [
      { name: "East", teams: ["BUF", "MIA", "NE", "NYJ"] },
      { name: "North", teams: ["BAL", "CIN", "CLE", "PIT"] },
      { name: "South", teams: ["HOU", "IND", "JAX", "TEN"] },
      { name: "West", teams: ["DEN", "KC", "LV", "LAC"] },
    ],
  },
  {
    conference: "NFC",
    divisions: [
      { name: "East", teams: ["DAL", "NYG", "PHI", "WSH"] },
      { name: "North", teams: ["CHI", "DET", "GB", "MIN"] },
      { name: "South", teams: ["ATL", "CAR", "NO", "TB"] },
      { name: "West", teams: ["ARI", "LAR", "SF", "SEA"] },
    ],
  },
];

// Flat list of all 8 divisions with an id + team list.
const ALL_DIVISIONS = LEAGUE_STRUCTURE.flatMap((conference) =>
  conference.divisions.map((division) => ({
    id: `${conference.conference} ${division.name}`,
    conference: conference.conference,
    name: division.name,
    teams: division.teams,
  }))
);

// Fallback names so cards render before live data arrives.
const TEAM_NAMES = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LV: "Las Vegas Raiders",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SF: "San Francisco 49ers",
  SEA: "Seattle Seahawks",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WSH: "Washington Commanders",
};

export default function Divisions({
  onSelectTeam,
  embedded = false,
  teams: teamsProp,
  standings: standingsProp,
}) {
  const [teams, setTeams] = useState(teamsProp || []);
  const [standings, setStandings] = useState(standingsProp || []);
  const [status, setStatus] = useState("Loading NFL teams...");
  const [selectedDivision, setSelectedDivision] = useState(ALL_DIVISIONS[0].id);

  const usingProps = teamsProp !== undefined;

  useEffect(() => {
    if (usingProps) {
      setTeams(teamsProp || []);
      setStandings(standingsProp || []);
      setStatus(`${(teamsProp || []).length} teams loaded`);
      return;
    }

    const controller = new AbortController();

    getTeams(controller.signal)
      .then((data) => {
        setTeams(data);
        setStatus(`${data.length} teams loaded`);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setStatus(error.message);
      });

    getStandings(controller.signal)
      .then((data) => setStandings(data))
      .catch((error) => {
        if (error.name !== "AbortError") {
          console.warn("Standings unavailable:", error.message);
        }
      });

    return () => controller.abort();
  }, [usingProps, teamsProp, standingsProp]);

  const teamsByCode = useMemo(() => {
    const map = {};
    for (const team of teams) {
      const code = normalizeTeamCode(team?.abbreviation);
      if (code) map[code] = team;
    }
    return map;
  }, [teams]);

  const standingsByCode = useMemo(() => {
    const map = {};
    for (const row of standings) {
      const code = normalizeTeamCode(row?.abbreviation);
      if (code) map[code] = row;
    }
    return map;
  }, [standings]);

  const division =
    ALL_DIVISIONS.find((d) => d.id === selectedDivision) || ALL_DIVISIONS[0];
  const rankedCodes = rankDivision(division.teams, standingsByCode);

  return (
    <section className={embedded ? "divisions-page embedded" : "divisions-page"}>
      {!embedded && (
        <div className="section-heading">
          <div>
            <span className="eyebrow">LEAGUE STRUCTURE</span>
            <h1>Divisions</h1>
          </div>
          <span className="count-pill">{status}</span>
        </div>
      )}

      <div className="schedule-controls division-controls">
        <label>
          Division
          <select
            value={selectedDivision}
            onChange={(event) => setSelectedDivision(event.target.value)}
          >
            {LEAGUE_STRUCTURE.map((conference) => (
              <optgroup label={conference.conference} key={conference.conference}>
                {conference.divisions.map((d) => (
                  <option
                    key={`${conference.conference} ${d.name}`}
                    value={`${conference.conference} ${d.name}`}
                  >
                    {conference.conference} {d.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <div className="team-grid">
        {rankedCodes.map((code, index) => {
          const liveTeam = teamsByCode[code];
          const standing = standingsByCode[code];
          const team = {
            abbreviation: code,
            full_name: TEAM_NAMES[code] || code,
            ...liveTeam,
            conference: division.conference,
            division: division.id,
          };
          const ratings = getTeamRatings(liveTeam || code);
          const rank = standing ? index + 1 : null;

          return (
            <button
              type="button"
              className="card api-team team-colour-card"
              key={code}
              style={getTeamTheme(code)}
              onClick={() => onSelectTeam?.(team)}
            >
              <span className="team-card-watermark" aria-hidden="true" />

              <span className="division-rank" aria-hidden="true">
                {rank ?? "—"}
              </span>

              <span className="team-card-logo">
                <TeamLogo team={code} size={76} />
              </span>

              <span className="team-card-copy">
                <strong>{team.full_name}</strong>
                <small>{division.id}</small>
                <small>{formatRecord(standing)}</small>
                <small>
                  OVR {ratings.overall}
                  {" • "}
                  OFF {ratings.offense}
                  {" • "}
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

// Order a division's teams by real standings.
// Prefers the API's division_rank; otherwise sorts by win% then wins.
// Falls back to the default listed order in the preseason (no data).
function rankDivision(codes, standingsByCode) {
  return [...codes].sort((a, b) => {
    const sa = standingsByCode[a];
    const sb = standingsByCode[b];

    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;

    if (sa.divisionRank != null && sb.divisionRank != null) {
      return sa.divisionRank - sb.divisionRank;
    }

    const pctA = sa.winPct ?? -1;
    const pctB = sb.winPct ?? -1;
    if (pctB !== pctA) return pctB - pctA;

    return (sb.wins ?? 0) - (sa.wins ?? 0);
  });
}

function formatRecord(standing) {
  if (!standing) return "0-0";
  const { wins = 0, losses = 0, ties = 0 } = standing;
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}
