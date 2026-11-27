import { useEffect, useMemo, useState } from "react";
import { getTeams, getStandings } from "../services/nflApi.js";
import StandingsTable from "../components/StandingsTable.jsx";
import Divisions from "./Divisions.jsx";
import FourthDownLoader from "../components/FourthDownLoader.jsx";
import { ConferenceTab } from "../components/LeagueTabs.jsx";
import { shouldShowBlockingLoader } from "../components/fourthDownLoader.js";

// All 16 teams per conference, grouped by division.
const CONFERENCES = [
  {
    name: "AFC",
    full: "American Football Conference",
    divisions: {
      East: ["BUF", "MIA", "NE", "NYJ"],
      North: ["BAL", "CIN", "CLE", "PIT"],
      South: ["HOU", "IND", "JAX", "TEN"],
      West: ["DEN", "KC", "LV", "LAC"],
    },
  },
  {
    name: "NFC",
    full: "National Football Conference",
    divisions: {
      East: ["DAL", "NYG", "PHI", "WSH"],
      North: ["CHI", "DET", "GB", "MIN"],
      South: ["ATL", "CAR", "NO", "TB"],
      West: ["ARI", "LAR", "SF", "SEA"],
    },
  },
];

// Flat list of a conference's 16 team codes.
function conferenceCodes(conference) {
  return Object.values(conference.divisions).flat();
}

// CODE -> "AFC East" style label.
const DIVISION_BY_CODE = (() => {
  const map = {};
  for (const conference of CONFERENCES) {
    for (const [division, codes] of Object.entries(conference.divisions)) {
      for (const code of codes) map[code] = `${conference.name} ${division}`;
    }
  }
  return map;
})();

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

export default function Conference({ onSelectTeam }) {
  const [teams, setTeams] = useState([]);
  const [standings, setStandings] = useState([]);
  const [status, setStatus] = useState("Loading NFL teams...");
  const [subView, setSubView] = useState("conference");
  const [selectedConference, setSelectedConference] = useState("AFC");

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

    getStandings(controller.signal)
      .then((data) => setStandings(data))
      .catch((error) => {
        if (error.name !== "AbortError") {
          console.warn("Standings unavailable:", error.message);
        }
      });

    return () => controller.abort();
  }, []);

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

  const conference = CONFERENCES.find((c) => c.name === selectedConference);
  const rankedCodes = rankConference(
    conferenceCodes(conference),
    standingsByCode
  );

  if (shouldShowBlockingLoader({
    loading: status.startsWith("Loading"),
    hasContent: teams.length > 0,
  })) {
    return <FourthDownLoader />;
  }

  return (
    <section className="conference-page">
      <div className="section-heading">
        <div>
          <p className="picks-kicker">Ladder and playoff seeds</p>
          <h1>Standings</h1>
        </div>
        <span className="count-pill">{status}</span>
      </div>

      {/* Sub-menu (reuses themed roster-tabs styling) */}
      <div
        className="roster-tabs conference-subnav"
        role="tablist"
        aria-label="Conference view"
      >
        <button
          type="button"
          className={subView === "conference" ? "roster-tab active" : "roster-tab"}
          onClick={() => setSubView("conference")}
        >
          Conference
        </button>
        <button
          type="button"
          className={subView === "divisions" ? "roster-tab active" : "roster-tab"}
          onClick={() => setSubView("divisions")}
        >
          Divisions
        </button>
      </div>

      {subView === "divisions" ? (
        <Divisions
          embedded
          onSelectTeam={onSelectTeam}
          teams={teams}
          standings={standings}
        />
      ) : (
        <>
          <div className="league-tiles conference-tiles conference-controls" role="tablist" aria-label="Conference">
            {CONFERENCES.map((c) => (
              <ConferenceTab key={c.name} name={c.name} active={selectedConference === c.name}
                onSelect={() => setSelectedConference(c.name)} />
            ))}
          </div>

          <StandingsTable
            showSeeds
            leaderLabel={standingsByCode[rankedCodes[0]]?.playoffSeed === 1 ? `${conference.name} top seed` : `${conference.name} leader`}
            secondLabel={standingsByCode[rankedCodes[1]]?.playoffSeed === 2 ? `${conference.name} 2 seed` : null}
            onSelectTeam={onSelectTeam}
            teams={rankedCodes.map((code) => ({
              code,
              standing: standingsByCode[code],
              team: { abbreviation: code, full_name: TEAM_NAMES[code] || code, ...teamsByCode[code], conference: conference.name, division: DIVISION_BY_CODE[code] },
            }))}
          />
        </>
      )}
    </section>
  );
}

// Rank a conference's teams. Prefers API conference_rank,
// else sorts by win% then wins. Preseason keeps listed order.
function rankConference(codes, standingsByCode) {
  return [...codes].sort((a, b) => {
    const sa = standingsByCode[a];
    const sb = standingsByCode[b];

    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;

    if (sa.conferenceRank != null && sb.conferenceRank != null) {
      return sa.conferenceRank - sb.conferenceRank;
    }

    const pctA = sa.winPct ?? -1;
    const pctB = sb.winPct ?? -1;
    if (pctB !== pctA) return pctB - pctA;

    return (sb.wins ?? 0) - (sa.wins ?? 0);
  });
}

function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}
