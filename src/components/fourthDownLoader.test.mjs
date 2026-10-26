import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  FOURTH_DOWN_LOADER_ASSETS,
  createFourthDownLoaderSession,
  selectFourthDownLoaderAsset,
  shouldShowBlockingLoader,
} from "./fourthDownLoader.js";

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

test("all four approved loader GIFs are present as GIF assets", () => {
  assert.equal(FOURTH_DOWN_LOADER_ASSETS.length, 4);

  for (const asset of FOURTH_DOWN_LOADER_ASSETS) {
    const content = readFileSync(resolve("public", asset.slice(1)));
    assert.equal(content.toString("ascii", 0, 3), "GIF");
  }
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

test("Results with already-available results remains visible instead of loading", async () => {
  const { default: Results } = await vite.ssrLoadModule(
    "/src/pages/Results.jsx"
  );
  const markup = renderToStaticMarkup(createElement(Results));

  assert.match(markup, /<h1>Results<\/h1>/);
  assert.doesNotMatch(markup, /class="fourth-down-loader"/);
});

test("the selector can select each approved asset with equal probability buckets", () => {
  const selected = [0, 0.25, 0.5, 0.75].map((value) =>
    selectFourthDownLoaderAsset(() => value)
  );

  assert.deepEqual(selected, FOURTH_DOWN_LOADER_ASSETS);
  assert.equal(new Set(selected).size, 4);
});

test("the selector never returns an unapproved asset", () => {
  for (const value of [0, 0.1, 0.25, 0.49, 0.5, 0.74, 0.75, 0.999]) {
    assert.ok(FOURTH_DOWN_LOADER_ASSETS.includes(
      selectFourthDownLoaderAsset(() => value)
    ));
  }
});

test("a loading session retains its selection across rerenders", () => {
  let randomCalls = 0;
  const random = () => {
    randomCalls += 1;
    return 0.5;
  };

  const session = createFourthDownLoaderSession(random);
  const rerenderedAsset = session.asset;

  assert.equal(rerenderedAsset, FOURTH_DOWN_LOADER_ASSETS[2]);
  assert.equal(randomCalls, 1);
  assert.ok(Object.isFrozen(session));
});

test("a new independent loading session can select a different asset", () => {
  const firstSession = createFourthDownLoaderSession(() => 0);
  const nextSession = createFourthDownLoaderSession(() => 0.75);

  assert.notEqual(firstSession.asset, nextSession.asset);
});

test("blocking loader visibility ends on failure and preserves usable content", () => {
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

test("loader layout is viewport-fixed, constrained, responsive, and reduced-motion safe", () => {
  const css = readFileSync(resolve("src", "index.css"), "utf8");

  assert.match(css, /\.fourth-down-loader\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.fourth-down-loader\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /width:\s*min\(100%,\s*430px\)/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]*?max-height:\s*min\(64svh,\s*540px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});
