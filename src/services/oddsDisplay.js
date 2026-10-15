export function usableDecimalOdds(decimalOdds, americanPrice) {
  if (decimalOdds !== null && decimalOdds !== undefined && decimalOdds !== "") {
    const decimal = Number(decimalOdds);
    return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
  }
  if (americanPrice === null || americanPrice === undefined || americanPrice === "") return null;
  const price = Number(americanPrice);
  if (!Number.isFinite(price) || price === 0) return null;
  const decimal = price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price);
  return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
}

export function formatAustralianOdds(decimalOdds, americanPrice) {
  const decimal = usableDecimalOdds(decimalOdds, americanPrice);
  return decimal === null ? "Odds unavailable" : `$${decimal.toFixed(2)}`;
}

export function combinedDecimalOdds(legs) {
  if (!legs?.length) return null;
  let combined = 1;
  for (const leg of legs) {
    const decimal = usableDecimalOdds(leg.decimalOdds, leg.price);
    if (decimal === null) return null;
    combined *= decimal;
    if (!Number.isFinite(combined)) return null;
  }
  return combined;
}
