import { Target } from 'lucide-react'

export default function Header({ onHome }) {
  return (
    <header className="header">
      <button className="brand" onClick={onHome} type="button">
        <span className="brand-mark"><Target size={22} /></span>
        <span>
          <strong>FOURTH DOWN</strong>
          <small>NFL MATCHUP INTELLIGENCE</small>
        </span>
      </button>
      <span className="live-pill">Vercel live</span>
    </header>
  )
}
