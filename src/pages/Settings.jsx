import { useState } from "react";
import { Activity, ChevronRight, Layers, Settings as SettingsIcon } from "lucide-react";
import { TEAM_NAMES } from "../data.js";

export default function Settings({ favoriteTeam, onSave, onNavigate }) {
  const [draft, setDraft] = useState(favoriteTeam);
  const [saved, setSaved] = useState(false);

  return (
    <section className="settings-page">
      <div className="section-heading settings-heading">
        <div>
          <span className="eyebrow">APP SETTINGS</span>
          <h1>Settings</h1>
          <p>Manage your preferences and open the app's supporting tools.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="card settings-card settings-preferences-card">
          <div className="settings-card-heading">
            <span className="settings-icon"><SettingsIcon size={20} /></span>
            <div><small>PREFERENCES</small><h2>Your app</h2></div>
          </div>
          <label>
            Favourite team
            <select value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); }}>
              {Object.entries(TEAM_NAMES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          <button className="primary settings-save-button" onClick={() => { onSave(draft); setSaved(true); }}>Save settings</button>
          {saved && <p className="success">Settings saved</p>}
        </section>

        <section className="card settings-card settings-tools-card">
          <div className="settings-card-heading">
            <span className="settings-icon"><Layers size={20} /></span>
            <div><small>TOOLS</small><h2>Model tools</h2></div>
          </div>
          <button type="button" className="settings-menu-item" onClick={() => onNavigate("data-health")}>
            <span className="settings-menu-icon"><Activity size={21} /></span>
            <span className="settings-menu-copy"><strong>Data Health</strong><small>Review model connections, active layers and matchup audits.</small></span>
            <ChevronRight size={20} />
          </button>
          <p className="note">API credentials remain in Vercel Environment Variables and are not exposed here.</p>
        </section>
      </div>
    </section>
  );
}
