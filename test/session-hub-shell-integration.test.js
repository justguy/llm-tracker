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

function assertAllMatch(source, patterns) {
  for (const pattern of patterns) assert.match(source, pattern);
}

test("ui app shell imports and mounts SessionGroupView", () => {
  const app = read("ui/app.js");
  assert.match(app, /SessionGroupView/);
  assert.match(app, /AttachDialog/);
  assert.match(app, /applyRuntimeSessionsMessage/);
  assert.match(app, /<\$\{SessionGroupView\}/);
  assert.match(app, /<\$\{AttachDialog\}/);
  assert.match(app, /taskId=\$\{taskDrawer\?\.slug === activeSlug \? taskDrawer\.taskId/);
  assert.match(app, /session-hub-operator-shell/);
});

test("ui app shell mounts the full Session Hub operator workspace", () => {
  const app = read("ui/app.js");
  assertAllMatch(app, [
    /HubTopBar/,
    /SessionDetailDockView/,
    /ToolShelf/,
    /selectedSessionId/,
    /setSelectedSessionId/,
    /session=\$\{selectedSession\}/,
    /onSelectSession=/,
    /session-hub-operator-shell/,
    /session-hub-workspace/,
    /session-hub-workspace__main/,
    /session-hub-workspace__tools/,
    /<\$\{SessionDetailDockView\}/,
    /<\$\{ToolShelf\}/,
  ]);
});

test("ui app shell routes ToolShelf actions through the selected detail workspace", () => {
  const app = read("ui/app.js");
  assertAllMatch(app, [
    /const onSessionHubToolAction = \(\{ groupId, actionId, task, session, job, repo \}\) => \{/,
    /groupId === "task"/,
    /groupId === "session"/,
    /groupId === "job"/,
    /groupId === "repo"/,
    /groupId === "review"/,
    /actionId === "chat"\) setSelectedSessionTab\("chat"\)/,
    /actionId === "stdio"\) setSelectedSessionTab\("stdio"\)/,
    /actionId === "diff"/,
    /actionId === "skills"\) setSelectedSessionTab\("skills"\)/,
    /actionId === "context"/,
    /onCompleteJob\(\{ jobId: runtimeJobId\(job\) \}\)/,
    /onSpawnReviewer\(\{ jobId: runtimeJobId\(job\), session \}\)/,
  ]);
  const shelf = read("ui/session-hub/ToolShelf.js");
  assertAllMatch(shelf, [
    /"session:rollover"/,
    /"job:verify"/,
    /"job:blocked"/,
    /"repo:status"/,
    /"repo:files"/,
    /"repo:conflicts"/,
    /not wired in live UI/,
  ]);
});

test("ui app shell wires board run-session controls into Session Hub state", () => {
  const app = read("ui/app.js");
  const pane = read("ui/project-pane.js");
  const card = read("ui/task-card.js");
  assertAllMatch(app, [
    /const onBoardRunSession = \(slug, task, action = \{\}\) => \{/,
    /setDropRunSession\(\{\s*source: "task_card"/,
    /onOpenSelectedSession\(sessionId, slug\)/,
    /onRunSession=\$\{onBoardRunSession\}/,
    /onRunProjectSession=\$\{onProjectSessionRun\}/,
    /onSelectSession=\$\{\(sessionId\) => onOpenSelectedSession\(sessionId, s\)\}/,
  ]);
  assertAllMatch(pane, [
    /ProjectSessionStrip/,
    /onRunSession=\$\{\(task, action\) => onRunSession && onRunSession\(slug, task, action\)\}/,
  ]);
  assertAllMatch(card, [
    /runSessionAction\.kind === "active_session" \? "OPEN SESSION" : "\+ RUN SESSION"/,
    /sessionId: firstString\(runtimeSession\.id, runtimeSession\.sessionId\)/,
  ]);
});

test("global Session Hub launcher preserves picker intent and auto-selects launched session", () => {
  const app = read("ui/app.js");
  assertAllMatch(app, [
    /source=\$\{dropRunSession\.source \|\| "hub_run"\}/,
    /mode=\$\{dropRunSession\.mode \|\| \(dropRunSession\.taskId \? "task_backed" : "untasked"\)\}/,
    /taskLocked=\$\{dropRunSession\.taskLocked === true\}/,
    /const launchedSessionId = nonEmptyString\(result\?\.sessionId\)/,
    /setSelectedSessionId\(launchedSessionId\)/,
    /setSelectedSessionTab\("chat"\)/,
    /No session running/,
    /empty_state_pick_task/,
    /empty_state_untasked/,
  ]);
});

test("session chat has a real message send path", () => {
  const app = read("ui/app.js");
  const composer = read("ui/session-hub/ChatComposer.js");
  const sessionsApi = read("hub/api/sessions.js");
  assertAllMatch(app, [
    /messageCapability/,
    /preferredSessionForWorkspace/,
    /list\.find\(sessionCanReceiveOperatorMessage\)/,
    /setSelectedSessionId\(runtimeSessionId\(preferredSessionForWorkspace\(visibleRuntimeSessions\)\) \|\| null\)/,
    /onSend=\$\{\(result\) => \{/,
    /sessionChatErrors/,
    /chatError=\$\{sessionChatErrors\[runtimeSessionId\(selectedSession\)\] \|\| ""\}/,
    /result\?\.disabledReason \|\| result\?\.body\?\.error\?\.message \|\| "message send failed"/,
    /type: "session\.output"/,
    /kind: "message"/,
  ]);
  assertAllMatch(composer, [
    /postSessionMessage/,
    /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/message/,
    /chat-composer__send/,
    /chat-composer__status/,
    /disabled=\$\{!message\.enabled\}/,
    />\s*SEND\s*</,
  ]);
  assertAllMatch(sessionsApi, [
    /POST  \/api\/sessions\/:sessionId\/message/,
    /app\.post\("\/api\/sessions\/:sessionId\/message"/,
    /dispatchSessionMessage/,
    /createSessionOperatorMessageEvent/,
  ]);
});

test("session detail dock uses real core panels without placeholder tabs", () => {
  const dock = read("ui/session-hub/SessionDetailDock.js");
  assertAllMatch(dock, [
    /ChatComposer/,
    /DiffPanel/,
    /SessionContextTab/,
    /SessionSkillsTab/,
    /selectedTab === "chat"/,
    /selectedTab === "diff"/,
    /selectedTab === "context"/,
    /selectedTab === "skills"/,
    /selectedTab === "events"/,
  ]);
  assert.doesNotMatch(dock, /PlaceholderPanel/);
  assert.doesNotMatch(dock, /session-detail-dock__placeholder/);
});

test("ui shell loads all required Session Hub workspace styles", () => {
  const html = read("ui/index.html");
  assertAllMatch(html, [
    /href="\/session-hub\/SessionGroup\.css"/,
    /href="\/session-hub\/SessionDetailDock\.css"/,
    /href="\/session-hub\/ToolShelf\.css"/,
    /href="\/session-hub\/HubTopBar\.css"/,
    /href="\/session-hub\/ChatComposer\.css"/,
    /href="\/session-hub\/DiffPanel\.css"/,
    /href="\/session-hub\/SessionContextTab\.css"/,
    /href="\/session-hub\/SessionSkillsTab\.css"/,
    /href="\/project-board\/ProjectSessionStrip\.css"/,
    /href="\/project-board\/TaskSessionBadge\.css"/,
  ]);
  const dockCss = read("ui/session-hub/SessionDetailDock.css");
  assertAllMatch(dockCss, [
    /@import "\.\/StdioPanel\.css";/,
    /@import "\.\/TimelinePanel\.css";/,
  ]);
});

test("browser acceptance keeps desktop and narrow Session Hub layout in scope", () => {
  const app = read("ui/app.js");
  assert.match(app, /data-browser-acceptance="desktop-operator-workspace narrow-operator-workspace"/);
});

test("Tracker and Session Hub are mutually exclusive top-level modes", () => {
  const app = read("ui/app.js");
  const css = read("ui/session-hub/SessionGroup.css");
  const styles = read("ui/styles.css");
  assertAllMatch(app, [
    /workspaceMode/,
    /setWorkspaceMode\("tracker"\)/,
    /setWorkspaceMode\("sessionHub"\)/,
    /workspaceMode === "sessionHub"\s*\?\s*sessionGroupEl/,
    /workspaceMode === "sessionHub"[\s\S]*:\s*html`[\s\S]*<\$\{HeroStrip\}/,
    /class="workspace-mode-tabs"/,
  ]);
  assertAllMatch(css, [
    /\.session-hub-operator-shell \{/,
    /flex: 1 1 auto;/,
    /overflow-y: auto;/,
    /\.session-hub-workspace__main \{\s*display: block;\s*min-height: auto;/,
  ]);
  assertAllMatch(styles, [
    /\.workspace-mode-tabs \{/,
    /\.workspace-mode-tab--active \{/,
    /@media \(max-width: 640px\) \{\s*\.connection-pip,\s*\.app-shell\.drawer-pinned \.connection-pip \{\s*display: none;/,
  ]);
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
  assert.match(html, /href="\/session-hub\/AttachDialog\.css"/);
});
