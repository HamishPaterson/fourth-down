import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import TeamLogo from "./TeamLogo.jsx";
import { TEAM_NAMES } from "../data.js";
import { LEAGUE_DIVISIONS, accentFor, conferenceOf, teamNickname } from "../services/teamAccent.js";

// Full-screen team chooser. "onboarding" asks once after sign-in (Skip keeps Fourth Down
// orange); "settings" lets the user change or clear their team later. The screen previews the
// chosen team's colour as soon as a team is tapped.
export default function TeamPicker({ initialTeam = null, mode = "onboarding", onConfirm, onSkip, onClose }) {
  const [team, setTeam] = useState(initialTeam);
  const [conference, setConference] = useState(conferenceOf(initialTeam) || "AFC");
  const heading = useRef(null);
  const nickname = team ? teamNickname(team) : null;

  useEffect(() => {
    heading.current?.focus();
    if (mode !== "settings") return undefined;
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  return (
    <div className="team-picker-backdrop">
      <div className="team-picker" role="dialog" aria-modal="true" aria-labelledby="team-picker-title"
        style={{ "--accent": accentFor(team) }}>
        <div className="team-picker-top">
          <span>{mode === "settings" ? "Favourite team" : "One last thing"}</span>
          {mode === "settings"
            ? <button type="button" className="team-picker-icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button>
            : <button type="button" className="team-picker-skip" onClick={onSkip}>Skip</button>}
        </div>

        <h1 id="team-picker-title" ref={heading} tabIndex={-1}>Pick your <span>team</span></h1>
        <p className="team-picker-lead" aria-live="polite">
          {team
            ? `Painting Fourth Down in ${nickname} colours. You can change this any time in Settings.`
            : "We'll paint the app in your team's colours. You can change this any time in Settings."}
        </p>

        <div className="team-picker-conferences" role="tablist" aria-label="Conference">
          {Object.keys(LEAGUE_DIVISIONS).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={conference === name}
              className={conference === name ? "active" : ""} onClick={() => setConference(name)}>{name}</button>
          ))}
        </div>

        <div className="team-picker-divisions">
          {LEAGUE_DIVISIONS[conference].map(([division, teams]) => (
            <section key={division} className="team-picker-division">
              <h2>{conference} {division}</h2>
              <div className="team-picker-grid">
                {teams.map((code) => {
                  const selected = team === code;
                  return (
                    <button key={code} type="button" aria-pressed={selected} aria-label={TEAM_NAMES[code]}
                      className={selected ? "team-picker-team selected" : "team-picker-team"}
                      style={{ "--tile-accent": accentFor(code) }} onClick={() => setTeam(code)}>
                      <TeamLogo team={code} size={46} />
                      <span>{code}</span>
                      {selected && <span className="team-picker-check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="team-picker-actions">
          <button type="button" className="primary team-picker-confirm" disabled={!team} onClick={() => onConfirm(team)}>
            {team ? `I'm a ${nickname} fan` : "Choose a team"}
          </button>
          {mode === "settings" && initialTeam && (
            <button type="button" className="team-picker-none" onClick={onSkip}>No favourite team · use Fourth Down orange</button>
          )}
        </div>
      </div>
    </div>
  );
}
