export default function Header({ onHome }) {
  return (
    <header className="header premium-header">
      <button type="button" className="brand fd-brand" onClick={onHome}>
        <img src="/branding/fourth-down-logo-dark.png" alt="Fourth Down" className="fd-header-logo" />
      </button>
      <div className="header-status" aria-label="Data status">
        <span className="header-status-item">Live data</span>
        <span className="header-status-item">Vercel API</span>
      </div>
    </header>
  );
}
