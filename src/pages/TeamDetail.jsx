export default function TeamDetail({
  team,
  onBack,
}) {
  return (
    <section>
      <button
        className="secondary"
        onClick={onBack}
      >
        ← Back to Teams
      </button>

      <h1>{team?.full_name}</h1>

      <p>{team?.abbreviation}</p>

      <p>
        {team?.conference} • {team?.division}
      </p>
    </section>
  );
}