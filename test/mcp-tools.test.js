import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools } from "../bin/mcp-tools.js";
import { workspaceRuntimePayload } from "../bin/mcp-context-data.js";
import { getPrompt } from "../bin/mcp-prompts.js";
import { readResource } from "../bin/mcp-resources.js";
import { validProject } from "./fixtures.js";

function setupWorkspace(prefix = "llm-tracker-mcp-tools-") {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(workspace, sub), { recursive: true });
  }
  writeFileSync(join(workspace, "README.md"), "# MCP tool test workspace\n");
  writeFileSync(
    join(workspace, "trackers", "test-project.json"),
    JSON.stringify(validProject(), null, 2)
  );
  return workspace;
}

test("tracker_patch is exposed across MCP tools, runtime metadata, and prompts", () => {
  const workspace = setupWorkspace();
  try {
    const tools = createTools(workspace);
    assert.ok(tools.has("tracker_patch"));

    const runtime = workspaceRuntimePayload(workspace);
    assert.ok(runtime.daemonRule.writeTools.includes("tracker_patch"));

    const startHere = getPrompt(workspace, "tracker_start_here");
    assert.match(startHere.messages[0].content.text, /tracker_patch/);
    assert.match(startHere.messages[0].content.text, /swimlaneOps/);

    const patchWrite = getPrompt(workspace, "tracker_patch_write", { slug: "test-project" });
    assert.match(patchWrite.messages[0].content.text, /tracker_patch/);
    assert.match(patchWrite.messages[0].content.text, /taskOps/);
    assert.match(patchWrite.messages[0].content.text, /expectedRev/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP read tools include effective target metadata", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-target-read-");
  try {
    const tools = createTools(workspace);
    const result = await tools.get("tracker_next").handler({ slug: "test-project", limit: 1 });

    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.workspace, workspace);
    assert.equal(payload.port, null);
    assert.equal(payload.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(payload.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(payload.topology, "shared-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_history includes effective target metadata", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-target-history-");
  try {
    const tools = createTools(workspace);
    const result = await tools.get("tracker_history").handler({ slug: "test-project", limit: 5 });

    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.workspace, workspace);
    assert.equal(payload.port, null);
    assert.equal(payload.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(payload.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(payload.topology, "shared-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP project resources include effective target metadata", () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-target-resource-");
  try {
    const resources = readResource(workspace, "tracker://projects");
    const payload = JSON.parse(resources.contents[0].text);
    const project = payload.projects.find((item) => item.slug === "test-project");

    assert.equal(project.workspace, workspace);
    assert.equal(project.port, null);
    assert.equal(project.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(project.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(project.topology, "shared-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_patch validates required MCP arguments before attempting hub I/O", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-validate-");
  try {
    const tool = createTools(workspace).get("tracker_patch");

    const missingSlug = await tool.handler({ patch: { meta: { scratchpad: "hi" } } });
    assert.equal(missingSlug.isError, true);
    assert.match(missingSlug.content[0].text, /requires a project slug/i);

    const missingPatch = await tool.handler({ slug: "test-project" });
    assert.equal(missingPatch.isError, true);
    assert.match(missingPatch.content[0].text, /requires a JSON object patch/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_patch direct mode returns structured expectedRev conflicts", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-expected-rev-");
  try {
    const tool = createTools(workspace).get("tracker_patch");

    const result = await tool.handler({
      slug: "test-project",
      mode: "direct",
      patch: {
        expectedRev: 0,
        tasks: { t1: { status: "complete" } }
      }
    });

    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 409);
    assert.equal(payload.type, "conflict");
    assert.equal(payload.expectedRev, 0);
    assert.equal(payload.currentRev, 1);
    assert.equal(payload.file, realpathSync(join(workspace, "trackers", "test-project.json")));
    assert.equal(payload.registrationFile, join(workspace, "trackers", "test-project.json"));
    assert.equal(payload.topology, "shared-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tracker_patch direct mode returns structural repair payloads", async () => {
  const workspace = setupWorkspace("llm-tracker-mcp-tools-structural-repair-");
  try {
    const tool = createTools(workspace).get("tracker_patch");

    const result = await tool.handler({
      slug: "test-project",
      mode: "direct",
      patch: {
        swimlaneOps: [{ op: "remove", id: "ops" }]
      }
    });

    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 400);
    assert.equal(payload.type, "schema");
    assert.equal(payload.repair.moveTasksTo, "exec");
    assert.deepEqual(payload.repair.affectedTaskIds, ["t3"]);
    assert.deepEqual(payload.repair.swimlaneOps, [
      { op: "remove", id: "ops", reassignTo: "exec" }
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
