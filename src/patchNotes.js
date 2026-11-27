// Patch notes shown to users, newest first. Add a new entry at the top for each release;
// anyone who has not seen the newest entry is shown it once when they open the app.
export const PATCH_NOTES = [
  {
    id: "2026-11-27-colours",
    date: "27 November 2026",
    title: "Colour-coded ratings",
    sections: [
      {
        heading: "Teams",
        items: [
          "Team ratings are colour coded: gold for Elite, green for Good, grey for Average, orange for Below average and red for Poor.",
        ],
      },
      {
        heading: "Picks",
        items: [
          "Open a game and tap Matchup to see the full breakdown.",
          "The Weekly Multi is simpler, with the technical selection notes removed.",
        ],
      },
    ],
  },
  {
    id: "2026-11-27-picks-tap",
    date: "27 November 2026",
    title: "Quicker picks and a back button",
    sections: [
      {
        heading: "Picks",
        items: [
          "Tap a game to see the score prediction and Best Bets right there. Tap the tab again to open the full matchup.",
          "Finished games show the winner's logo across the end of the row, with a green tick or red cross next to the final score.",
        ],
      },
      {
        heading: "Getting around",
        items: [
          "A floating back button at the top takes you back to where you were. Your phone's back gesture works too.",
          "A new football logo in the top corner.",
        ],
      },
      {
        heading: "Results",
        items: [
          "The Results page is simpler: the Brier score and bias tiles are gone.",
        ],
      },
    ],
  },
  {
    id: "2026-11-27-layouts",
    date: "27 November 2026",
    title: "Picks, matchups and standings, redesigned",
    sections: [
      {
        heading: "Picks",
        items: [
          "The app now opens on this week's picks: the game we're most confident about up top, then every game by day with our pick and win chance.",
          "Your team's game is pinned at the top. Tap it, or your team's badge in the corner, to open its page.",
        ],
      },
      {
        heading: "Matchups",
        items: [
          "Each matchup leads with both teams, our win chance, the bookies' line and a \"What's driving it\" breakdown showing how many points each factor is worth.",
          "Best Bets, odds, weather and the full model detail are all still there further down.",
        ],
      },
      {
        heading: "Standings",
        items: [
          "Standings show the leader up top, then a simple table with record, points difference, current run and playoff seeds.",
        ],
      },
    ],
  },
  {
    id: "2026-11-27",
    date: "27 November 2026",
    title: "A new look, in your team's colours",
    sections: [
      {
        heading: "Your team",
        items: [
          "Pick your favourite team and the app switches to your team's colours. Skip it to keep Fourth Down orange.",
          "Change or clear your team any time in Settings. Your choice is saved to your account, so it follows you to other devices.",
        ],
      },
      {
        heading: "Design",
        items: [
          "A cleaner dark design across every page, with bolder headings and a floating menu at the bottom of the screen.",
        ],
      },
      {
        heading: "Standings and teams",
        items: [
          "The standings pages work again, with tabs for each conference and all eight divisions.",
          "Team cards show where each team ranks in the league overall, on offence and on defence, in plain language.",
          "Team pages now show live standings (division place, playoff position, record, points, home and away) and points and yards per game, gained and allowed.",
        ],
      },
    ],
  },
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
