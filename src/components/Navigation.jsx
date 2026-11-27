import { BarChart3, CheckCircle2, Home, Settings, Shield } from "lucide-react";

// Floating bottom menu: icons only, with the current page growing into a labelled pill.
const ITEMS = [
  { id: "predictions", label: "Picks", icon: Home },
  { id: "results", label: "Results", icon: CheckCircle2 },
  { id: "conference", label: "Standings", icon: BarChart3 },
  { id: "teams", label: "Teams", icon: Shield },
  { id: "settings", label: "Settings", icon: Settings },
];

function activeNavigationItem(page) {
  if (page === "home" || page === "matchup" || page === "favorite-schedule" || page === "schedule") return "predictions";
  if (page === "team-detail") return "teams";
  if (page === "divisions") return "conference";
  if (page === "data-health") return "settings";
  return page;
}

export default function Navigation({ page, onChange }) {
  const activePage = activeNavigationItem(page);

  return (
    <nav className="nav premium-nav bottom-nav" aria-label="Primary navigation">
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const active = activePage === id;
        return (
          <button
            type="button"
            key={id}
            className={active ? "nav-button active" : "nav-button"}
            onClick={() => onChange(id)}
            aria-current={active ? "page" : undefined}
            aria-label={label}
          >
            <Icon size={21} strokeWidth={2.2} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
