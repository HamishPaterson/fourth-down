import { useEffect, useState } from "react";
import { CalendarDays, Clock, MapPin, RefreshCw } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import { getTeamTheme } from "../services/teamThemes.js";
import TeamLogo from "../components/TeamLogo.jsx";

export default function Matchup({ game, onBack }) {
  const [liveGame, setLiveGame] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [teamStats, setTeamStats] = useState(null);
  const [statsStatus, setStatsStatus] = useState("");
  const [statsLoading, setStatsLoading] = useState(false);

  async function loadGame() {
    if (!game?.id) return;
    setLoading(true);
    setStatus("Loading latest game information...");

    try {
      const response = await fetch(`/api/nfl/game?id=${encodeURIComponent(game.id)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Game request failed (${response.status})`);
      setLiveGame(body.game || null);
      setStatus(body.refreshedAt ? `Game updated ${new Date(body.refreshedAt).toLocaleTimeString()}` : "Game information updated");
    } catch (error) {
      console.error("Game loading failed", error);
      setLiveGame(null);
      setStatus(error instanceof Error ? error.message : "Game information could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  async function loadTeamStats() {
    if (!game?.id) return;
    setStatsLoading(true);
    setStatsStatus("Loading live team statistics...");

    try {
      const response = await fetch(`/api/nfl/game-stats?id=${encodeURIComponent(game.id)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Statistics request failed (${response.status})`);
      setTeamStats(body.teams || {});
      setStatsStatus(body.recordCount > 0 ? `${body.recordCount} player statistic records loaded` : "Team statistics will appear once available.");
    } catch (error) {
      console.error("Team statistics loading failed", error);
      setTeamStats(null);
      setStatsStatus(error instanceof Error ? error.message : "Team statistics could not be loaded");
    } finally {
      setStatsLoading(false);
    }
  }

  useEffect(() => {
    loadGame();
    loadTeamStats();
  }, [game?.id]);

  if (!game) {
    return (
      <section className="card empty">
        <h1>No matchup selected</h1>
        <p>Open a game from the Schedule page.</p>
        <button type="button" className="primary" onClick={onBack}>Go to Schedule</button>
      </section>
    );
  }

  const awayCode = normalizeTeamCode(liveGame?.visitor_team?.abbreviation || game.away);
  const homeCode = normalizeTeamCode(liveGame?.home_team?.abbreviation || game.home);
  const matchupTheme = createMatchupTheme(awayCode, homeCode);
  const kickoff = new Date(liveGame?.date || game.sourceDate || game.date);
  const validKickoff = !Number.isNaN(kickoff.getTime());
  const dateText = validKickoff ? kickoff.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : game.date;
  const timeText = validKickoff ? kickoff.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : game.time;
  const gameStatus = liveGame?.status_state || liveGame?.status || game.status || "Scheduled";
  const awayScore = liveGame?.visitor_team_score ?? game.awayScore ?? null;
  const homeScore = liveGame?.home_team_score ?? game.homeScore ?? null;
  const hasScore = awayScore !== null || homeScore !== null;

  async function refreshAll() {
    await Promise.all([loadGame(), loadTeamStats()]);
  }

  return (
    <section className="matchup-page-themed" style={matchupTheme}>
      <span className="matchup-page-away-watermark" aria-hidden="true" />
      <span className="matchup-page-home-watermark" aria-hidden="true" />

      <div className="matchup-toolbar">
        <button type="button" className="secondary matchup-away-action" onClick={onBack}>Back to Schedule</button>
        <button type="button" className="secondary refresh-button matchup-home-action" onClick={refreshAll} disabled={loading || statsLoading}>
          <RefreshCw size={16} className={loading || statsLoading ? "spin" : ""} />
          Refresh game
        </button>
      </div>

      <div className="card matchup-card matchup-battle-card">
        <div className="game-meta matchup-battle-meta">
          <span>Regular season · Week {liveGame?.week || game.week}</span>
          <span className="game-status">{formatStatus(gameStatus)}</span>
        </div>

        <div className="matchup-row matchup-battle-row">
          <LargeTeam code={awayCode} label="Away" score={awayScore} showScore={hasScore} side="away" />
          <div className="versus large matchup-battle-versus"><small>MATCHUP</small><strong>VS</strong></div>
          <LargeTeam code={homeCode} label="Home" score={homeScore} showScore={hasScore} side="home" />
        </div>

        <div className="matchup-details-grid matchup-colour-details">
          <GameDetail className="away-detail" icon={<CalendarDays size={18} />} label="Date" value={dateText} />
          <GameDetail className="split-detail" icon={<Clock size={18} />} label="Local time" value={timeText} />
          <GameDetail className="home-detail" icon={<MapPin size={18} />} label="Venue" value={liveGame?.venue || game.venue || "Venue unavailable"} />
        </div>

        {liveGame ? <QuarterScoreTable game={liveGame} awayCode={awayCode} homeCode={homeCode} /> : <EmptyPanel title="Scoring by quarter" text="Quarter scores will appear once game information is available." />}

        <TeamStatistics awayCode={awayCode} homeCode={homeCode} stats={teamStats} status={statsStatus} loading={statsLoading} onRefresh={loadTeamStats} />
      </div>

      {status && <div className={isErrorMessage(status) ? "schedule-status schedule-error" : "schedule-status matchup-update-status"}>{status}</div>}
    </section>
  );
}

function LargeTeam({ code, label, score, showScore, side }) {
  return (
    <div className={`large-team battle-team battle-team-${side}`}>
      <span className="battle-logo-stage"><TeamLogo team={code} size={150} /></span>
      <h2>{TEAM_NAMES[code] || code}</h2>
      <small>{label}</small>
      {showScore && <div className="live-team-score">{score ?? 0}</div>}
    </div>
  );
}

function GameDetail({ icon, label, value, className = "" }) {
  return (
    <div className={`matchup-detail ${className}`}>
      <span className="matchup-detail-icon">{icon}</span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

function EmptyPanel({ title, text }) {
  return <div className="quarter-score-empty matchup-split-panel"><strong>{title}</strong><span>{text}</span></div>;
}

function QuarterScoreTable({ game, awayCode, homeCode }) {
  const awayScores = [game.visitor_team_q1, game.visitor_team_q2, game.visitor_team_q3, game.visitor_team_q4, game.visitor_team_ot];
  const homeScores = [game.home_team_q1, game.home_team_q2, game.home_team_q3, game.home_team_q4, game.home_team_ot];
  const hasQuarterData = [...awayScores, ...homeScores].some((score) => score !== null && score !== undefined);

  if (!hasQuarterData) return <EmptyPanel title="Scoring by quarter" text="Quarter scores will appear here once the game begins." />;

  return (
    <div className="quarter-score-wrapper">
      <h3>Scoring by quarter</h3>
      <div className="quarter-score-table matchup-quarter-table">
        <div className="quarter-score-row quarter-score-header"><span>Team</span><span>Q1</span><span>Q2</span><span>Q3</span><span>Q4</span><span>OT</span><span>Total</span></div>
        <QuarterScoreRow code={awayCode} scores={awayScores} total={game.visitor_team_score} side="away" />
        <QuarterScoreRow code={homeCode} scores={homeScores} total={game.home_team_score} side="home" />
      </div>
    </div>
  );
}

function QuarterScoreRow({ code, scores, total, side }) {
  return <div className={`quarter-score-row matchup-quarter-${side}`}><strong>{code}</strong>{scores.map((score, index) => <span key={index}>{score ?? "-"}</span>)}<strong>{total ?? "-"}</strong></div>;
}

function TeamStatistics({ awayCode, homeCode, stats, status, loading, onRefresh }) {
  const awayStats = stats?.[awayCode];
  const homeStats = stats?.[homeCode];
  const rows = [
    ["Total offence", awayStats?.totalOffense, homeStats?.totalOffense, " yds"],
    ["Passing yards", awayStats?.passingYards, homeStats?.passingYards, " yds"],
    ["Rushing yards", awayStats?.rushingYards, homeStats?.rushingYards, " yds"],
    ["Pass completions", formatFraction(awayStats?.passingCompletions, awayStats?.passingAttempts), formatFraction(homeStats?.passingCompletions, homeStats?.passingAttempts), ""],
    ["Completion rate", awayStats?.completionPercentage, homeStats?.completionPercentage, "%"],
    ["Rushing attempts", awayStats?.rushingAttempts, homeStats?.rushingAttempts, ""],
    ["Rush average", awayStats?.yardsPerRush, homeStats?.yardsPerRush, " yds"],
    ["Passing touchdowns", awayStats?.passingTouchdowns, homeStats?.passingTouchdowns, ""],
    ["Rushing touchdowns", awayStats?.rushingTouchdowns, homeStats?.rushingTouchdowns, ""],
    ["Turnovers", awayStats?.turnovers, homeStats?.turnovers, ""],
    ["Sacks", awayStats?.sacks, homeStats?.sacks, ""],
    ["Total tackles", awayStats?.totalTackles, homeStats?.totalTackles, ""],
  ];
  const hasStats = Boolean(awayStats || homeStats);

  return (
    <div className="team-statistics matchup-team-statistics">
      <div className="team-statistics-heading">
        <div><span className="eyebrow">LIVE GAME DATA</span><h3>Team statistics</h3></div>
        <button type="button" className="secondary refresh-button" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh stats</button>
      </div>
      {!hasStats ? <div className="team-statistics-empty matchup-split-panel">{status || "Team statistics will appear once available."}</div> : (
        <><div className="team-statistics-table matchup-stats-table"><div className="team-statistics-row team-statistics-header"><strong>{awayCode}</strong><span>Statistic</span><strong>{homeCode}</strong></div>{rows.map(([label, away, home, suffix]) => <StatRow key={label} label={label} away={away} home={home} suffix={suffix} />)}</div>{status && <div className="team-statistics-status">{status}</div>}</>
      )}
    </div>
  );
}

function StatRow({ label, away, home, suffix = "" }) {
  return <div className="team-statistics-row matchup-stat-row"><strong>{formatStatValue(away, suffix)}</strong><span>{label}</span><strong>{formatStatValue(home, suffix)}</strong></div>;
}

function createMatchupTheme(awayCode, homeCode) {
  const away = getTeamTheme(awayCode);
  const home = getTeamTheme(homeCode);
  return {
    "--away-primary": away["--team-primary"],
    "--away-secondary": away["--team-secondary"],
    "--away-watermark": away["--team-watermark"],
    "--home-primary": home["--team-primary"],
    "--home-secondary": home["--team-secondary"],
    "--home-watermark": home["--team-watermark"],
  };
}

function formatStatValue(value, suffix = "") { return value === null || value === undefined || value === "" ? "-" : `${value}${suffix}`; }
function formatFraction(first, second) { return first === null || first === undefined || second === null || second === undefined ? null : `${first}/${second}`; }
function normalizeTeamCode(code) { const normalized = String(code || "").toUpperCase(); const aliases = { WAS: "WSH", LA: "LAR" }; return aliases[normalized] || normalized; }
function formatStatus(status) { const normalized = String(status || ""); return normalized ? normalized.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()) : "Scheduled"; }
function isErrorMessage(message) { const normalized = String(message || "").toLowerCase(); return normalized.includes("failed") || normalized.includes("error") || normalized.includes("invalid"); }
