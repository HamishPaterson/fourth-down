import { MapPin } from 'lucide-react'
import { GAMES, TEAM_NAMES } from '../data.js'

export default function Schedule({ onOpen }) {
  return (
    <section>
      <div className="section-heading">
        <div><span className="eyebrow">2026 REGULAR SEASON</span><h1>Week 1 schedule</h1></div>
        <span className="count-pill">{GAMES.length} games</span>
      </div>
      <div className="game-grid">
        {GAMES.map((game) => (
          <button className="game-card card" key={game.id} onClick={() => onOpen(game)}>
            <div className="game-meta"><span>Week {game.week}</span><span>{game.date}</span></div>
            <div className="teams-row">
              <Team code={game.away} />
              <div className="versus"><small>{game.time}</small><strong>VS</strong></div>
              <Team code={game.home} />
            </div>
            <div className="venue"><MapPin size={15} /> {game.venue}<strong>View matchup</strong></div>
          </button>
        ))}
      </div>
    </section>
  )
}

function Team({ code }) {
  return <div className="team"><span className="team-mark">{code}</span><strong>{TEAM_NAMES[code]}</strong></div>
}
