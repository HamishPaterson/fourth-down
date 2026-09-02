import { useState } from "react";
import Header from "./components/Header.jsx";
import Navigation from "./components/Navigation.jsx";
import Home from "./pages/Home.jsx";
import Schedule from "./pages/Schedule.jsx";
import Matchup from "./pages/Matchup.jsx";
import Teams from "./pages/Teams.jsx";
import TeamDetail from "./pages/TeamDetail.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  const [page, setPage] = useState("home");
  const [selectedGame, setSelectedGame] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);

  const [favoriteTeam, setFavoriteTeam] = useState(
    () => localStorage.getItem("favoriteTeam") || "SF"
  );

  function openMatchup(game) {
    setSelectedGame(game);
    setPage("matchup");
  }

  function openTeam(team) {
    setSelectedTeam(team);
    setPage("team-detail");
  }

  function saveFavoriteTeam(team) {
    setFavoriteTeam(team);
    localStorage.setItem("favoriteTeam", team);
  }

  return (
    <div className="app-shell">
      <Header onHome={() => setPage("home")} />

      <Navigation
        page={page}
        onChange={setPage}
      />

      <main className="content">
        {page === "home" && (
          <Home
            favoriteTeam={favoriteTeam}
            onNavigate={setPage}
          />
        )}

        {page === "schedule" && (
          <Schedule onOpen={openMatchup} />
        )}

        {page === "matchup" && (
          <Matchup
            game={selectedGame}
            onBack={() => setPage("schedule")}
          />
        )}

        {page === "teams" && (
          <Teams onOpenTeam={openTeam} />
        )}

        {page === "team-detail" && (
          <TeamDetail
            team={selectedTeam}
            onBack={() => setPage("teams")}
          />
        )}

        {page === "settings" && (
          <Settings
            favoriteTeam={favoriteTeam}
            onSave={saveFavoriteTeam}
          />
        )}
      </main>
    </div>
  );
}