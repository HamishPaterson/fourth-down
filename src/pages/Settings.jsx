import { useState } from 'react'
import { TEAM_NAMES } from '../data.js'

export default function Settings({ favoriteTeam, onSave }) {
  const [draft, setDraft] = useState(favoriteTeam)
  const [saved, setSaved] = useState(false)
  return (
    <section className="card settings-card">
      <span className="eyebrow">PREFERENCES</span>
      <h1>Settings</h1>
      <label>Favourite team<select value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false) }}>{Object.entries(TEAM_NAMES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <button className="primary" onClick={() => { onSave(draft); setSaved(true) }}>Save settings</button>
      {saved && <p className="success">Settings saved</p>}
      <p className="note">The BALLDONTLIE API key remains in Vercel Environment Variables and is not exposed here.</p>
    </section>
  )
}
