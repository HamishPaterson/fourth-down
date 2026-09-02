export default function Header({ onHome }) {
  return (
    <header className="header premium-header branded-header">
      <button type="button" className="brand branded-lockup" onClick={onHome}>
        <span className="brand-icon-shell">
          <img
            src="/branding/fourth-down-icon.png"
            alt=""
            className="fourth-down-header-icon"
          />
        </span>

        <img
          src="/branding/fourth-down-wordmark.png"
          alt="Fourth Down"
          className="fourth-down-header-wordmark"
        />
      </button>

      <div className="header-status" aria-label="Data status">
        <span className="header-status-item">Live data</span>
        <span className="header-status-item header-status-secure">Vercel API</span>
      </div>
    </header>
  );
}
