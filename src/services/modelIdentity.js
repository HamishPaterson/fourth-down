export const CURRENT_MODEL_VERSION = 12;
export const CURRENT_MODEL_KEY = "full-v12-special-teams-kicker-model";

export function isCurrentModelIdentity(version, key) {
  return (typeof version === "number" || typeof version === "string") &&
    Number(version) === CURRENT_MODEL_VERSION && key === CURRENT_MODEL_KEY;
}
