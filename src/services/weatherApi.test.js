import test from "node:test";
import assert from "node:assert/strict";
import { getStadiumWeather } from "./weatherApi.js";

const kickoff = "2026-10-18T17:00:00.000Z";

function hourlyFixture(stamp = Date.parse(kickoff) / 1000) {
  const time = [stamp, stamp + 3600, stamp + 7200, stamp + 10800, stamp + 14400];
  return {
    hourly: {
      time,
      temperature_2m: [12, 12, 11, 11, 10],
      relative_humidity_2m: [70, 70, 72, 72, 74],
      precipitation_probability: [50, 55, 60, 65, 70],
      precipitation: [0.5, 0.5, 1, 1, 1],
      rain: [0.5, 0.5, 1, 1, 1],
      showers: [0, 0, 0.2, 0.2, 0.2],
      snowfall: [0, 0, 0, 0, 0],
      weather_code: [61, 61, 61, 61, 61],
      visibility: [9000, 9000, 8500, 8500, 8000],
      wind_speed_10m: [38, 40, 42, 40, 38],
      wind_gusts_10m: [52, 55, 58, 55, 52],
    },
  };
}

async function withFetch(response, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return response;
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("weather request uses actual Wembley venue coordinates and kickoff-hour observations", async () => {
  await withFetch({
    ok: true,
    async json() { return hourlyFixture(); },
  }, async (calls) => {
    const weather = await getStadiumWeather("JAX", kickoff, undefined, "Wembley Stadium");
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("latitude"), "51.556");
    assert.equal(url.searchParams.get("longitude"), "-0.2796");
    assert.equal(weather.venue, "Wembley Stadium");
    assert.equal(weather.venueSource, "scheduled-venue");
    assert.equal(weather.kickoffObservation, kickoff);
    assert.equal(weather.windSpeed, 39.6);
    assert.equal(weather.weatherAvailable, true);
  });
});

test("Stade de France uses its outdoor coordinates for scheduled PIT at NO weather", async () => {
  await withFetch({
    ok: true,
    async json() { return hourlyFixture(); },
  }, async (calls) => {
    const weather = await getStadiumWeather("NO", kickoff, undefined, "Stade de France");
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("latitude"), "48.9244726");
    assert.equal(url.searchParams.get("longitude"), "2.3601325");
    assert.equal(weather.dome, false);
    assert.equal(weather.stadium, "Stade de France");
    assert.equal(weather.venueSource, "scheduled-venue");
    assert.equal(weather.weatherSource, "open-meteo");
    assert.equal(weather.weatherAvailable, true);
    assert.equal(calls.length, 1);
  });
});

test("Reliant Stadium uses NRG identity and dome bypass exactly like NRG Stadium", async () => {
  await withFetch({
    ok: true,
    async json() { return hourlyFixture(); },
  }, async (calls) => {
    const alias = await getStadiumWeather("HOU", kickoff, undefined, "Reliant Stadium");
    const canonical = await getStadiumWeather("HOU", kickoff, undefined, "NRG Stadium");
    assert.equal(alias.stadium, canonical.stadium);
    assert.equal(alias.venue, canonical.venue);
    assert.equal(alias.dome, canonical.dome);
    assert.equal(alias.weatherAvailable, canonical.weatherAvailable);
    assert.equal(alias.weatherSource, canonical.weatherSource);
    assert.equal(alias.weatherSource, "indoor-venue");
    assert.equal(calls.length, 0);
  });
});

test("weather request uses EverBank when scheduled and reports home-default when venue is absent", async () => {
  await withFetch({
    ok: true,
    async json() { return hourlyFixture(); },
  }, async (calls) => {
    const atJacksonville = await getStadiumWeather("HOU", kickoff, undefined, "EverBank Stadium");
    assert.equal(new URL(calls[0]).searchParams.get("latitude"), "30.3239");
    assert.equal(atJacksonville.venue, "EverBank Stadium");
    assert.equal(atJacksonville.venueSource, "scheduled-venue");
    const homeDefault = await getStadiumWeather("JAX", kickoff);
    assert.equal(new URL(calls[1]).searchParams.get("longitude"), "-81.6373");
    assert.equal(homeDefault.venueSource, "home-team-default");
  });
});

test("dome bypasses forecasts; unknown venues and distant kickoff observations use explicit fallback", async () => {
  await withFetch({
    ok: true,
    async json() { return hourlyFixture(Date.parse(kickoff) / 1000 + 8 * 3600); },
  }, async (calls) => {
    const dome = await getStadiumWeather("HOU", kickoff, undefined, "NRG Stadium");
    assert.equal(dome.dome, true);
    assert.equal(dome.weatherSource, "indoor-venue");
    assert.equal(calls.length, 0);
    const unknown = await getStadiumWeather("JAX", kickoff, undefined, "Unlisted Venue");
    assert.equal(unknown.weatherAvailable, false);
    assert.equal(unknown.venueConfidence, 0);
    assert.equal(calls.length, 0);
    const distant = await getStadiumWeather("BUF", kickoff);
    assert.equal(distant.weatherAvailable, false);
    assert.match(distant.fallbackReason, /sufficiently close to kickoff/);
    assert.equal(calls.length, 1);
  });
});
