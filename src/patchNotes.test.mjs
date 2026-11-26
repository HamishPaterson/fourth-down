import test from "node:test";
import assert from "node:assert/strict";
import { LATEST_PATCH_NOTES, PATCH_NOTES, markPatchNotesSeen, readSeenPatchNotes, shouldShowPatchNotes } from "./patchNotes.js";

const memory = () => { const values = new Map(); return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) }; };
const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("the newest notes show once per device, then stay hidden until a newer release", () => {
  const storage = memory();
  assert.equal(shouldShowPatchNotes(storage), true);
  markPatchNotesSeen(LATEST_PATCH_NOTES.id, storage);
  assert.equal(readSeenPatchNotes(storage), LATEST_PATCH_NOTES.id);
  assert.equal(shouldShowPatchNotes(storage), false);
  markPatchNotesSeen("an-older-release", storage);
  assert.equal(shouldShowPatchNotes(storage), true);
});

test("blocked browser storage never breaks the app", () => {
  assert.equal(readSeenPatchNotes(blocked), null);
  assert.doesNotThrow(() => markPatchNotesSeen("x", blocked));
  assert.equal(shouldShowPatchNotes(blocked), true);
  assert.equal(shouldShowPatchNotes(undefined), true);
});

test("every release has an id, a date, a title and non-empty sections, newest first", () => {
  const ids = new Set();
  for (const note of PATCH_NOTES) {
    assert.ok(note.id && note.date && note.title);
    assert.ok(!ids.has(note.id)); ids.add(note.id);
    assert.ok(note.sections.length && note.sections.every((s) => s.heading && s.items.length));
  }
  assert.equal(LATEST_PATCH_NOTES, PATCH_NOTES[0]);
  const sorted = [...PATCH_NOTES].sort((a, b) => b.id.localeCompare(a.id));
  assert.deepEqual(sorted.map((n) => n.id), PATCH_NOTES.map((n) => n.id));
});
