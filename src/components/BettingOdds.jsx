import { RefreshCw } from "lucide-react";
import { TEAM_NAMES } from "../data.js";

export default function BettingOdds({
  event,
  awayCode,
  homeCode,
  status = "",
  loading = false,
  onRefresh,
}) {
  const bookmaker = selectBookmaker(event);
  const spreadMarket = getMarket(bookmaker, "spreads");
  const moneylineMarket = getMarket(bookmaker, "h2h");
  const totalsMarket = getMarket(bookmaker, "totals");

  const awayName =
    event?.away_team ||
    TEAM_NAMES[awayCode] ||
    awayCode;

  const homeName =
    event?.home_team ||
    TEAM_NAMES[homeCode] ||
    homeCode;

  const awaySpread = findOutcome(
    spreadMarket,
    awayName
  );

  const homeSpread = findOutcome(
    spreadMarket,
    homeName
  );

  const awayMoneyline = findOutcome(
    moneylineMarket,
    awayName
  );

  const homeMoneyline = findOutcome(
    moneylineMarket,
    homeName
  );

  const over = findOutcome(
    totalsMarket,
    "Over"
  );

  const under = findOutcome(
    totalsMarket,
    "Under"
  );

  const hasOdds = Boolean(
    awaySpread ||
      homeSpread ||
      awayMoneyline ||
      homeMoneyline ||
      over ||
      under
  );

  return (
    <div className="team-statistics matchup-team-statistics">
      <div className="team-statistics-heading">
        <div>
          <span className="eyebrow">
            BETTING ODDS
          </span>

          <h3>Game lines</h3>
        </div>

        {onRefresh && (
          <button
            type="button"
            className="secondary refresh-button"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw
              size={15}
              className={loading ? "spin" : ""}
            />
            Refresh odds
          </button>
        )}
      </div>

      {!hasOdds ? (
        <div className="team-statistics-empty matchup-split-panel">
          {loading
            ? "Loading betting odds..."
            : getFriendlyOddsStatus(status)}
        </div>
      ) : (
        <>
          <div className="team-statistics-table matchup-stats-table">
            <div className="team-statistics-row team-statistics-header">
              <strong>{awayCode}</strong>
              <span>Market</span>
              <strong>{homeCode}</strong>
            </div>

            <OddsRow
              label="Spread"
              away={formatSpread(awaySpread)}
              home={formatSpread(homeSpread)}
            />

            <OddsRow
              label="Moneyline"
              away={formatPrice(
                awayMoneyline?.price
              )}
              home={formatPrice(
                homeMoneyline?.price
              )}
            />

            <OddsRow
              label="Total"
              away={formatTotal(
                "Over",
                over
              )}
              home={formatTotal(
                "Under",
                under
              )}
            />
          </div>

          <div className="team-statistics-status">
            Odds may change. Verify current prices before betting.
          </div>
        </>
      )}
    </div>
  );
}

function OddsRow({
  label,
  away,
  home,
}) {
  return (
    <div className="team-statistics-row matchup-stat-row">
      <strong>{away}</strong>
      <span>{label}</span>
      <strong>{home}</strong>
    </div>
  );
}

function selectBookmaker(event) {
  if (!event?.bookmakers?.length) {
    return null;
  }

  const preferred = [
    "draftkings",
    "fanduel",
    "caesars",
    "betmgm",
  ];

  for (const key of preferred) {
    const bookmaker =
      event.bookmakers.find(
        (item) => item.key === key
      );

    if (bookmaker) {
      return bookmaker;
    }
  }

  return event.bookmakers[0];
}

function getMarket(bookmaker, key) {
  return bookmaker?.markets?.find(
    (market) => market.key === key
  );
}

function findOutcome(market, name) {
  return market?.outcomes?.find(
    (outcome) =>
      normalizeName(outcome.name) ===
      normalizeName(name)
  );
}

function formatSpread(outcome) {
  if (!outcome) {
    return "-";
  }

  return `${formatPoint(
    outcome.point
  )} ${formatPrice(
    outcome.price
  )}`;
}

function formatTotal(label, outcome) {
  if (!outcome) {
    return "-";
  }

  return `${label} ${
    outcome.point ?? "-"
  } ${formatPrice(
    outcome.price
  )}`;
}

function formatPoint(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "-";
  }

  return value > 0
    ? `+${value}`
    : `${value}`;
}

function formatPrice(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "-";
  }

  return americanToDecimal(value);
}

function americanToDecimal(price) {
  if (price > 0) {
    return (
      price / 100 +
      1
    ).toFixed(2);
  }

  return (
    100 / Math.abs(price) +
    1
  ).toFixed(2);
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}
function getFriendlyOddsStatus(status) {
  const text = String(status || "").trim();
  const lower = text.toLowerCase();

  if (
    !text ||
    lower.includes("server") ||
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("sharpapi")
  ) {
    return "Betting odds are temporarily unavailable. The matchup and Fourth Down prediction are still available.";
  }

  return text;
}
