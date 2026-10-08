// services/stadiums.js
// Stadium coordinates + roof type for weather lookups.
//
// dome: true  -> indoor / fixed or usually-closed retractable roof.
//               Weather has no meaningful effect, so we skip the API call.
// dome: false -> open-air venue subject to wind, rain, snow, cold.
//
// SoFi (LAR/LAC) has a fixed translucent canopy over the field with open
// sides; it's treated as indoor for scoring purposes. Retractable-roof
// venues that are typically closed in bad weather are also flagged dome.

const STADIUMS = {
  ARI: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, dome: true },   // retractable
  ATL: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.4008, dome: true }, // retractable
  BAL: { name: "M&T Bank Stadium", lat: 39.2780, lon: -76.6227, dome: false },
  BUF: { name: "Highmark Stadium", lat: 42.7738, lon: -78.7870, dome: false },
  CAR: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, dome: false },
  CHI: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, dome: false },
  CIN: { name: "Paycor Stadium", lat: 39.0954, lon: -84.5160, dome: false },
  CLE: { name: "Huntington Bank Field", lat: 41.5061, lon: -81.6995, dome: false },
  DAL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, dome: true },          // retractable
  DEN: { name: "Empower Field at Mile High", lat: 39.7439, lon: -105.0201, dome: false },
  DET: { name: "Ford Field", lat: 42.3400, lon: -83.0456, dome: true },
  GB: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, dome: false },
  HOU: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, dome: true },           // retractable
  IND: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, dome: true },     // retractable
  JAX: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, dome: false },
  KC: { name: "GEHA Field at Arrowhead Stadium", lat: 39.0489, lon: -94.4839, dome: false },
  LV: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1830, dome: true },
  LAC: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, dome: true },         // fixed canopy
  LAR: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, dome: true },         // fixed canopy
  MIA: { name: "Hard Rock Stadium", lat: 25.9580, lon: -80.2389, dome: false },    // canopy, open field
  MIN: { name: "U.S. Bank Stadium", lat: 44.9736, lon: -93.2575, dome: true },
  NE: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, dome: false },
  NO: { name: "Caesars Superdome", lat: 29.9511, lon: -90.0812, dome: true },
  NYG: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, dome: false },
  NYJ: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, dome: false },
  PHI: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, dome: false },
  PIT: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, dome: false },
  SF: { name: "Levi's Stadium", lat: 37.4033, lon: -121.9694, dome: false },
  SEA: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, dome: false },
  TB: { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, dome: false },
  TEN: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, dome: false },
  WSH: { name: "Northwest Stadium", lat: 38.9076, lon: -76.8645, dome: false },
};

export function getStadium(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return STADIUMS[aliases[normalized] || normalized] || null;
}

export default STADIUMS;
