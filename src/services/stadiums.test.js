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

test("EverBank aliases, home defaults, neutral venues and dome/outdoor venues resolve explicitly", () => {
  assert.equal(resolveStadium("HOU", "EverBank Field").stadium.name, "EverBank Stadium");
  assert.equal(resolveStadium("JAX", null).stadium.name, "EverBank Stadium");
  assert.equal(resolveStadium("JAX", null).source, "home-team-default");
  assert.equal(resolveStadium("JAX", "Tottenham Hotspur Stadium").stadium.dome, false);
  assert.equal(resolveStadium("HOU", "NRG Stadium").stadium.dome, true);
  assert.equal(resolveStadium("BUF", "Highmark Stadium").stadium.dome, false);
});

test("unknown scheduled venue is unresolved rather than silently replaced by the home stadium", () => {
  const result = resolveStadium("JAX", "Unlisted Neutral Field");
  assert.equal(result.stadium, null);
  assert.equal(result.source, "scheduled-venue-unresolved");
  assert.equal(result.confidence, 0);
});
