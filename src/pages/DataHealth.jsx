import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Database, MinusCircle } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import { readDataHealthSnapshots } from "../services/dataHealth.js";

export default function DataHealth() {
  const [rows, setRows] = useState(() => readDataHealthSnapshots());
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    const refresh = () => setRows(readDataHealthSnapshots());
    window.addEventListener("storage", refresh);
    window.addEventListener("fourth-down-data-health-updated", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("fourth-down-data-health-updated", refresh);
    };
  }, []);

  const filtered = filter === "all" ? rows : rows.filter((row) => row.healthStatus === filter);
  const counts = useMemo(() => ({
    healthy: rows.filter((row) => row.healthStatus === "healthy").length,
    partial: rows.filter((row) => row.healthStatus === "partial").length,
    limited: rows.filter((row) => row.healthStatus === "limited").length,
  }), [rows]);

  return (
    <section className="data-health-page">
      <div className="section-heading data-health-heading">
        <div>
          <span className="eyebrow">MODEL AUDIT</span>
          <h1>Data Health</h1>
          <p>See which inputs loaded, what influenced each matchup, and where the model had limited data.</p>
        </div>
        <label className="data-health-filter">
          Status
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All matchups</option>
            <option value="healthy">Healthy</option>
            <option value="partial">Partial</option>
            <option value="limited">Limited</option>
          </select>
        </label>
      </div>

      <div className="data-health-summary-grid">
        <HealthSummary icon={<CheckCircle2 />} label="Healthy" value={counts.healthy} tone="healthy" />
        <HealthSummary icon={<AlertTriangle />} label="Partial" value={counts.partial} tone="partial" />
        <HealthSummary icon={<MinusCircle />} label="Limited" value={counts.limited} tone="limited" />
        <HealthSummary icon={<Database />} label="Audited" value={rows.length} tone="total" />
      </div>

      {filtered.length === 0 ? (
        <div className="card data-health-empty">
          <Activity size={30} />
          <h2>No matchup audits yet</h2>
          <p>Open a matchup to create its first model audit.</p>
        </div>
      ) : (
        <div className="data-health-grid">
          {filtered.map((row) => <AuditCard key={row.id} row={row} />)}
        </div>
      )}
    </section>
  );
}

function AuditCard({ row }) {
  const layers = Array.isArray(row.layers) ? row.layers : [];
  const sources = Object.values(row.sources || {});
  const totalAway = layers.reduce((sum, layer) => sum + number(layer.awayPoints), 0);
  const totalHome = layers.reduce((sum, layer) => sum + number(layer.homePoints), 0);
  const active = layers.filter((layer) => layer.status === "active").length;
  const neutral = layers.filter((layer) => layer.status === "measured-neutral").length;
  const unavailable = layers.filter((layer) => layer.status === "unavailable").length;

  return (
    <article className={`card data-health-card ${row.healthStatus || "limited"}`}>
      <div className="data-health-card-heading">
        <div>
          <span className="data-health-week">WEEK {row.week}</span>
          <h2>{teamName(row.awayCode)} <span>at</span> {teamName(row.homeCode)}</h2>
          <p>Checked {formatDate(row.checkedAt)}</p>
        </div>
        <StatusPill status={row.healthStatus || "limited"} />
      </div>

      <div className="data-health-stat-strip">
        <AuditStat label="Active layers" value={active} tone="active" />
        <AuditStat label="Measured neutral" value={neutral} />
        <AuditStat label="Unavailable" value={unavailable} tone={unavailable ? "warning" : "active"} />
      </div>

      <div className="data-health-content-grid">
        <section className="data-health-panel">
          <div className="data-health-panel-heading">
            <div><span className="eyebrow">CONNECTIONS</span><h3>Data sources</h3></div>
            <span>{sources.filter((source) => source?.available).length}/{sources.length} connected</span>
          </div>
          <div className="data-health-sources">
            {sources.map((source, index) => (
              <div className={source?.available ? "available" : "unavailable"} key={`${source?.label || "source"}-${index}`}>
                <span>{source?.available ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}</span>
                <div><strong>{source?.label || "Data source"}</strong><small>{source?.detail || (source?.available ? "Loaded" : "Unavailable")}</small></div>
              </div>
            ))}
          </div>
        </section>

        <section className="data-health-panel data-health-edge-panel">
          <span className="eyebrow">MODEL LAYER MATCHUP EDGE</span>
          <strong>{formatMatchupEdge(row.awayCode, row.homeCode, totalAway, totalHome)}</strong>
          <div className="data-health-edge-split">
            <div><small>{row.awayCode}</small><span>{formatSigned(totalAway)}</span></div>
            <div><small>{row.homeCode}</small><span>{formatSigned(totalHome)}</span></div>
          </div>
          <p>Combined point movement from the model layers listed below.</p>
        </section>
      </div>

      {Array.isArray(row.warnings) && row.warnings.length > 0 && (
        <div className="data-health-warnings">
          {row.warnings.map((warning) => <p key={warning}><AlertTriangle size={14} />{warning}</p>)}
        </div>
      )}

      <details className="data-health-details">
        <summary>View model layer breakdown</summary>
        <div className="data-health-layer-table">
          <div className="data-health-layer-row header"><strong>Model layer</strong><strong>{row.awayCode}</strong><strong>{row.homeCode}</strong><strong>Status</strong></div>
          {layers.map((layer) => (
            <div className={`data-health-layer-row ${layer.status === "active" ? "active" : layer.status === "unavailable" ? "unavailable" : "neutral"}`} key={layer.name}>
              <strong>{friendlyLayerName(layer.name)}</strong>
              <span>{formatSigned(layer.awayPoints)}</span>
              <span>{formatSigned(layer.homePoints)}</span>
              <span>{layerStatusLabel(layer)} · {Math.round(number(layer.confidence) * 100)}%</span>
            </div>
          ))}
          <div className="data-health-layer-row total"><strong>Total</strong><strong>{formatSigned(totalAway)}</strong><strong>{formatSigned(totalHome)}</strong><span /></div>
        </div>
      </details>
    </article>
  );
}

function HealthSummary({ icon, label, value, tone }) {
  return <div className={`card data-health-summary ${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
function AuditStat({ label, value, tone = "" }) { return <div className={tone}><strong>{value}</strong><small>{label}</small></div>; }
function StatusPill({ status }) { return <span className={`data-health-pill ${status}`}>{status.toUpperCase()}</span>; }
function teamName(code) { return TEAM_NAMES[code] || code; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function formatSigned(value) { const parsed = number(value); return `${parsed >= 0 ? "+" : ""}${parsed.toFixed(2)}`; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString(); }
function layerStatusLabel(layer) { return layer.status === "active" ? "Active" : layer.status === "measured-neutral" ? "Measured neutral" : "Unavailable"; }
function formatMatchupEdge(awayCode, homeCode, awayTotal, homeTotal) { const difference = number(homeTotal) - number(awayTotal); return Math.abs(difference) < 0.005 ? "No model-layer edge" : `${difference > 0 ? homeCode : awayCode} +${Math.abs(difference).toFixed(2)}`; }
function friendlyLayerName(name) { return String(name).replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
