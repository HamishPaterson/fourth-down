import { useState } from "react";

export default function App() {
  const [page, setPage] = useState("home");

  const buttonStyle = {
    padding: "10px 16px",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#07101f",
        color: "white",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <header
        style={{
          padding: "20px",
          borderBottom: "1px solid #1e2d47",
        }}
      >
        <h1>🏈 Fourth Down</h1>

        <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
          <button style={buttonStyle} onClick={() => setPage("home")}>
            Home
          </button>

          <button style={buttonStyle} onClick={() => setPage("schedule")}>
            Schedule
          </button>

          <button style={buttonStyle} onClick={() => setPage("roster")}>
            Roster
          </button>

          <button style={buttonStyle} onClick={() => setPage("stats")}>
            Stats
          </button>

          <button style={buttonStyle} onClick={() => setPage("settings")}>
            Settings
          </button>
        </div>
      </header>

      <main style={{ padding: "30px" }}>
        {page === "home" && (
          <>
            <h2>Home</h2>
            <p>Welcome to Fourth Down.</p>
            <p>✅ Vercel Connected</p>
            <p>✅ GitHub Connected</p>
            <p>✅ BALLDONTLIE Connected</p>
          </>
        )}

        {page === "schedule" && (
          <>
            <h2>Schedule</h2>
            <p>Schedule screen coming next.</p>
          </>
        )}

        {page === "roster" && (
          <>
            <h2>Roster</h2>
            <p>Roster screen coming next.</p>
          </>
        )}

        {page === "stats" && (
          <>
            <h2>Stats</h2>
            <p>Stats screen coming next.</p>
