import React from "react";

const TEAM_LOGO_FILES = {
  ARI: "cardinals.png",
  ATL: "falcons.png",
  BAL: "ravens.png",
  BUF: "bills.png",
  CAR: "panthers.png",
  CHI: "bears.png",
  CIN: "bengals.png",
  CLE: "browns.png",
  DAL: "cowboys.png",
  DEN: "broncos.png",
  DET: "lions.png",
  GB: "packers.png",
  HOU: "texans.png",
  IND: "colts.png",
  JAX: "jaguars.png",
  KC: "chiefs.png",
  LV: "raiders.png",
  LAC: "chargers.png",
  LAR: "rams.png",
  MIA: "dolphins.png",
  MIN: "vikings.png",
  NE: "patriots.png",
  NO: "saints.png",
  NYG: "giants.png",
  NYJ: "jets.png",
  PHI: "eagles.png",
  PIT: "steelers.png",
  SF: "49ers.png",
  SEA: "seahawks.png",
  TB: "buccaneers.png",
  TEN: "titans.png",
  WSH: "commanders.png",
};

export default function TeamLogo({
  team,
  size = 70,
  className = "",
}) {
  const code = String(team || "").toUpperCase();
  const filename = TEAM_LOGO_FILES[code];

  if (!filename) {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          borderRadius: 12,
          background: "#263246",
          color: "#ffffff",
          fontWeight: 800,
        }}
      >
        {code || "NFL"}
      </div>
    );
  }

  return React.createElement("img", {
    src: `/logos/${filename}`,
    alt: `${code} team logo`,
    width: size,
    height: size,
    className,
    style: {
      width: size,
      height: size,
      display: "block",
      flexShrink: 0,
      objectFit: "contain",
      objectPosition: "center",
    },
    onError: (event) => {
      event.currentTarget.style.visibility = "hidden";
    },
  });
}