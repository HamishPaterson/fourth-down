export default function Header({ onHome }) {
  return (
    <header className="header premium-header corrected-brand-header">
      <button type="button" className="brand" onClick={onHome}>
        <span className="corrected-brand-icon-shell">
          <img
            src="/branding/fourth-down-header-icon.png"
            alt=""
            className="corrected-brand-icon"
          />
        </span>

        <span className="corrected-brand-copy">
          <strong>Fourth Down</strong>
          <small>ANALYZE. INSIGHT. WIN.</small>
        </span>
      </button>

      <div className="header-status" aria-label="Data status">
        <span className="header-status-item">Live data</span>
        <span className="header-status-item header-status-secure">Vercel API</span>
      </div>
    </header>
  );
}
