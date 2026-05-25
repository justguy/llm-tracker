// test/session-hub-shell-integration.test.js — SH-2-11
//
// Static shell wiring checks for Session Hub cards. Component tests cover the
// vnode shape and runtime-message reducer; these assertions prevent the live
// app shell from drifting back to an unmounted or unstyled session surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url);

function read(rel) {
  return readFileSync(join(ROOT.pathname, rel), "utf8");
}

test("ui app shell imports and mounts SessionGroupView", () => {
  const app = read("ui/app.js");
  assert.match(app, /SessionGroupView/);
  assert.match(app, /applyRuntimeSessionsMessage/);
  assert.match(app, /<\$\{SessionGroupView\}/);
  assert.match(app, /session-group-row/);
});

test("ui runtime websocket feeds sessions from snapshots and events", () => {
  const app = read("ui/app.js");
  assert.match(app, /setRuntimeSessions\(Array\.isArray\(msg\.snapshot\?\.sessions\)/);
  assert.match(app, /msg\.type === "runtime\.event"/);
  assert.match(app, /setRuntimeSessions\(\(prev\) => applyRuntimeSessionsMessage\(prev, msg\)\)/);
});

test("ui shell loads session group stylesheet", () => {
  const html = read("ui/index.html");
  assert.match(html, /href="\/session-hub\/SessionGroup\.css"/);
});
