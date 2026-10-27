import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("Manrope uses local variable webfonts with real weights 400 through 800", () => {
  const faces = css.match(/@font-face\s*\{[^}]+\}/g);
  assert.equal(faces.length, 2);
  for (const face of faces) {
    assert.match(face, /font-family: 'Manrope'/);
    assert.match(face, /font-weight: 400 800/);
    assert.match(face, /font-style: normal/);
    assert.match(face, /font-display: swap/);
    assert.doesNotMatch(face, /https?:|@import/);
  }
  for (const file of ["Manrope-Latin.woff2", "Manrope-LatinExt.woff2"]) {
    const bytes = readFileSync(new URL(`../public/fonts/manrope/${file}`, import.meta.url));
    assert.equal(bytes.toString("ascii", 0, 4), "wOF2");
    assert.ok(css.includes(`/fonts/manrope/${file}`));
  }
});

test("global font preserves fallback stack, numeric alignment, and native control inheritance", () => {
  assert.match(css, /:root\s*\{\s*font-family: 'Manrope', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif/);
  assert.match(css, /font-variant-numeric: lining-nums tabular-nums/);
  assert.match(css, /font-synthesis: none/);
  assert.match(css, /button, select \{ font: inherit; \}/);
});

test("redistributed Manrope fonts retain the official SIL Open Font License", () => {
  const license = readFileSync(new URL("../public/fonts/manrope/OFL.txt", import.meta.url), "utf8");
  assert.match(license, /Copyright 2018 The Manrope Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
