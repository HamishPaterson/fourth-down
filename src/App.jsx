import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import Header from "./components/Header.jsx";
import Navigation from "./components/Navigation.jsx";
import Matchup from "./pages/Matchup.jsx";
import Teams from "./pages/Teams.jsx";
import TeamDetail from "./pages/TeamDetail.jsx";
import Conference from "./pages/Conference.jsx";
import Settings from "./pages/Settings.jsx";
import Predictions from "./pages/Predictions.jsx";
import Results from "./pages/Results.jsx";
import DataHealth from "./pages/DataHealth.jsx";
import { getTeamTheme } from "./services/teamThemes.js";
import { getTeams } from "./services/nflApi.js";
import { TEAM_NAMES } from "./data.js";
import {
  accountFavoriteTeam,
  readFavoriteTeamChoice,
  saveFavoriteTeamPreference,
  saveFavoriteTeamToAccount,
} from "./services/favoriteTeamPreference.js";
import { getAccentTheme } from "./services/teamAccent.js";
import { getAuthClient } from "./services/supabaseAuth.js";
import TeamPicker from "./components/TeamPicker.jsx";
import { WhatsNewDialog } from "./components/PatchNotes.jsx";
import { LATEST_PATCH_NOTES, markPatchNotesSeen, shouldShowPatchNotes } from "./patchNotes.js";

export default function App() {
  const [page, setPage] = useState("predictions");
  const [selectedGame, setSelectedGame] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [teamChoice, setTeamChoice] = useState(readFavoriteTeamChoice);
  const favoriteTeam = teamChoice.team;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(() => shouldShowPatchNotes());

  function closeWhatsNew() {
    markPatchNotesSeen(LATEST_PATCH_NOTES.id);
    setShowWhatsNew(false);
  }

  function openAllPatchNotes() {
    closeWhatsNew();
    navigateTo("settings");
    window.requestAnimationFrame(() => document.getElementById("patch-notes")?.scrollIntoView({ block: "start" }));
  }

  // The account's saved team wins over this browser's; a browser answer the account lacks is uploaded.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const auth = getAuthClient();
        const { data } = await auth.auth.getSession();
        if (!active || !data?.session?.user) return;
        const saved = accountFavoriteTeam(data.session.user);
        const local = readFavoriteTeamChoice();
        if (saved !== undefined) {
          if (!local.decided || saved !== local.team) {
            saveFavoriteTeamPreference(saved);
            setTeamChoice({ team: saved, decided: true });
          }
        } else if (local.decided) {
          await saveFavoriteTeamToAccount(auth, local.team);
        }
      } catch (error) {
        console.warn("Favourite team could not be synced with your account", error);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const currentSignature = getAppAssetSignature(document);

    async function checkForAppUpdate() {
      if (!active || updateAvailable || !currentSignature) return;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("__fourth_down_update_check", String(Date.now()));
        const response = await fetch(url.toString(), {
          cache: "no-store",
          headers: { Accept: "text/html" },
        });
        if (!response.ok) return;
        const html = await response.text();
        const nextDocument = new DOMParser().parseFromString(html, "text/html");
        const nextSignature = getAppAssetSignature(nextDocument);
        if (nextSignature && nextSignature !== currentSignature) {
          setUpdateAvailable(true);
        }
      } catch (error) {
        console.warn("Fourth Down update check failed", error);
      }
    }

    function checkWhenVisible() {
      if (document.visibilityState === "visible") void checkForAppUpdate();
    }

    const intervalId = window.setInterval(checkForAppUpdate, 60 * 1000);
    window.addEventListener("focus", checkForAppUpdate);
    document.addEventListener("visibilitychange", checkWhenVisible);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", checkForAppUpdate);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [updateAvailable]);

  // Pages the back button returns to. The bottom menu and the brand start a fresh trail;
  // opening a matchup, team or other detail page adds the current page to it.
  const backTrail = useRef([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const pageState = useRef({ page, selectedGame, selectedTeam });
  useEffect(() => { pageState.current = { page, selectedGame, selectedTeam }; }, [page, selectedGame, selectedTeam]);

  function navigateTo(destination, options = {}) {
    const resolvedDestination =
      destination === "schedule" || destination === "favorite-schedule" || destination === "home"
        ? "predictions"
        : destination;

    if (options.topLevel) {
      backTrail.current = [];
    } else if (resolvedDestination !== pageState.current.page || options.forcePush) {
      backTrail.current.push({ ...pageState.current, scrollY: window.scrollY });
      // A browser history entry lets the phone back gesture and Android back button work too.
      try { window.history.pushState({ fourthDownBack: backTrail.current.length }, ""); } catch { /* back button still works */ }
    }
    setCanGoBack(backTrail.current.length > 0);
    setPage(resolvedDestination);
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function restorePrevious() {
    const previous = backTrail.current.pop();
    setCanGoBack(backTrail.current.length > 0);
    if (!previous) return;
    setSelectedGame(previous.selectedGame);
    setSelectedTeam(previous.selectedTeam);
    setPage(previous.page);
    // The page may still be loading, so keep trying for a moment until it is tall enough.
    const target = previous.scrollY || 0;
    let attempts = 0;
    const restore = () => {
      window.scrollTo({ top: target, left: 0, behavior: "auto" });
      if (Math.abs(window.scrollY - target) > 2 && attempts++ < 30) window.setTimeout(restore, 100);
    };
    window.requestAnimationFrame(restore);
  }

  useEffect(() => {
    window.addEventListener("popstate", restorePrevious);
    return () => window.removeEventListener("popstate", restorePrevious);
  }, []);

  function goBack() {
    if (window.history.state?.fourthDownBack) window.history.back();
    else restorePrevious();
  }

  function openMatchup(game) {
    setSelectedGame(game);
    navigateTo("matchup", { forcePush: true });
  }

  function openTeam(team) {
    setSelectedTeam(team);
    navigateTo("team-detail", { forcePush: true });
  }

  // Opens a team page from just its code (the header's favourite team, the Picks page strip).
  async function openTeamByCode(code) {
    const fallback = { abbreviation: code, full_name: TEAM_NAMES[code] || code };
    try {
      const teams = await getTeams();
      openTeam(teams.find((team) => normalizeTeamCode(team.abbreviation) === normalizeTeamCode(code)) || fallback);
    } catch {
      openTeam(fallback);
    }
  }

  // team: a team code, or null for no favourite team (Fourth Down orange).
  function saveFavoriteTeam(team) {
    saveFavoriteTeamPreference(team);
    setTeamChoice({ team, decided: true });
    try {
      saveFavoriteTeamToAccount(getAuthClient(), team)
        .catch((error) => console.warn("Favourite team could not be saved to your account", error));
    } catch (error) {
      console.warn("Favourite team could not be saved to your account", error);
    }
  }

  function answerTeamPicker(team) {
    try {
      saveFavoriteTeam(team);
    } catch (error) {
      console.warn("Favourite team preference could not be saved", error);
      setTeamChoice({ team, decided: true });
    }
  }

  return (
    <div className="app-shell" style={{ ...getTeamTheme(favoriteTeam), ...getAccentTheme(favoriteTeam) }}>
      {updateAvailable && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            left: "50%",
            bottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
            zIndex: 10000,
            width: "min(520px, calc(100vw - 28px))",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            padding: "13px 14px",
            border: "1px solid var(--accent)",
            borderRadius: "20px",
            background: "#1C1E25",
            boxShadow: "0 16px 42px rgba(0, 0, 0, 0.48)",
            color: "#ffffff",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <strong style={{ display: "block" }}>Fourth Down has been updated</strong>
            <span style={{ display: "block", marginTop: "2px", fontSize: "12px", opacity: 0.76 }}>
              Refresh now to load the latest version.
            </span>
          </div>
          <button
            type="button"
            onClick={reloadLatestAppVersion}
            style={{
              flex: "0 0 auto",
              border: 0,
              borderRadius: "999px",
              padding: "10px 16px",
              background: "var(--accent)",
              color: "var(--accent-ink)",
              fontWeight: 900,
              cursor: "pointer",
            }}
          >
            Refresh now
          </button>
        </div>
      )}
      {!teamChoice.decided && (
        <TeamPicker onConfirm={answerTeamPicker} onSkip={() => answerTeamPicker(null)} />
      )}
      {teamChoice.decided && showWhatsNew && <WhatsNewDialog note={LATEST_PATCH_NOTES} onClose={closeWhatsNew} onOpenAll={openAllPatchNotes} />}
      <Header onHome={() => navigateTo("predictions", { topLevel: true })} favoriteTeam={favoriteTeam}
        onOpenFavorite={() => openTeamByCode(favoriteTeam)} canGoBack={canGoBack} />
      {canGoBack && (
        <button type="button" className="floating-back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
      )}
      <Navigation page={page} onChange={(destination) => navigateTo(destination, { topLevel: true })} />
      <main className="content">

        {page === "matchup" && <Matchup game={selectedGame} onBack={goBack} />}
        {page === "teams" && <Teams onOpenTeam={openTeam} onOpenConference={() => navigateTo("conference")} />}
        {page === "team-detail" && <TeamDetail team={selectedTeam} onBack={goBack} />}
        {page === "conference" && <Conference onSelectTeam={openTeam} />}
        {page === "predictions" && <Predictions onOpen={openMatchup} favoriteTeam={favoriteTeam} onOpenTeam={openTeamByCode} />}
        {page === "results" && <Results />}
        {page === "data-health" && <DataHealth />}
        {page === "settings" && <Settings favoriteTeam={favoriteTeam} onSave={saveFavoriteTeam} onNavigate={navigateTo} />}
      </main>
    </div>
  );
}

function getAppAssetSignature(sourceDocument) {
  if (!sourceDocument) return "";
  const assets = [
    ...Array.from(sourceDocument.querySelectorAll('script[type="module"][src]')).map(
      (node) => node.getAttribute("src")
    ),
    ...Array.from(sourceDocument.querySelectorAll('link[rel="stylesheet"][href]')).map(
      (node) => node.getAttribute("href")
    ),
  ]
    .filter(Boolean)
    .sort();
  return assets.join("|");
}

function reloadLatestAppVersion() {
  const url = new URL(window.location.href);
  url.searchParams.delete("__fourth_down_update_check");
  url.searchParams.set("__fourth_down_refresh", String(Date.now()));
  window.location.replace(url.toString());
}

function normalizeTeamCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return ({ WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" })[code] || code;
}
