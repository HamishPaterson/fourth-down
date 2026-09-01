const items = [
  ['home', 'Home'],
  ['schedule', 'Schedule'],
  ['matchup', 'Matchup'],
  ['teams', 'Teams'],
  ['settings', 'Settings'],
]

export default function Navigation({ page, onChange }) {
  return (
    <nav className="nav" aria-label="Primary navigation">
      {items.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={page === id ? 'nav-button active' : 'nav-button'}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
