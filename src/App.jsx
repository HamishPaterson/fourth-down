export default function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#07101f",
        color: "white",
        padding: "30px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <h1>Fourth Down</h1>

      <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
        <button>Home</button>
        <button>Schedule</button>
        <button>Matchups</button>
        <button>Roster</button>
        <button>Stats</button>
        <button>Settings</button>
      </div>

      <div
        style={{
          marginTop: "30px",
          padding: "20px",
          border: "1px solid #333",
          borderRadius: "8px",
        }}
      >
        <h2>Home</h2>

        <p>Welcome to Fourth Down.</p>

        <p>
          Backend connection confirmed ✅
        </p>

        <p>
          BALLDONTLIE integration ready ✅
        </p>
      </div>
    </div>
  );
}