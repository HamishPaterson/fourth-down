export const FOURTH_DOWN_LOADER_ASSETS = Object.freeze([
  "/loaders/wr_high_catch_portrait.gif",
  "/loaders/player_rushing_portrait.gif",
  "/loaders/qb_throwing_portrait.gif",
  "/loaders/lb_sack_portrait.gif",
]);

export function selectFourthDownLoaderAsset(random = Math.random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Loader asset selection requires a value from 0 to 1.");
  }
  return FOURTH_DOWN_LOADER_ASSETS[
    Math.floor(value * FOURTH_DOWN_LOADER_ASSETS.length)
  ];
}

export function createFourthDownLoaderSession(random = Math.random) {
  return Object.freeze({
    asset: selectFourthDownLoaderAsset(random),
  });
}

export function shouldShowBlockingLoader({
  loading,
  hasContent,
  error = false,
}) {
  return Boolean(loading && !hasContent && !error);
}
