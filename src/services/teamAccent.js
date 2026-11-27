// The app's accent colour. Everyone starts on Fourth Down orange; picking a favourite team
// switches the accent to that team's colour. Each team has one hand-picked accent from its own
// palette that reads at 4.5:1 or better on the dark background (navy and other dark primaries
// are swapped for the team's brighter colour or a lifted shade), with dark text on top of it.

export const BASE_ACCENT = "#FF6B1A";
export const ACCENT_INK = "#14100C";

// code: [nickname, accent]
export const TEAM_ACCENTS = {
  BUF: ["Bills", "#4D8DFF"], MIA: ["Dolphins", "#1BB5BE"], NE: ["Patriots", "#E8435A"], NYJ: ["Jets", "#34B37A"],
  BAL: ["Ravens", "#9F8BFF"], CIN: ["Bengals", "#FB4F14"], CLE: ["Browns", "#FF3C00"], PIT: ["Steelers", "#FFB612"],
  HOU: ["Texans", "#EB4A5F"], IND: ["Colts", "#4C8EE0"], JAX: ["Jaguars", "#1AA3B8"], TEN: ["Titans", "#4B92DB"],
  DEN: ["Broncos", "#FB4F14"], KC: ["Chiefs", "#F23A55"], LV: ["Raiders", "#A5ACAF"], LAC: ["Chargers", "#4FB3FF"],
  DAL: ["Cowboys", "#5B8DEF"], NYG: ["Giants", "#3F7EF0"], PHI: ["Eagles", "#2BA3A0"], WSH: ["Commanders", "#FFB612"],
  CHI: ["Bears", "#E8582A"], DET: ["Lions", "#2E96E0"], GB: ["Packers", "#FFB612"], MIN: ["Vikings", "#A27BE8"],
  ATL: ["Falcons", "#EA4458"], CAR: ["Panthers", "#1C9BE0"], NO: ["Saints", "#D3BC8D"], TB: ["Buccaneers", "#F2453A"],
  ARI: ["Cardinals", "#E8455F"], LAR: ["Rams", "#5C8BFF"], SF: ["49ers", "#EF4136"], SEA: ["Seahawks", "#69BE28"],
};

export const LEAGUE_DIVISIONS = {
  AFC: [["East", ["BUF", "MIA", "NE", "NYJ"]], ["North", ["BAL", "CIN", "CLE", "PIT"]], ["South", ["HOU", "IND", "JAX", "TEN"]], ["West", ["DEN", "KC", "LV", "LAC"]]],
  NFC: [["East", ["DAL", "NYG", "PHI", "WSH"]], ["North", ["CHI", "DET", "GB", "MIN"]], ["South", ["ATL", "CAR", "NO", "TB"]], ["West", ["ARI", "LAR", "SF", "SEA"]]],
};

export function teamNickname(code) {
  return TEAM_ACCENTS[code]?.[0] || code;
}

export function accentFor(code) {
  return TEAM_ACCENTS[code]?.[1] || BASE_ACCENT;
}

// CSS custom properties for the app shell.
export function getAccentTheme(code) {
  return { "--accent": accentFor(code), "--accent-ink": ACCENT_INK };
}

export function conferenceOf(code) {
  return Object.keys(LEAGUE_DIVISIONS).find((conference) =>
    LEAGUE_DIVISIONS[conference].some(([, teams]) => teams.includes(code))) || null;
}

// WCAG contrast ratio between two #RRGGBB colours.
export function contrastRatio(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
