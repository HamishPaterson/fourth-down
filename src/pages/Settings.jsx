import { useState } from "react";
import { Activity, ChevronRight, Layers, ScrollText, Settings as SettingsIcon } from "lucide-react";
import { TEAM_NAMES } from "../data.js";
import TeamLogo from "../components/TeamLogo.jsx";
import TeamPicker from "../components/TeamPicker.jsx";
import { PatchNotesList } from "../components/PatchNotes.jsx";
import { PATCH_NOTES } from "../patchNotes.js";

export default function Settings({ favoriteTeam, onSave, onNavigate }) {
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [picking, setPicking] = useState(false);

  function saveTeam(team) {
    setPicking(false);
    try {
      onSave(team);
      setSaved(true);
      setSaveError(null);
    } catch (error) {
      console.warn("Favourite team preference could not be saved", error);
      setSaved(false);
      setSaveError("Your favourite team could not be saved. Please try again.");
    }
  }

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
          <div className="settings-team-row">
            <span className="settings-team-logo">
              {favoriteTeam ? <TeamLogo team={favoriteTeam} size={44} /> : <span className="settings-team-swatch" aria-hidden="true" />}
            </span>
            <span className="settings-team-copy">
              <small>Favourite team</small>
              <strong>{favoriteTeam ? TEAM_NAMES[favoriteTeam] : "No team · Fourth Down orange"}</strong>
            </span>
            <button type="button" className="secondary" onClick={() => { setSaved(false); setPicking(true); }}>
              {favoriteTeam ? "Change" : "Choose"}
            </button>
          </div>
          <p className="note settings-team-note">The app uses your team's colours. Your choice is saved to your account.</p>
          {saved && <p className="success">Favourite team saved</p>}
          {saveError && <p role="alert">{saveError}</p>}
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

        <section className="card settings-card settings-patch-notes-card" id="patch-notes">
          <div className="settings-card-heading">
            <span className="settings-icon"><ScrollText size={20} /></span>
            <div><small>UPDATES</small><h2>Patch notes</h2></div>
          </div>
          <PatchNotesList notes={PATCH_NOTES} />
        </section>
      </div>
      {picking && (
        <TeamPicker mode="settings" initialTeam={favoriteTeam}
          onConfirm={saveTeam} onSkip={() => saveTeam(null)} onClose={() => setPicking(false)} />
      )}
    </section>
  );
}
