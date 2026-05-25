// test/attention-shell-integration.test.js — SH-4-06 / SH-4-07
//
// Static shell wiring checks for the attention strip and triage surface. The
// component-level tests cover rendering details; these assertions prevent the
// production app shell from drifting back to unreachable or unstyled modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url);

function read(rel) {
  return readFileSync(join(ROOT.pathname, rel), "utf8");
}

test("ui app shell imports and mounts AttentionStrip plus TriagePage", () => {
  const app = read("ui/app.js");
  assert.match(app, /import \{ AttentionStrip \} from "\.\/attention\/AttentionStrip\.js";/);
  assert.match(app, /import \{ TriagePage \} from "\.\/triage\/TriagePage\.js";/);
  assert.match(app, /<\$\{AttentionStrip\}/);
  assert.match(app, /<\$\{TriagePage\}/);
  assert.match(app, /\/runtime\/ws/);
});

test("ui shell loads attention and triage stylesheets", () => {
  const html = read("ui/index.html");
  assert.match(html, /href="\/attention\/AttentionStrip\.css"/);
  assert.match(html, /href="\/triage\/TriagePage\.css"/);
});
