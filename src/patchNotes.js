// Patch notes shown to users, newest first. Add a new entry at the top for each release;
// anyone who has not seen the newest entry is shown it once when they open the app.
export const PATCH_NOTES = [
  {
    id: "2026-11-26",
    date: "26 November 2026",
    title: "Predictions built from real data",
    sections: [
      {
        heading: "Predictions",
        items: [
          "Each team's starting score now comes from its real points scored and allowed this season. The bookmaker's line is only a small part of the starting point.",
          "Player ratings are rebuilt every week from this season's play-by-play and snap counts, replacing last season's game ratings.",
          "Missing starters are priced from ten seasons of games, by position and by how well the player was playing. An elite quarterback out is worth about 9 points.",
          "A change of starting quarterback is priced from how good the backup is.",
          "Kickers are judged on their own records.",
          "Games without a posted spread use the bookmaker's moneyline instead.",
        ],
      },
      {
        heading: "Rosters",
        items: [
          "Rosters are checked against the official NFL weekly rosters, so retired, released, cut and traded players no longer appear.",
          "Roster moves can be recorded before the official feeds catch up, starting with Aaron Rodgers' release by Pittsburgh.",
        ],
      },
      {
        heading: "Weekly Multi",
        items: [
          "Each market's weight is updated every week from graded results.",
          "Legs are ranked on value backed by results, and each Multi is approved leg by leg before it locks.",
          "Player props are paused until they show an edge.",
        ],
      },
      {
        heading: "Reliability",
        items: [
          "Data, odds and predictions update automatically every Tuesday evening (Brisbane time).",
          "Predictions refresh faster and fail less often.",
          "A new week can no longer run on out-of-date data.",
        ],
      },
    ],
  },
];

export const LATEST_PATCH_NOTES = PATCH_NOTES[0];

const SEEN_KEY = "fourthDown.patchNotesSeen";

// Browser storage can be missing or blocked (private windows, previews); the app then simply
// shows the notes again next time.
export function readSeenPatchNotes(storage = globalThis.localStorage) {
  try { return storage?.getItem(SEEN_KEY) || null; } catch { return null; }
}

export function markPatchNotesSeen(id = LATEST_PATCH_NOTES?.id, storage = globalThis.localStorage) {
  try { storage?.setItem(SEEN_KEY, id); } catch { /* not remembered on this device */ }
}

export function shouldShowPatchNotes(storage = globalThis.localStorage) {
  return Boolean(LATEST_PATCH_NOTES) && readSeenPatchNotes(storage) !== LATEST_PATCH_NOTES.id;
}
