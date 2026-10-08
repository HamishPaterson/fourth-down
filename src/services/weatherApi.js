// services/weatherApi.js
// Fetches outdoor conditions across the full game window from Open-Meteo.
import { getStadium } from "./stadiums.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GAME_HOURS = 5; // kickoff hour through kickoff + 4 hours

export async function getStadiumWeather(homeCode, kickoff, signal) {
  const stadium = getStadium(homeCode);
  if (!stadium) return null;

  if (stadium.dome) {
    return { dome: true, stadium: stadium.name, gameHours: 0 };
  }

  const date = kickoff instanceof Date ? kickoff : new Date(kickoff);
  if (Number.isNaN(date.getTime())) return null;

  const params = new URLSearchParams({
    latitude: String(stadium.lat),
    longitude: String(stadium.lon),
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
      "snowfall",
      "weather_code",
      "visibility",
      "wind_speed_10m",
      "wind_gusts_10m",
    ].join(","),
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timeformat: "unixtime",
    forecast_days: "16",
    timezone: "GMT",
  });

  try {
    const response = await fetch(`${FORECAST_URL}?${params.toString()}`, { signal });
    if (!response.ok) return null;

    const data = await response.json();
    const hourly = data?.hourly;
    const times = hourly?.time || [];
    if (!times.length) return null;

    const kickoffSeconds = Math.floor(date.getTime() / 1000);
    const startIndex = nearestIndex(times, kickoffSeconds);
    const indexes = Array.from({ length: GAME_HOURS }, (_, offset) => startIndex + offset)
      .filter((index) => index < times.length);
    if (!indexes.length) return null;

    const values = (key) => indexes
      .map((index) => numeric(hourly?.[key]?.[index]))
      .filter((value) => value != null);

    return {
      dome: false,
      stadium: stadium.name,
      gameHours: indexes.length,
      temperature: average(values("temperature_2m")),
      humidity: average(values("relative_humidity_2m")),
      precipitationProbability: average(values("precipitation_probability")),
      precipitation: sum(values("precipitation")),
      rain: sum(values("rain")),
      showers: sum(values("showers")),
      snowfall: sum(values("snowfall")),
      maxHourlyRain: maximum(values("rain")),
      maxHourlyPrecipitation: maximum(values("precipitation")),
      windSpeed: average(values("wind_speed_10m")),
      windGust: maximum(values("wind_gusts_10m")),
      visibility: minimum(values("visibility")),
      weatherCode: maximum(values("weather_code")),
    };
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("Weather lookup failed:", error?.message || error);
    }
    return null;
  }
}

export function describeWeather(weather) {
  if (!weather) return "";
  if (weather.dome) return "Indoor venue - no weather impact";

  const parts = [];
  if (weather.temperature != null) parts.push(`${Math.round(weather.temperature)}°C`);
  if (weather.windSpeed != null) parts.push(`wind ${Math.round(weather.windSpeed)} km/h`);
  if (weather.windGust != null && weather.windGust >= 30) {
    parts.push(`gusts ${Math.round(weather.windGust)} km/h`);
  }
  if (weather.rain > 0.05) parts.push(`${weather.rain.toFixed(1)} mm rain`);
  if (weather.snowfall > 0.05) parts.push(`${weather.snowfall.toFixed(1)} cm snow`);
  if (weather.visibility != null && weather.visibility < 10000) {
    parts.push(`visibility ${(weather.visibility / 1000).toFixed(1)} km`);
  }
  return parts.join(" · ");
}

function nearestIndex(times, targetSeconds) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const diff = Math.abs(Number(times[i]) - targetSeconds);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function sum(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) : 0;
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
}

function minimum(values) {
  return values.length ? Math.min(...values) : null;
}
