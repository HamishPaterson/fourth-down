import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { shouldShowBlockingLoader } from "./fourthDownLoader.js";

let vite;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
});

test.after(async () => {
  await vite?.close();
});

test("FourthDownLoader always renders the spinning football asset", async () => {
  const { default: FourthDownLoader } = await vite.ssrLoadModule(
    "/src/components/FourthDownLoader.jsx"
  );
  const markup = renderToStaticMarkup(createElement(FourthDownLoader));

  assert.match(markup, /src="\/loaders\/football_spinning\.webp"/);
  assert.doesNotMatch(markup, /portrait\.gif|Math\.random|random/i);
});

test("old portrait loader assets are not referenced in application source", () => {
  const source = [
    readFileSync(resolve("src", "components", "FourthDownLoader.jsx"), "utf8"),
    readFileSync(resolve("src", "index.css"), "utf8"),
  ].join("\n");

  assert.doesNotMatch(source, /portrait\.gif/i);
  assert.deepEqual(
    readdirSync(resolve("public", "loaders")).filter((name) => name.endsWith("_portrait.gif")),
    []
  );
  assert.equal(existsSync(resolve("public", "loaders", "football_spinning.webp")), true);
});

test("Predictions and Matchup render the loader during their initial blocking load", async () => {
  const { default: Predictions } = await vite.ssrLoadModule(
    "/src/pages/Predictions.jsx"
  );
  const { default: Matchup } = await vite.ssrLoadModule(
    "/src/pages/Matchup.jsx"
  );
  const predictions = renderToStaticMarkup(
    createElement(Predictions, { onOpen() {} })
  );
  const matchup = renderToStaticMarkup(
    createElement(Matchup, {
      game: {
        id: "test-game",
        away: "KC",
        home: "BUF",
        week: 1,
        date: "Sunday, September 13, 2026",
        time: "1:00 PM",
        status: "Scheduled",
      },
      onBack() {},
    })
  );

  assert.match(predictions, /class="fourth-down-loader"/);
  assert.match(matchup, /class="fourth-down-loader"/);
});

test("Conference and Divisions use the loader while initial teams are unavailable", async () => {
  const { default: Conference } = await vite.ssrLoadModule(
    "/src/pages/Conference.jsx"
  );
  const { default: Divisions } = await vite.ssrLoadModule(
    "/src/pages/Divisions.jsx"
  );

  assert.match(renderToStaticMarkup(createElement(Conference, {
    onSelectTeam() {},
  })), /class="fourth-down-loader"/);
  assert.match(renderToStaticMarkup(createElement(Divisions)), /class="fourth-down-loader"/);
});

test("Schedule and Teams use the loader when no initial data exists", async () => {
  const { default: Schedule } = await vite.ssrLoadModule(
    "/src/pages/Schedule.jsx"
  );
  const { default: Teams } = await vite.ssrLoadModule(
    "/src/pages/Teams.jsx"
  );

  assert.match(renderToStaticMarkup(createElement(Schedule, {
    onOpen() {},
    favoriteTeam: "KC",
  })), /class="fourth-down-loader"/);
  assert.match(renderToStaticMarkup(createElement(Teams, {
    onOpenTeam() {},
    onOpenConference() {},
  })), /class="fourth-down-loader"/);
});

test("Results remains visible rather than blocking when ledger results are available", async () => {
  const { default: Results } = await vite.ssrLoadModule(
    "/src/pages/Results.jsx"
  );
  const storageRow = {
    id: "2026-W2-KC-BUF",
    season: 2026,
    week: 2,
    kickoff: "2026-09-20T17:00:00.000Z",
    awayCode: "KC",
    homeCode: "BUF",
    actualAwayScore: 20,
    actualHomeScore: 17,
    actualWinner: "KC",
    fourthDownPick: "KC",
    fourthDownCorrect: true,
    savedBeforeKickoff: true,
  };
  const originalWindow = globalThis.window;
  const values = new Map([
    ["fourth-down:prediction-ledger:v1", JSON.stringify([storageRow])],
    ["fourth-down:shared-ledger-migrated:v1", "done"],
  ]);
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };

  try {
    const markup = renderToStaticMarkup(createElement(Results));
    assert.match(markup, /<h1>Results<\/h1>/);
    assert.doesNotMatch(markup, /class="fourth-down-loader"/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("blocking loader lifecycle preserves failure handling and background content", async () => {
  assert.equal(shouldShowBlockingLoader({
    loading: true,
    hasContent: false,
  }), true);
  assert.equal(shouldShowBlockingLoader({
    loading: false,
    hasContent: false,
  }), false);
  assert.equal(shouldShowBlockingLoader({
    loading: true,
    hasContent: false,
    error: true,
  }), false);
  assert.equal(shouldShowBlockingLoader({
    loading: true,
    hasContent: true,
  }), false);
});

test("loader layout is centered, constrained, responsive, and reduced-motion safe", () => {
  const css = readFileSync(resolve("src", "index.css"), "utf8");

  assert.match(css, /\.fourth-down-loader\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.fourth-down-loader-animation\s*\{[^}]*width:\s*clamp\(160px,\s*20vw,\s*250px\)/s);
  assert.match(css, /\.fourth-down-loader-animation\s*\{[^}]*max-height:\s*min\(38svh,\s*300px\)/s);
  assert.match(css, /object-fit:\s*contain/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.fourth-down-loader-reduced\s*\{[^}]*grid-row:\s*2/s);
});
