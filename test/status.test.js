import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjects, renderDashboard, renderProject, renderJson } from "../hub/status.js";
import { validProject } from "./fixtures.js";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "llm-tracker-status-"));
  mkdirSync(join(ws, "trackers"), { recursive: true });
  return ws;
}

test("loadProjects returns empty list when no trackers", () => {
  const ws = setupWorkspace();
  try {
    const projects = loadProjects(ws);
    assert.deepEqual(projects, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadProjects parses valid tracker + flags invalid", () => {
  const ws = setupWorkspace();
  try {
    writeFileSync(join(ws, "trackers", "good.json"), JSON.stringify(validProject({ meta: { ...validProject().meta, slug: "good" } })));
    writeFileSync(join(ws, "trackers", "bad.json"), "{ not json");
    const projects = loadProjects(ws);
    assert.equal(projects.length, 2);
    const bad = projects.find((p) => p.slug === "bad");
    assert.equal(bad.ok, false);
    assert.ok(bad.error.includes("parse"));
    const good = projects.find((p) => p.slug === "good");
    assert.equal(good.ok, true);
    assert.equal(good.derived.total, 3);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("renderDashboard produces text including workspace + counts", () => {
  const ws = setupWorkspace();
  try {
    const p = validProject();
    p.meta.slug = "good";
    writeFileSync(join(ws, "trackers", "good.json"), JSON.stringify(p));
    const out = renderDashboard(loadProjects(ws), ws, { useColor: false });
    assert.ok(out.includes(ws));
    assert.ok(out.includes("good"));
    assert.ok(out.includes("Test Project"));
    assert.ok(out.includes("TOTAL"));
    assert.ok(out.includes("1 projects"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("renderProject shows swimlanes + blocked tasks", () => {
  const ws = setupWorkspace();
  try {
    const p = validProject();
    p.meta.slug = "good";
    p.meta.scratchpad = "current pin: t1";
    writeFileSync(join(ws, "trackers", "good.json"), JSON.stringify(p));
    const projects = loadProjects(ws);
    const out = renderProject(projects[0], { useColor: false });
    assert.ok(out.includes("Test Project"));
    assert.ok(out.includes("[SCRATCHPAD]"));
    assert.ok(out.includes("current pin: t1"));
    assert.ok(out.includes("SWIMLANES"));
    assert.ok(out.includes("Actionability"));
    assert.ok(out.includes("executable"));
    assert.ok(out.includes("Execution"));
    assert.ok(out.includes("BLOCKED TASKS"));
    assert.ok(out.includes("t2"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("renderJson emits parseable JSON with slug, pct, counts, blocked", () => {
  const ws = setupWorkspace();
  try {
    const p = validProject();
    p.meta.slug = "good";
    writeFileSync(join(ws, "trackers", "good.json"), JSON.stringify(p));
    const out = renderJson(loadProjects(ws), ws);
    const data = JSON.parse(out);
    assert.equal(data.workspace, ws);
    assert.equal(data.projects.length, 1);
    const proj = data.projects[0];
    assert.equal(proj.slug, "good");
    assert.equal(proj.workspace, ws);
    assert.equal(proj.port, null);
    assert.equal(proj.file, realpathSync(join(ws, "trackers", "good.json")));
    assert.equal(proj.registrationFile, join(ws, "trackers", "good.json"));
    assert.equal(proj.topology, "shared-workspace");
    assert.equal(proj.total, 3);
    assert.ok(typeof proj.pct === "number");
    assert.ok(proj.counts);
    assert.ok(proj.actionability.counts);
    assert.equal(proj.actionability.counts.executable, 1);
    assert.ok(proj.blocked.t2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
