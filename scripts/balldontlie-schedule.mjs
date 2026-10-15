import { setTimeout } from "node:timers/promises";

const PAGE_DELAY_MS = 12_500;
const MAX_RETRIES = 3;

// Keep the complete schedule in memory; retries never discard successful pages.
export async function fetchSchedule(season, {
  fetchImpl = globalThis.fetch,
  sleep = setTimeout,
  now = Date.now,
  random = Math.random,
  warn = console.warn,
} = {}) {
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key) throw new Error("BALLDONTLIE_API_KEY required for schedule provenance");
  const games = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 1; page <= 20; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const url = new URL("https://api.balldontlie.io/nfl/v1/games");
    url.searchParams.set("seasons[]", String(season));
    url.searchParams.set("per_page", "100");
    if (cursor !== null) url.searchParams.set("cursor", String(cursor));
    let response;
    for (let retry = 0; ; retry++) {
      response = await fetchImpl(url, { headers: { Authorization: key } });
      if (response.status !== 429) break;
      if (retry >= MAX_RETRIES) {
        throw new Error(`BALLDONTLIE schedule page ${page} failed (429): exhausted ${MAX_RETRIES} retries`);
      }
      const header = response.headers.get("Retry-After");
      const seconds = header?.trim() && /^\d+(?:\.\d+)?$/.test(header.trim())
        ? Number(header) : NaN;
      const date = header && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header.trim())
        ? Date.parse(header) : NaN;
      const retryAfter = Number.isFinite(seconds) ? seconds * 1000
        : Number.isFinite(date) ? Math.max(0, date - now()) : NaN;
      const wait = Number.isFinite(retryAfter) ? retryAfter
        : Math.min(8_000, 1000 * 2 ** retry + Math.floor(random() * 250));
      warn(`BALLDONTLIE schedule page ${page}: HTTP 429, retry ${retry + 1}/${MAX_RETRIES}, wait ${wait}ms`);
      await response.body?.cancel();
      await sleep(wait);
    }
    if (!response.ok) throw new Error(`BALLDONTLIE schedule page ${page} failed (${response.status})`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error("Invalid BALLDONTLIE schedule response");
    games.push(...body.data);
    cursor = body.meta?.next_cursor ?? null;
    if (cursor === null) return games;
    const token = String(cursor);
    if (cursors.has(token)) throw new Error(`BALLDONTLIE schedule repeated cursor at page ${page}`);
    cursors.add(token);
  }
  throw new Error("BALLDONTLIE schedule pagination incomplete after 20 pages");
}
