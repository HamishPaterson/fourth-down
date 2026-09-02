import { CalendarDays, Home, Settings, Shield } from "lucide-react";

const ITEMS = [
  { id: "home", label: "Home", icon: Home },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "teams", label: "Teams", icon: Shield },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function Navigation({ page, onChange }) {
  const activePage = page === "matchup" ? "schedule" : page === "team-detail" ? "teams" : page;

  return (
    <nav className="nav premium-nav" aria-label="Primary navigation">
      {ITEMS.map(({ id, label, icon: Icon }) => (
        <button
          type="button"
          key={id}
          className={activePage === id ? "nav-button active" : "nav-button"}
          onClick={() => onChange(id)}
        >
          <Icon size={16} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
