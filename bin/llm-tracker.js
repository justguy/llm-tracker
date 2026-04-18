#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { startHub } from "../hub/server.js";
import { loadProjects, renderDashboard, renderProject, renderJson } from "../hub/status.js";

function loadWorkspaceSettings(workspace) {
  const file = join(workspace, "settings.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function validPort(n) {
  const p = parseInt(n, 10);
  return !isNaN(p) && p >= 1 && p <= 65535 ? p : null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");

const DEFAULT_WORKSPACE = join(homedir(), ".llm-tracker");
const DEFAULT_PORT = 4400;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args.flags[k] = v === undefined ? argv[++i] ?? true : v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveWorkspace(flag) {
  const fromFlag = flag || process.env.LLM_TRACKER_HOME;
  return resolve(fromFlag || DEFAULT_WORKSPACE);
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (existsSync(dstPath)) continue;
      copyFileSync(srcPath, dstPath);
    }
  }
}

function cmdInit(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const template = join(PKG_ROOT, "workspace-template");

  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    console.log(`Workspace already exists at ${workspace}`);
  } else {
    copyTree(template, workspace);
    for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
      mkdirSync(join(workspace, sub), { recursive: true });
    }
    console.log(`Initialized workspace at ${workspace}`);
  }

  const readmePath = join(workspace, "README.md");
  console.log("");
  console.log("─────────────────────────────────────────────────────────");
  console.log(" Paste this into your LLM to register a project:");
  console.log("─────────────────────────────────────────────────────────");
  console.log("");
  console.log(`  Read ${readmePath} and register this project as <slug>.`);
  console.log("");
  console.log(`  WORKSPACE IS AT: ${workspace}`);
  console.log(`  Every path must begin with that absolute path.`);
  console.log(`  Do NOT create a new .llm-tracker/ anywhere else.`);
  console.log(`  Do NOT write README.md, templates/, or settings.json — they already exist.`);
  console.log("");
  console.log(`  Register: write ${join(workspace, "trackers", "<slug>.json")}`);
  console.log(`  Update:   drop patches in ${join(workspace, "patches", "<slug>.<ts>.json")}`);
  console.log(`            or POST http://localhost:<port>/api/projects/<slug>/patch`);
  console.log("");
  console.log("─────────────────────────────────────────────────────────");
  console.log(" Start the hub:   npx llm-tracker");
  console.log(" UI help modal has one-click copy-paste prompts for both modes.");
  console.log("─────────────────────────────────────────────────────────");
}

async function httpRequest(workspace, method, path, body) {
  const settings = loadWorkspaceSettings(workspace);
  const port =
    validPort(process.env.LLM_TRACKER_PORT) ||
    validPort(settings.port) ||
    DEFAULT_PORT;
  const url = `http://localhost:${port}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json };
  } catch (e) {
    return { status: 0, body: { error: e.message } };
  }
}

async function cmdLink(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const target = args._[2];
  if (!slug || !target) {
    console.error("Usage: llm-tracker link <slug> <absolute-path-to-tracker.json>");
    process.exit(1);
  }
  const abs = resolve(target);
  const { status, body } = await httpRequest(workspace, "POST", `/api/projects/${slug}/symlink`, {
    target: abs
  });
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`Link failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }
  console.log(`Linked ${slug}:`);
  console.log(`  ${body.linkPath}`);
  console.log(`   → ${body.target}`);
}

async function cmdRollback(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const rev = parseInt(args._[2], 10);
  if (!slug || isNaN(rev) || rev < 1) {
    console.error("Usage: llm-tracker rollback <slug> <rev>");
    process.exit(1);
  }
  const { status, body } = await httpRequest(workspace, "POST", `/api/projects/${slug}/rollback`, {
    to: rev
  });
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`Rollback failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }
  console.log(`Rolled ${slug} from rev ${body.from} back to rev ${body.to}. New rev: ${body.newRev}.`);
}

async function cmdSince(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const rev = parseInt(args._[2] ?? "0", 10);
  if (!slug || isNaN(rev) || rev < 0) {
    console.error("Usage: llm-tracker since <slug> [<rev>]");
    process.exit(1);
  }
  const { status, body } = await httpRequest(workspace, "GET", `/api/projects/${slug}/since/${rev}`);
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`Since failed (${status}): ${body.error || body.raw}`);
    process.exit(1);
  }
  if (args.flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log(`  ${slug}  rev ${body.fromRev} → ${body.currentRev}  (${body.events.length} events)`);
  for (const e of body.events) {
    const header = `  [rev ${e.rev}] ${e.ts}${e.rolledBackTo ? ` · rollback to rev ${e.rolledBackTo}` : ""}`;
    console.log(header);
    for (const s of e.summary || []) {
      if (s.kind === "status") console.log(`    ${s.id}: status → ${s.to}`);
      else if (s.kind === "placement") console.log(`    ${s.id}: placement → ${JSON.stringify(s.to)}`);
      else if (s.kind === "added") console.log(`    ${s.id}: added (${s.title || "untitled"}, ${s.status})`);
      else if (s.kind === "removed") console.log(`    ${s.id}: removed`);
      else if (s.kind === "assignee") console.log(`    ${s.id}: assignee → ${s.to}`);
      else if (s.kind === "edit") console.log(`    ${s.id}: edited (${s.keys.join(", ")})`);
      else if (s.kind === "meta") console.log(`    meta.${s.key} → ${JSON.stringify(s.to)}`);
      else if (s.kind === "reorder") console.log(`    reorder (${s.total} tasks)`);
    }
  }
}

function cmdStatus(args) {
  const workspace = resolveWorkspace(args.flags.path);
  if (!existsSync(workspace)) {
    console.error(`No workspace at ${workspace}. Run 'llm-tracker init' first.`);
    process.exit(1);
  }
  const projects = loadProjects(workspace);
  if (!projects) {
    console.error(`No trackers folder at ${workspace}.`);
    process.exit(1);
  }

  if (args.flags.json) {
    console.log(renderJson(projects, workspace));
    return;
  }

  const slug = args._[1];
  if (slug) {
    const proj = projects.find((p) => p.slug === slug);
    if (!proj) {
      console.error(`No project with slug "${slug}". Available: ${projects.map((p) => p.slug).join(", ") || "(none)"}`);
      process.exit(1);
    }
    console.log(renderProject(proj));
    if (!proj.ok) process.exit(1);
  } else {
    console.log(renderDashboard(projects, workspace));
    if (projects.some((p) => !p.ok)) process.exit(1);
  }
}

async function cmdRun(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const wsSettings = loadWorkspaceSettings(workspace);
  const port =
    validPort(args.flags.port) ||
    validPort(process.env.LLM_TRACKER_PORT) ||
    validPort(wsSettings.port) ||
    DEFAULT_PORT;

  if (!existsSync(workspace)) {
    console.error(`No workspace at ${workspace}. Run 'npx llm-tracker init' first.`);
    process.exit(1);
  }
  if (!existsSync(join(workspace, "README.md"))) {
    console.error(`Workspace at ${workspace} is missing README.md. Run 'npx llm-tracker init' to repair.`);
    process.exit(1);
  }
  for (const sub of ["trackers", "patches", ".snapshots", ".history"]) {
    mkdirSync(join(workspace, sub), { recursive: true });
  }

  await startHub({ workspace, port, uiDir: join(PKG_ROOT, "ui") });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "init") return cmdInit(args);
  if (cmd === "status") return cmdStatus(args);
  if (cmd === "rollback") return cmdRollback(args);
  if (cmd === "since") return cmdSince(args);
  if (cmd === "link") return cmdLink(args);
  if (cmd === "help" || args.flags.help) {
    console.log(`llm-tracker — file-system-as-database project tracker

Usage:
  llm-tracker init [--path <dir>]             Create a workspace (default ~/.llm-tracker)
  llm-tracker [--path <dir>] [--port N]       Start the hub (default port 4400)
  llm-tracker status [<slug>] [--json]        Print project status to stdout
  llm-tracker since <slug> [<rev>] [--json]   Print events since rev (requires hub running)
  llm-tracker rollback <slug> <rev>           Roll a project back to a prior rev (requires hub)
  llm-tracker link <slug> <abs-path>          Symlink an external tracker file into the workspace (requires hub)
  llm-tracker help                            Show this help

Env:
  LLM_TRACKER_HOME    Workspace folder (overrides default)
  LLM_TRACKER_PORT    Port (overrides settings.json and default)

Port priority (first match wins):
  1. --port flag
  2. LLM_TRACKER_PORT env
  3. <workspace>/settings.json "port" field (editable from the UI)
  4. Default ${DEFAULT_PORT}
`);
    return;
  }
  return cmdRun(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
