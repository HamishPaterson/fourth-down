export const TEAM_THEMES = {
  ARI: ["#97233F", "#FFB612", "cardinals.png"],
  ATL: ["#A71930", "#A5ACAF", "falcons.png"],
  BAL: ["#241773", "#9E7C0C", "ravens.png"],
  BUF: ["#00338D", "#C60C30", "bills.png"],
  CAR: ["#0085CA", "#BFC0BF", "panthers.png"],
  CHI: ["#0B162A", "#C83803", "bears.png"],
  CIN: ["#FB4F14", "#FFFFFF", "bengals.png"],
  CLE: ["#311D00", "#FF3C00", "browns.png"],
  DAL: ["#003594", "#869397", "cowboys.png"],
  DEN: ["#FB4F14", "#002244", "broncos.png"],
  DET: ["#0076B6", "#B0B7BC", "lions.png"],
  GB: ["#203731", "#FFB612", "packers.png"],
  HOU: ["#03202F", "#A71930", "texans.png"],
  IND: ["#002C5F", "#A2AAAD", "colts.png"],
  JAX: ["#006778", "#D7A22A", "jaguars.png"],
  KC: ["#E31837", "#FFB81C", "chiefs.png"],
  LV: ["#000000", "#A5ACAF", "raiders.png"],
  LAC: ["#0080C6", "#FFC20E", "chargers.png"],
  LAR: ["#003594", "#FFA300", "rams.png"],
  MIA: ["#008E97", "#FC4C02", "dolphins.png"],
  MIN: ["#4F2683", "#FFC62F", "vikings.png"],
  NE: ["#002244", "#C60C30", "patriots.png"],
  NO: ["#D3BC8D", "#FFFFFF", "saints.png"],
  NYG: ["#0B2265", "#A71930", "giants.png"],
  NYJ: ["#125740", "#FFFFFF", "jets.png"],
  PHI: ["#004C54", "#A5ACAF", "eagles.png"],
  PIT: ["#101820", "#FFB612", "steelers.png"],
  SF: ["#AA0000", "#B3995D", "49ers.png"],
  SEA: ["#002244", "#69BE28", "seahawks.png"],
  TB: ["#D50A0A", "#FF7900", "buccaneers.png"],
  TEN: ["#0C2340", "#4B92DB", "titans.png"],
  WSH: ["#5A1414", "#FFB612", "commanders.png"],
};

export function normalizeTeamCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}

export function getTeamTheme(code) {
  const normalized = normalizeTeamCode(code);
  const [primary, secondary, logo] = TEAM_THEMES[normalized] || [
    "#FFFFFF",
    "#A3A3A3",
    "",
  ];

  return {
    "--team-primary": primary,
    "--team-secondary": secondary,
    "--team-watermark": logo ? `url("/logos/${logo}")` : "none",
  };
}
