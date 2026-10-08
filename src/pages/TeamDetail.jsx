import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  MapPin,
  RefreshCw,
  Shield,
  Trophy,
  Users,
} from "lucide-react";
import TeamLogo from "../components/TeamLogo.jsx";
import { getTeamTheme } from "../services/teamThemes.js";
import { getTeamRatings } from "../services/teamRatings.js";
import { getPlayerRating } from "../services/playerRatings.js";

const OFFENSE_POSITIONS = new Set([
  "QB",
  "RB",
  "FB",
  "WR",
  "TE",
  "C",
  "G",
  "OG",
  "T",
  "OT",
  "OL",
]);

const DEFENSE_POSITIONS = new Set([
  "DL",
  "DE",
  "DT",
  "NT",
  "LB",
  "ILB",
  "OLB",
  "MLB",
  "CB",
  "DB",
  "S",
  "FS",
  "SS",
]);

const SPECIAL_TEAMS_POSITIONS = new Set([
  "K",
  "P",
  "LS",
  "KR",
  "PR",
]);

const TEAM_INFO = {
  ARI: { headCoach: "Mike LaFleur", homeField: "State Farm Stadium" },
  ATL: { headCoach: "Kevin Stefanski", homeField: "Mercedes-Benz Stadium" },
  BAL: { headCoach: "Jesse Minter", homeField: "M&T Bank Stadium" },
  BUF: { headCoach: "Joe Brady", homeField: "Highmark Stadium" },
  CAR: { headCoach: "Dave Canales", homeField: "Bank of America Stadium" },
  CHI: { headCoach: "Ben Johnson", homeField: "Soldier Field" },
  CIN: { headCoach: "Zac Taylor", homeField: "Paycor Stadium" },
  CLE: { headCoach: "Todd Monken", homeField: "Huntington Bank Field" },
  DAL: { headCoach: "Brian Schottenheimer", homeField: "AT&T Stadium" },
  DEN: { headCoach: "Sean Payton", homeField: "Empower Field at Mile High" },
  DET: { headCoach: "Dan Campbell", homeField: "Ford Field" },
  GB: { headCoach: "Matt LaFleur", homeField: "Lambeau Field" },
  HOU: { headCoach: "DeMeco Ryans", homeField: "NRG Stadium" },
  IND: { headCoach: "Shane Steichen", homeField: "Lucas Oil Stadium" },
  JAX: { headCoach: "Liam Coen", homeField: "EverBank Stadium" },
  KC: { headCoach: "Andy Reid", homeField: "GEHA Field at Arrowhead Stadium" },
  LV: { headCoach: "Klint Kubiak", homeField: "Allegiant Stadium" },
  LAC: { headCoach: "Jim Harbaugh", homeField: "SoFi Stadium" },
  LAR: { headCoach: "Sean McVay", homeField: "SoFi Stadium" },
  MIA: { headCoach: "Jeff Hafley", homeField: "Hard Rock Stadium" },
  MIN: { headCoach: "Kevin O'Connell", homeField: "U.S. Bank Stadium" },
  NE: { headCoach: "Mike Vrabel", homeField: "Gillette Stadium" },
  NO: { headCoach: "Kellen Moore", homeField: "Caesars Superdome" },
  NYG: { headCoach: "John Harbaugh", homeField: "MetLife Stadium" },
  NYJ: { headCoach: "Aaron Glenn", homeField: "MetLife Stadium" },
  PHI: { headCoach: "Nick Sirianni", homeField: "Lincoln Financial Field" },
  PIT: { headCoach: "Mike McCarthy", homeField: "Acrisure Stadium" },
  SF: { headCoach: "Kyle Shanahan", homeField: "Levi's Stadium" },
  SEA: { headCoach: "Mike Macdonald", homeField: "Lumen Field" },
  TB: { headCoach: "Todd Bowles", homeField: "Raymond James Stadium" },
  TEN: { headCoach: "Robert Saleh", homeField: "Nissan Stadium" },
  WSH: { headCoach: "Dan Quinn", homeField: "Northwest Stadium" },
};

function getTeamInfo(code) {
  return TEAM_INFO[code] || {};
}

export default function TeamDetail({ team, onBack }) {
  const [rosterData, setRosterData] = useState(null);
  const [status, setStatus] = useState("Loading team roster...");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState("offense");

  const teamCode = normalizeTeamCode(team?.abbreviation);
const ratings = getTeamRatings(teamCode);
const teamInfo = getTeamInfo(teamCode);

  async function loadRoster() {
    if (!teamCode) return;

    setLoading(true);
    setStatus("Loading team roster...");

    try {
      const response = await fetch(
        `/api/nfl/sleeper-players?team=${encodeURIComponent(teamCode)}`
      );
      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.error || `Roster request failed (${response.status})`
        );
      }

      setRosterData(body);
      setStatus(`${body.count ?? 0} players loaded`);
    } catch (error) {
      console.error("Roster loading failed", error);
      setRosterData(null);
      setStatus(
        error instanceof Error ? error.message : "Roster could not be loaded"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRoster();
  }, [teamCode]);

  const starters = Array.isArray(rosterData?.starters) ? rosterData.starters : [];
  const reserves = Array.isArray(rosterData?.reserves) ? rosterData.reserves : [];
  const groups = rosterData?.groups && typeof rosterData.groups === "object"
    ? rosterData.groups
    : {};
const offensiveLine =
  groups["Offensive Line"] || [];

 const offensiveSkillStarters =
  starters.filter((player) => {
    const position =
      normalizePosition(
        player.position
      );

    return (
      OFFENSE_POSITIONS.has(
        position
      ) &&
      !isOffensiveLinePosition(
        position
      )
    );
  });

const offense = deduplicatePlayers([
  ...offensiveSkillStarters,
  ...offensiveLine,
]);

  const defense = starters.filter((player) =>
    DEFENSE_POSITIONS.has(normalizePosition(player.position))
  );

  const specialTeams = starters.filter((player) =>
    SPECIAL_TEAMS_POSITIONS.has(normalizePosition(player.position))
  );

  const activeCount = useMemo(() => {
    const allPlayers = Object.values(groups).flatMap((group) =>
      Array.isArray(group) ? group : []
    );
    return allPlayers.filter((player) => player?.active).length;
  }, [groups]);

  if (!team) {
    return (
      <section className="card empty">
        <h1>No team selected</h1>
        <p>Open a team from the Teams page.</p>
        <button type="button" className="primary" onClick={onBack}>
          Back to Teams
        </button>
      </section>
    );
  }

  return (
    <section
      className="team-detail-page"
      style={getTeamTheme(teamCode)}
    >
      <div className="team-detail-toolbar">
        <button type="button" className="secondary" onClick={onBack}>
          ← Back to Teams
        </button>

        <button
          type="button"
          className="secondary refresh-button"
          onClick={loadRoster}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          Refresh roster
        </button>
      </div>

      <div className="card franchise-hero">
        <TeamLogo team={teamCode} size={150} />

        <div className="franchise-hero-copy">
          <span className="eyebrow">TEAM PROFILE</span>
          <h1>{team.full_name}</h1>
          <p>
            {team.conference} · {team.division}
          </p>
          <span className="team-data-status">{status}</span>
        </div>
      </div>

      <div className="franchise-summary-grid">
        <SummaryCard
          icon={<Shield size={20} />}
          label="Conference"
          value={team.conference || "Unavailable"}
        />
        <SummaryCard
          icon={<Trophy size={20} />}
          label="Division"
          value={team.division || "Unavailable"}
        />
        <SummaryCard
          icon={<Users size={20} />}
          label="Roster"
          value={rosterData ? `${rosterData.count} players` : "Unavailable"}
        />
        <SummaryCard
          icon={<Activity size={20} />}
          label="Active players"
          value={rosterData ? String(activeCount) : "Unavailable"}
        />
      </div>

      <div className="team-information-grid">
        <div className="card team-information-card">
          <span className="eyebrow">TEAM INFORMATION</span>
          <h2>Franchise details</h2>
          <InfoRow label="Head coach" value={teamInfo.headCoach} />
          <InfoRow
            label="Home field"
            value={teamInfo.homeField}
            icon={<MapPin size={15} />}
          />
          <InfoRow label="Conference" value={team.conference} />
          <InfoRow label="Division" value={team.division} />
        </div>

        <div className="card team-information-card">
          <span className="eyebrow">SEASON PERFORMANCE</span>
          <h2>Standings</h2>
          <InfoRow label="Ladder position" value="Not connected" />
          <InfoRow label="Record" value="Not connected" />
          <InfoRow label="Win percentage" value="Not connected" />
          <InfoRow label="Points for / against" value="Not connected" />
        </div>
      </div>

      <div className="card ratings-card">
        <div className="ratings-heading">
          <div>
            <span className="eyebrow">TEAM RATINGS</span>
            <h2>Performance ratings</h2>
          </div>
          <span className="ratings-note">Waiting for season statistics</span>
        </div>

        <div className="ratings-grid">
          <Rating label="OVR" value={ratings.overall} />
<Rating label="OFF" value={ratings.offense} />
<Rating label="DEF" value={ratings.defense} />

          <Rating label="Avg passing yards" value={null} suffix=" yds" />
          <Rating label="Avg rushing yards" value={null} suffix=" yds" />
          <Rating label="Win percentage" value={null} suffix="%" />
        </div>
      </div>

      <div className="roster-heading">
        <div>
          <span className="eyebrow">SLEEPER PLAYER DATA</span>
          <h2>Team roster</h2>
        </div>

        <div className="roster-tabs" role="tablist" aria-label="Roster view">
          <RosterTab
            active={view === "offense"}
            onClick={() => setView("offense")}
          >
            Offense ({offense.length})
          </RosterTab>
          <RosterTab
            active={view === "defense"}
            onClick={() => setView("defense")}
          >
            Defense ({defense.length})
          </RosterTab>
          <RosterTab
            active={view === "special-teams"}
            onClick={() => setView("special-teams")}
          >
            Special Teams ({specialTeams.length})
          </RosterTab>
          <RosterTab
            active={view === "reserves"}
            onClick={() => setView("reserves")}
          >
            Reserves ({reserves.length})
          </RosterTab>
        </div>
      </div>

      {!rosterData && loading ? (
        <div className="card roster-empty">Loading roster...</div>
      ) : !rosterData ? (
        <div className="card roster-empty">{status}</div>
      ) : (
        <RosterSection
          title={getRosterTitle(view)}
          players={getRosterPlayers({
            view,
            offense,
            defense,
            specialTeams,
            reserves,
          })}
          teamCode={teamCode}
        />
      )}
    </section>
  );
}

function RosterSection({ title, players, teamCode }) {
  const groupedPlayers = groupPlayersByPosition(players);

  if (!players.length) {
    return (
      <div className="card roster-empty">
        No players available in {title.toLowerCase()}.
      </div>
    );
  }

  return (
    <div className="position-groups">
      {Object.entries(groupedPlayers).map(([position, positionPlayers]) => (
        <div className="card position-group" key={position}>
          <div className="position-group-header position-group-header-static">
            <span>
              <strong>{position}</strong>
              <small>{positionPlayers.length} players</small>
            </span>
          </div>

          <PlayerGrid players={positionPlayers} teamCode={teamCode} />
        </div>
      ))}
    </div>
  );
}

function getRosterTitle(view) {
  const titles = {
    offense: "Offense",
    defense: "Defense",
    "special-teams": "Special Teams",
    reserves: "Reserves",
  };

  return titles[view] || "Roster";
}

function getRosterPlayers({
  view,
  offense,
  defense,
  specialTeams,
  reserves,
}) {
  if (view === "offense") return offense;
  if (view === "defense") return defense;
  if (view === "special-teams") return specialTeams;
  return reserves;
}

function groupPlayersByPosition(players) {
  const positionOrder = [
    "QB", "RB", "FB", "WR", "TE",
    "LT", "LG", "C", "RG", "RT", "G", "OG", "T", "OT", "OL",
    "DE", "DT", "NT", "EDGE", "LB", "ILB", "OLB", "MLB",
    "CB", "FS", "SS", "S", "DB", "K", "P", "LS", "KR", "PR",
  ];

  const rank = (position) => {
    const index = positionOrder.indexOf(position);
    return index === -1 ? positionOrder.length : index;
  };

  return [...(Array.isArray(players) ? players.filter(Boolean) : [])]
    .sort((first, second) => {
      const positionDifference =
        rank(normalizePosition(first?.position)) -
        rank(normalizePosition(second?.position));

      if (positionDifference !== 0) return positionDifference;

      const depthDifference =
        (first?.depthChartOrder ?? 999) -
        (second?.depthChartOrder ?? 999);

      if (depthDifference !== 0) return depthDifference;

      return String(first?.fullName || first?.name || "").localeCompare(
        String(second?.fullName || second?.name || "")
      );
    })
    .reduce((result, player) => {
      const position = normalizePosition(player?.position) || "Other";
      result[position] ||= [];
      result[position].push(player);
      return result;
    }, {});
}

function isOffensiveLinePosition(position) {
  return ["LT", "LG", "C", "RG", "RT", "G", "OG", "T", "OT", "OL"].includes(
    normalizePosition(position)
  );
}

function deduplicatePlayers(players) {
  const unique = new Map();

  for (const player of Array.isArray(players) ? players : []) {
    if (!player) continue;
    const key = String(
      player.id || player.player_id ||
      `${player.fullName || player.name || "unknown"}-${player.position || ""}`
    );
    if (!unique.has(key)) unique.set(key, player);
  }

  return [...unique.values()];
}

function normalizePosition(position) {
  return String(position || "").trim().toUpperCase();
}

function SummaryCard({ icon, label, value }) {
  return (
    <div className="card franchise-summary-card">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function InfoRow({ label, value, icon }) {
  return (
    <div className="team-info-row">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value || "Unavailable"}</strong>
    </div>
  );
}

function Rating({ label, value, suffix = "" }) {
  const displayValue = value === null || value === undefined ? "-" : `${value}${suffix}`;

  return (
    <div className="rating-item">
      <small>{label}</small>
      <strong>{displayValue}</strong>
    </div>
  );
}

function RosterTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={active ? "roster-tab active" : "roster-tab"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PlayerGrid({ players, teamCode }) {
  if (!players.length) {
    return <div className="card roster-empty">No players available in this view.</div>;
  }

  return (
    <div className="player-grid">
      {players.map((player) => (
        <PlayerCard key={player.id} player={player} teamCode={teamCode} />
      ))}
    </div>
  );
}

function PlayerCard({ player, teamCode }) {
  const maddenRating = getPlayerRating(player, teamCode);
  return (
    <article className="card player-card">
      <div className="player-card-header">
        <span className="player-number">
          {player.jerseyNumber !== null ? `#${player.jerseyNumber}` : "-"}
        </span>
        <span className={player.active ? "player-status active" : "player-status"}>
          {player.status || "Unknown"}
        </span>
      </div>

      <div className="player-name-row">
        <h3>{player.fullName}</h3>
        <span className="player-overall" title="Madden overall rating">
          {maddenRating ? `${maddenRating.overall} OVR` : "NR"}
        </span>
      </div>
      <p>
        {player.position}
        {player.depthChartOrder !== null
          ? ` · Depth ${player.depthChartOrder}`
          : ""}
      </p>

      <div className="player-meta-grid">
        <PlayerMeta label="Age" value={player.age} />
        <PlayerMeta label="Height" value={formatHeight(player.height)} />
        <PlayerMeta label="Weight" value={formatWeight(player.weight)} />
        <PlayerMeta label="Experience" value={formatExperience(player.yearsExperience)} />
      </div>

      <div className="player-college">
        <small>College</small>
        <strong>{player.college || "Unavailable"}</strong>
      </div>

      {player.injuryStatus && (
        <div className="player-injury">Injury: {player.injuryStatus}</div>
      )}
    </article>
  );
}

function PlayerMeta({ label, value }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function formatHeight(value) {
  const inches = Number(value);
  if (!Number.isFinite(inches)) return value || "-";
  return `${Math.floor(inches / 12)}'${inches % 12}\"`;
}

function formatWeight(value) {
  if (value === null || value === undefined || value === "") return "-";
  return `${value} lb`;
}

function formatExperience(value) {
  if (value === null || value === undefined) return "-";
  if (value === 0) return "Rookie";
  return `${value} yr${value === 1 ? "" : "s"}`;
}


function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}
