import test from "node:test";
import assert from "node:assert/strict";
import { resolveStadium } from "./stadiums.js";
import { getStadium } from "./stadiums.js";

test("Arrowhead scheduled names reuse the validated Kansas City stadium record", () => {
  const canonical = getStadium("KC");
  for (const venue of ["Arrowhead Stadium", "GEHA Field at Arrowhead Stadium", canonical.name]) {
    const result = resolveStadium("KC", venue);
    assert.equal(result.stadium, canonical);
    assert.equal(result.source, "scheduled-venue");
    assert.equal(result.confidence, 1);
  }
  assert.equal(resolveStadium("KC", "Unlisted Arrowhead Annex").stadium, null);
  assert.equal(resolveStadium("KC", "Unlisted Arrowhead Annex").source, "scheduled-venue-unresolved");
});

test("scheduled venue resolves Wembley instead of the home team's stadium", () => {
  const result = resolveStadium("JAX", "Wembley Stadium");
  assert.equal(result.stadium.name, "Wembley Stadium");
  assert.equal(result.stadium.lat, 51.556);
  assert.equal(result.stadium.dome, false);
  assert.equal(result.source, "scheduled-venue");
  assert.equal(result.confidence, 1);
});

test("Week 7 scheduled venues resolve without substituting team home stadiums", () => {
  const weekSeven = [
    ["NE", "CHI", "Soldier Field", "Soldier Field"],
    ["PIT", "NO", "Stade de France", "Stade de France"],
    ["SF", "ATL", "Mercedes-Benz Stadium", "Mercedes-Benz Stadium"],
    ["CLE", "TEN", "Nissan Stadium", "Nissan Stadium"],
    ["IND", "MIN", "U.S. Bank Stadium", "U.S. Bank Stadium"],
    ["MIA", "NYJ", "MetLife Stadium", "MetLife Stadium"],
    ["TB", "CAR", "Bank of America Stadium", "Bank of America Stadium"],
    ["CIN", "BAL", "M&T Bank Stadium", "M&T Bank Stadium"],
    ["NYG", "HOU", "Reliant Stadium", "NRG Stadium"],
    ["DEN", "ARI", "State Farm Stadium", "State Farm Stadium"],
    ["GB", "DET", "Ford Field", "Ford Field"],
    ["LAR", "LV", "Allegiant Stadium", "Allegiant Stadium"],
    ["KC", "SEA", "Lumen Field", "Lumen Field"],
    ["DAL", "PHI", "Lincoln Financial Field", "Lincoln Financial Field"],
  ];

  for (const [away, home, scheduledVenue, canonicalName] of weekSeven) {
    const resolution = resolveStadium(home, scheduledVenue);
    assert.equal(resolution.source, "scheduled-venue", `${away} at ${home}`);
    assert.equal(resolution.stadium?.name, canonicalName, `${away} at ${home}`);
    assert.ok(Number.isFinite(resolution.stadium?.lat), `${away} at ${home} latitude`);
    assert.ok(Number.isFinite(resolution.stadium?.lon), `${away} at ${home} longitude`);
  }
});

test("Week 7 scheduled venues take precedence over both teams' home stadiums", () => {
  const parisGame = resolveStadium("NO", "Stade de France");
  assert.equal(parisGame.stadium.name, "Stade de France");
  assert.notEqual(parisGame.stadium, getStadium("NO"));
  assert.notEqual(parisGame.stadium.name, getStadium("NO").name);

  const houstonGame = resolveStadium("HOU", "Reliant Stadium");
  const canonicalNrg = resolveStadium("HOU", "NRG Stadium");
  assert.equal(houstonGame.stadium, canonicalNrg.stadium);
  assert.equal(houstonGame.stadium.name, "NRG Stadium");
});

test("EverBank aliases, home defaults, neutral venues and dome/outdoor venues resolve explicitly", () => {
  assert.equal(resolveStadium("HOU", "EverBank Field").stadium.name, "EverBank Stadium");
  assert.equal(resolveStadium("JAX", null).stadium.name, "EverBank Stadium");
  assert.equal(resolveStadium("JAX", null).source, "home-team-default");
  assert.equal(resolveStadium("JAX", "Tottenham Hotspur Stadium").stadium.dome, false);
  assert.equal(resolveStadium("HOU", "NRG Stadium").stadium.dome, true);
  assert.equal(resolveStadium("HOU", "Reliant Stadium").stadium.dome, true);
  assert.equal(resolveStadium("BUF", "Highmark Stadium").stadium.dome, false);
});

test("unknown scheduled venue is unresolved rather than silently replaced by the home stadium", () => {
  const result = resolveStadium("JAX", "Unlisted Neutral Field");
  assert.equal(result.stadium, null);
  assert.equal(result.source, "scheduled-venue-unresolved");
  assert.equal(result.confidence, 0);
});
