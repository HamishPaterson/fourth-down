import { Radio, ShieldCheck } from "lucide-react";

export default function Header({ onHome }) {
  return (
    <header className="header premium-header">
      <button type="button" className="brand" onClick={onHome}>
        <span className="brand-mark">4D</span>
        <span>
          <strong>Fourth Down</strong>
          <small>NFL INTELLIGENCE</small>
        </span>
      </button>

      <div className="header-status">
        <span className="header-status-item">
          <Radio size={14} /> Live data
        </span>
        <span className="header-status-item header-status-secure">
          <ShieldCheck size={14} /> Vercel API
        </span>
      </div>
    </header>
  );
}
