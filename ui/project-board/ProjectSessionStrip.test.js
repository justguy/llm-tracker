import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ProjectSessionStrip,
  buildProjectRunIntent,
  formatProjectSessionActivity,
  projectLocalSessions,
} from "./ProjectSessionStrip.js";

function collectVNodeText(node) {
  if (Array.isArray(node)) return node.map(collectVNodeText).join(" ");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node.type === "function") return collectVNodeText(node.type(node.props || {}));
  return collectVNodeText(node.props?.children);
}

function flattenRenderedNodes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => flattenRenderedNodes(item, acc));
    return acc;
  }
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return acc;
  }
  if (typeof node.type === "function") return flattenRenderedNodes(node.type(node.props || {}), acc);
  acc.push(node);
  flattenRenderedNodes(node.props?.children, acc);
  return acc;
}

test("projectLocalSessions filters to the selected project and sorts latest first", () => {
  const sessions = projectLocalSessions([
    { id: "other", projectSlug: "beta", updatedAt: "2026-05-29T10:00:00.000Z" },
    { id: "old", projectSlug: "alpha", updatedAt: "2026-05-29T10:00:00.000Z" },
    { id: "new", projectSlug: "alpha", updatedAt: "2026-05-29T11:00:00.000Z" },
  ], "alpha");
  assert.deepEqual(sessions.map((session) => session.id), ["new", "old"]);
});

test("ProjectSessionStrip renders project-local sessions and run action at the end", () => {
  let runIntent = null;
  let selected = null;
  const vnode = ProjectSessionStrip({
    projectSlug: "alpha",
    sessions: [
      {
        id: "ses-alpha",
        name: "Alpha worker",
        projectSlug: "alpha",
        tier: "codex_app_server",
        status: "active",
        lastActivityAt: "2026-05-29T20:15:30.000Z",
      },
      {
        id: "ses-beta",
        name: "Beta worker",
        projectSlug: "beta",
        tier: "manual",
        status: "active",
      },
    ],
    onRun: (intent) => {
      runIntent = intent;
    },
    onSelectSession: (id, session) => {
      selected = { id, session };
    },
  });

  const text = collectVNodeText(vnode);
  assert.match(text, /Alpha worker/);
  assert.doesNotMatch(text, /Beta worker/);
  assert.match(text, /codex_app_server/);
  assert.match(text, /active/);
  assert.match(text, /2026-05-29 20:15/);
  assert.match(text, /\[\+ RUN\]\s*$/);
  const runButton = flattenRenderedNodes(vnode).find((node) => node.props?.class === "project-session-strip__run");
  assert.equal(runButton.props["data-scope"], "project-local");
  runButton.props.onClick();
  assert.deepEqual(runIntent, {
    source: "project_session_strip",
    scope: "project-local",
    projectSlug: "alpha",
  });
  const sessionCard = flattenRenderedNodes(vnode).find((node) => node.props?.class === "project-session-strip__session");
  assert.equal(sessionCard.props.role, "button");
  sessionCard.props.onClick();
  assert.equal(selected.id, "ses-alpha");
  assert.equal(selected.session.name, "Alpha worker");
});

test("ProjectSessionStrip keeps run button visible when there are no project sessions", () => {
  const vnode = ProjectSessionStrip({ projectSlug: "alpha", sessions: [] });
  const text = collectVNodeText(vnode);
  assert.match(text, /No project sessions/);
  assert.match(text, /\[\+ RUN\]/);
  assert.deepEqual(buildProjectRunIntent({ projectSlug: "alpha" }), {
    source: "project_session_strip",
    scope: "project-local",
    projectSlug: "alpha",
  });
  assert.equal(formatProjectSessionActivity("bad-date"), "bad-date");
});
