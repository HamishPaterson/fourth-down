import { CalendarDays, Database, Server } from 'lucide-react'
import { TEAM_NAMES } from '../data.js'

export default function Home({ favoriteTeam, onNavigate }) {
  return (
    <section>
      <div className="hero card">
        <span className="eyebrow">MY TEAM</span>
        <h1>{TEAM_NAMES[favoriteTeam]}</h1>
        <p>Fourth Down is now running as a Vite app on Vercel.</p>
        <div className="actions">
          <button className="primary" onClick={() => onNavigate('schedule')}>View schedule</button>
          <button className="secondary" onClick={() => onNavigate('teams')}>Load NFL teams</button>
        </div>
      </div>
      <div className="status-grid">
        <Status icon={<Server />} title="Vercel" text="Deployment connected" />
        <Status icon={<Database />} title="BALLDONTLIE" text="Server API connected" />
        <Status icon={<CalendarDays />} title="Schedule" text="Week 1 scaffold ready" />
      </div>
    </section>
  )
}

function Status({ icon, title, text }) {
  return <div className="card status-card"><span>{icon}</span><div><strong>{title}</strong><small>{text}</small></div></div>
}
