import { BarChart3, Home, Settings, Shield, Sparkles } from "lucide-react";

const ITEMS = [
  { id: "home", label: "Home", icon: Home },
  { id: "predictions", label: "Predictions", icon: Sparkles },
  { id: "results", label: "Results", icon: BarChart3 },
  { id: "teams", label: "Teams", icon: Shield },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function Navigation({ page, onChange }) {
  const activePage =
    page === "matchup" || page === "favorite-schedule"
      ? "predictions"
      : page === "team-detail" || page === "conference"
        ? "teams"
        : page === "data-health"
          ? "settings"
          : page;

  return (
    <nav className="nav premium-nav bottom-nav" aria-label="Primary navigation">
      {ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          type="button"
          key={id}
          className={activePage === id ? "nav-button active" : "nav-button"}
          onClick={() => onChange(id)}
          aria-current={activePage === id ? "page" : undefined}
        >
          <Icon size={21} strokeWidth={2.2} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
