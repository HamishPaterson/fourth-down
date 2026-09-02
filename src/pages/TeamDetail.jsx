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

export default function TeamDetail({ team, onBack }) {
  const [rosterData, setRosterData] = useState(null);
  const [status, setStatus] = useState("Loading team roster...");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState("offense");

  const teamCode = normalizeTeamCode(team?.abbreviation);

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

  const starters = rosterData?.starters || [];
  const reserves = rosterData?.reserves || [];
  const groups = rosterData?.groups || {};

  const offense = starters.filter((player) =>
    OFFENSE_POSITIONS.has(normalizePosition(player.position))
  );

  const defense = starters.filter((player) =>
    DEFENSE_POSITIONS.has(normalizePosition(player.position))
  );

  const specialTeams = starters.filter((player) =>
    SPECIAL_TEAMS_POSITIONS.has(normalizePosition(player.position))
  );

  const activeCount = useMemo(() => {
    const allPlayers = Object.values(groups).flat();
    return allPlayers.filter((player) => player.active).length;
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
          <InfoRow label="Head coach" value="Not connected" />
          <InfoRow
            label="Home field"
            value="Not connected"
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
          <Rating label="Overall" value={null} />
          <Rating label="Offence" value={null} />
          <Rating label="Defence" value={null} />
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
        />
      )}
    </section>
  );
}

function RosterSection({ title, players }) {
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

          <PlayerGrid players={positionPlayers} />
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
  return [...players]
    .sort((first, second) => {
      const firstPosition = normalizePosition(first.position);
      const secondPosition = normalizePosition(second.position);
      const positionDifference = firstPosition.localeCompare(secondPosition);

      if (positionDifference !== 0) return positionDifference;

      const firstDepth = first.depthChartOrder ?? 999;
      const secondDepth = second.depthChartOrder ?? 999;

      if (firstDepth !== secondDepth) return firstDepth - secondDepth;

      return first.fullName.localeCompare(second.fullName);
    })
    .reduce((result, player) => {
      const position = normalizePosition(player.position) || "Other";
      result[position] ||= [];
      result[position].push(player);
      return result;
    }, {});
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

function PlayerGrid({ players }) {
  if (!players.length) {
    return <div className="card roster-empty">No players available in this view.</div>;
  }

  return (
    <div className="player-grid">
      {players.map((player) => (
        <PlayerCard key={player.id} player={player} />
      ))}
    </div>
  );
}

function PlayerCard({ player }) {
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

      <h3>{player.fullName}</h3>
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
