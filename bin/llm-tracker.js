#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cmdBlockers } from "./commands/blockers.js";
import { cmdBrief } from "./commands/brief.js";
import { cmdChanged } from "./commands/changed.js";
import { cmdDecisions } from "./commands/decisions.js";
import { cmdExecute } from "./commands/execute.js";
import { cmdFuzzy } from "./commands/fuzzy.js";
import { startMcpServer } from "./mcp-server.js";
import { cmdNext } from "./commands/next.js";
import { cmdPick } from "./commands/pick.js";
import { cmdReload } from "./commands/reload.js";
import { cmdRepairLinkedOverlays } from "./commands/repair-linked-overlays.js";
import { cmdSearch } from "./commands/search.js";
import { cmdStart } from "./commands/start.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdWhy } from "./commands/why.js";
import { DEFAULT_PORT, httpRequest, resolvePort, resolveWorkspace } from "./workspace-client.js";
import {
  daemonLogPath,
  ensureRuntimeDir,
  getDaemonStatus,
  isPidRunning,
  removeDaemonMeta,
  writeDaemonMeta
} from "../hub/runtime.js";

function validLineCount(n) {
  const count = parseInt(n, 10);
  return !isNaN(count) && count >= 1 && count <= 5000 ? count : null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");

const DAEMON_READY_TIMEOUT_MS = 5000;
const DAEMON_STOP_TIMEOUT_MS = 5000;
const DAEMON_FORCE_STOP_TIMEOUT_MS = 2000;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) {
        args.flags[k] = v;
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args.flags[k] = argv[++i];
      } else {
        args.flags[k] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
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

function ensureWorkspaceLayout(workspace) {
  for (const sub of ["trackers", "patches", ".snapshots", ".history", ".runtime"]) {
    mkdirSync(join(workspace, sub), { recursive: true });
  }
}

function ensureWorkspaceReady(workspace) {
  if (!existsSync(workspace)) {
    console.error(`No workspace at ${workspace}. Run 'npx llm-tracker init' first.`);
    process.exit(1);
  }
  if (!existsSync(join(workspace, "README.md"))) {
    console.error(`Workspace at ${workspace} is missing README.md. Run 'npx llm-tracker init' to repair.`);
    process.exit(1);
  }
  ensureWorkspaceLayout(workspace);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLogTail(file, lines = 40) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf-8");
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-lines).join("\n");
}

async function waitForDaemonStart(workspace, expectedPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getDaemonStatus(workspace);
    if (status.running && status.meta?.pid === expectedPid) return status.meta;
    await sleep(100);
  }
  return null;
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await sleep(100);
  }
  return !isPidRunning(pid);
}

function cmdInit(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const template = join(PKG_ROOT, "workspace-template");

  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    console.log(`Workspace already exists at ${workspace}`);
  } else {
    copyTree(template, workspace);
    ensureWorkspaceLayout(workspace);
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
  console.log(" Start the hub:      npx llm-tracker");
  console.log(" Start in background: npx llm-tracker --daemon");
  console.log(" UI help modal has one-click copy-paste prompts for both modes.");
  console.log("─────────────────────────────────────────────────────────");
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
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "POST",
    `/api/projects/${slug}/symlink`,
    { target: abs }
  );
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
  if (body.loaded) {
    console.log(`  loaded: yes${typeof body.rev === "number" ? ` (rev ${body.rev})` : ""}`);
  }
}

async function cmdRestore(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  if (!slug) {
    console.error("Usage: llm-tracker restore <slug> [--rev <rev>]");
    process.exit(1);
  }
  const body = {};
  if (args.flags.rev !== undefined) {
    const r = parseInt(args.flags.rev, 10);
    if (isNaN(r) || r < 1) {
      console.error("--rev must be a positive integer");
      process.exit(1);
    }
    body.rev = r;
  }
  const { status, body: resp } = await httpRequest(
    workspace,
    args.flags.port,
    "POST",
    `/api/projects/${slug}/restore`,
    body
  );
  if (status === 0) {
    console.error("Hub not reachable. Start it with 'llm-tracker'.");
    process.exit(1);
  }
  if (status >= 400) {
    console.error(`Restore failed (${status}): ${resp.error || resp.raw}`);
    process.exit(1);
  }
  console.log(
    `Restored ${slug} from snapshot rev ${resp.restoredFromRev}. Current rev: ${resp.rev}.`
  );
  console.log(`  file: ${resp.file}`);
}

async function cmdRollback(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const slug = args._[1];
  const rev = parseInt(args._[2], 10);
  if (!slug || isNaN(rev) || rev < 1) {
    console.error("Usage: llm-tracker rollback <slug> <rev>");
    process.exit(1);
  }
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "POST",
    `/api/projects/${slug}/rollback`,
    { to: rev }
  );
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
  const { status, body } = await httpRequest(
    workspace,
    args.flags.port,
    "GET",
    `/api/projects/${slug}/since/${rev}`
  );
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

async function cmdStatus(args) {
  const workspace = resolveWorkspace(args.flags.path);
  if (!existsSync(workspace)) {
    console.error(`No workspace at ${workspace}. Run 'llm-tracker init' first.`);
    process.exit(1);
  }
  const { loadProjects, renderDashboard, renderProject, renderJson } = await import("../hub/status.js");
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

async function cmdRun(args, { daemonized = false } = {}) {
  const workspace = resolveWorkspace(args.flags.path);
  const port = resolvePort(workspace, args.flags.port);

  ensureWorkspaceReady(workspace);
  const { startHub } = await import("../hub/server.js");
  await startHub({ workspace, port, uiDir: join(PKG_ROOT, "ui") });

  if (daemonized) {
    process.on("exit", () => removeDaemonMeta(workspace));
    writeDaemonMeta(workspace, {
      pid: process.pid,
      port,
      workspace,
      startedAt: new Date().toISOString(),
      logFile: daemonLogPath(workspace)
    });
  }
}

async function cmdDaemonStart(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const port = resolvePort(workspace, args.flags.port);

  ensureWorkspaceReady(workspace);
  ensureRuntimeDir(workspace);

  const current = getDaemonStatus(workspace);
  if (current.running) {
    console.error(`Background hub already running for ${workspace}.`);
    console.error(`  pid: ${current.meta.pid}`);
    console.error(`  port: ${current.meta.port}`);
    console.error(`  log: ${current.logFile}`);
    process.exit(1);
  }
  if (current.stale) removeDaemonMeta(workspace);

  const logFile = daemonLogPath(workspace);
  writeFileSync(logFile, `\n[${new Date().toISOString()}] starting daemon on :${port}\n`, { flag: "a" });
  const logFd = openSync(logFile, "a");

  let child;
  try {
    child = spawn(
      process.execPath,
      [__filename, "__run-hub", "--path", workspace, "--port", String(port)],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", logFd, logFd]
      }
    );
  } finally {
    closeSync(logFd);
  }

  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const meta = await waitForDaemonStart(workspace, child.pid, DAEMON_READY_TIMEOUT_MS);
  child.unref();

  if (meta) {
    console.log(`Background hub started for ${workspace}.`);
    console.log(`  pid: ${meta.pid}`);
    console.log(`  url: http://localhost:${meta.port}`);
    console.log(`  log: ${meta.logFile}`);
    console.log(`  stop: llm-tracker daemon stop --path ${workspace}`);
    return;
  }

  removeDaemonMeta(workspace);
  console.error(`Background hub failed to start for ${workspace}.`);
  console.error(`  log: ${logFile}`);
  if (childExit) {
    console.error(`  child exit: ${childExit.code ?? "null"}${childExit.signal ? ` (${childExit.signal})` : ""}`);
  }
  const tail = readLogTail(logFile, 20);
  if (tail) {
    console.error("");
    console.error(tail);
  }
  process.exit(1);
}

async function cmdDaemonStop(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const status = getDaemonStatus(workspace);

  if (!status.meta) {
    console.log(`No background hub metadata found for ${workspace}.`);
    return;
  }

  if (status.stale) {
    removeDaemonMeta(workspace);
    console.log(`Removed stale daemon metadata for ${workspace}.`);
    console.log(`  log: ${status.logFile}`);
    return;
  }

  try {
    process.kill(status.meta.pid, "SIGTERM");
  } catch (e) {
    removeDaemonMeta(workspace);
    console.error(`Failed to signal pid ${status.meta.pid}: ${e.message}`);
    process.exit(1);
  }
  const stopped = await waitForPidExit(status.meta.pid, DAEMON_STOP_TIMEOUT_MS);
  if (!stopped) {
    try {
      process.kill(status.meta.pid, "SIGKILL");
    } catch (e) {
      if (!isPidRunning(status.meta.pid)) {
        removeDaemonMeta(workspace);
        console.log(`Stopped background hub for ${workspace}.`);
        console.log(`  pid: ${status.meta.pid}`);
        return;
      }
      console.error(`Timed out waiting for pid ${status.meta.pid} to stop.`);
      console.error(`  log: ${status.logFile}`);
      console.error(`  force-stop failed: ${e.message}`);
      process.exit(1);
    }

    const forced = await waitForPidExit(status.meta.pid, DAEMON_FORCE_STOP_TIMEOUT_MS);
    if (!forced) {
      console.error(`Timed out waiting for pid ${status.meta.pid} to stop after SIGKILL.`);
      console.error(`  log: ${status.logFile}`);
      process.exit(1);
    }

    removeDaemonMeta(workspace);
    console.log(`Force-stopped background hub for ${workspace}.`);
    console.log(`  pid: ${status.meta.pid}`);
    return;
  }

  removeDaemonMeta(workspace);
  console.log(`Stopped background hub for ${workspace}.`);
  console.log(`  pid: ${status.meta.pid}`);
}

function cmdDaemonStatus(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const status = getDaemonStatus(workspace);

  if (!status.meta) {
    console.log(`Background hub is not running for ${workspace}.`);
    console.log(`  log: ${status.logFile}`);
    return;
  }

  if (status.stale) {
    removeDaemonMeta(workspace);
    console.log(`Background hub metadata was stale for ${workspace} and has been cleared.`);
    console.log(`  last pid: ${status.meta.pid}`);
    console.log(`  log: ${status.logFile}`);
    return;
  }

  console.log(`Background hub is running for ${workspace}.`);
  console.log(`  pid: ${status.meta.pid}`);
  console.log(`  port: ${status.meta.port}`);
  console.log(`  started: ${status.meta.startedAt}`);
  console.log(`  url: http://localhost:${status.meta.port}`);
  console.log(`  log: ${status.logFile}`);
}

function cmdDaemonLogs(args) {
  const workspace = resolveWorkspace(args.flags.path);
  const lines = validLineCount(args.flags.lines) || 80;
  const logFile = daemonLogPath(workspace);
  if (!existsSync(logFile)) {
    console.error(`No daemon log found at ${logFile}.`);
    process.exit(1);
  }
  const tail = readLogTail(logFile, lines);
  if (!tail) {
    console.log(`No daemon log output yet at ${logFile}.`);
    return;
  }
  console.log(tail);
}

async function cmdDaemon(args) {
  const action = args._[1] || "status";
  if (action === "start") return cmdDaemonStart(args);
  if (action === "stop") return cmdDaemonStop(args);
  if (action === "restart") {
    const workspace = resolveWorkspace(args.flags.path);
    const current = getDaemonStatus(workspace);
    const restartArgs = {
      ...args,
      flags: { ...args.flags }
    };
    if (restartArgs.flags.port === undefined && current.running && current.meta?.port) {
      restartArgs.flags.port = String(current.meta.port);
    }
    await cmdDaemonStop(args);
    return cmdDaemonStart(restartArgs);
  }
  if (action === "status") return cmdDaemonStatus(args);
  if (action === "logs") return cmdDaemonLogs(args);

  console.error(`Unknown daemon action "${action}". Use start, stop, restart, status, or logs.`);
  process.exit(1);
}

function renderShellShortcuts(aliasName = "lt") {
  return `# Add to ~/.zshrc or ~/.bashrc, or eval directly:
#   eval "$(npx llm-tracker shortcuts)"
#
# Then run zero-token tracker commands such as:
#   ${aliasName} next <slug>
#   ${aliasName} brief <slug> <taskId>
#   ${aliasName} verify <slug> <taskId>
__llm_tracker_cli() {
  if command -v llm-tracker >/dev/null 2>&1; then
    llm-tracker "$@"
  else
    npx llm-tracker "$@"
  fi
}
${aliasName}() {
  __llm_tracker_cli "$@"
}
`;
}

function cmdShortcuts(args) {
  const aliasName = String(args.flags.alias || "lt");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(aliasName)) {
    console.error("Usage: llm-tracker shortcuts [--alias <shell-function-name>]");
    console.error(`Invalid alias "${aliasName}". Use letters, numbers, and underscores only.`);
    process.exit(1);
  }
  console.log(renderShellShortcuts(aliasName));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const daemonFlag = !!(args.flags.daemon || args.flags.background);

  if (cmd === "__run-hub") return cmdRun(args, { daemonized: true });
  if (cmd === "init") return cmdInit(args);
  if (cmd === "status") return cmdStatus(args);
  if (cmd === "brief") return cmdBrief(args, { resolveWorkspace, httpRequest });
  if (cmd === "why") return cmdWhy(args, { resolveWorkspace, httpRequest });
  if (cmd === "decisions") return cmdDecisions(args, { resolveWorkspace, httpRequest });
  if (cmd === "execute") return cmdExecute(args, { resolveWorkspace, httpRequest });
  if (cmd === "verify") return cmdVerify(args, { resolveWorkspace, httpRequest });
  if (cmd === "blockers") return cmdBlockers(args, { resolveWorkspace, httpRequest });
  if (cmd === "changed") return cmdChanged(args, { resolveWorkspace, httpRequest });
  if (cmd === "search") return cmdSearch(args, { resolveWorkspace, httpRequest });
  if (cmd === "fuzzy" || cmd === "fuzzy-search") return cmdFuzzy(args, { resolveWorkspace, httpRequest });
  if (cmd === "reload") return cmdReload(args, { resolveWorkspace, httpRequest });
  if (cmd === "start") return cmdStart(args, { resolveWorkspace, httpRequest });
  if (cmd === "pick" || cmd === "claim") return cmdPick(args, { resolveWorkspace, httpRequest });
  if (cmd === "next") return cmdNext(args, { resolveWorkspace, httpRequest });
  if (cmd === "rollback") return cmdRollback(args);
  if (cmd === "restore") return cmdRestore(args);
  if (cmd === "since") return cmdSince(args);
  if (cmd === "link") return cmdLink(args);
  if (cmd === "repair-linked-overlays") return cmdRepairLinkedOverlays(args, { resolveWorkspace });
  if (cmd === "shortcuts") return cmdShortcuts(args);
  if (cmd === "mcp") return startMcpServer({ workspace: args.flags.path, portFlag: args.flags.port });
  if (cmd === "daemon") return cmdDaemon(args);
  if (cmd === "help" || args.flags.help) {
    console.log(`llm-tracker — file-system-as-database project tracker

Usage:
  llm-tracker init [--path <dir>]                       Create a workspace (default ~/.llm-tracker)
  llm-tracker [--path <dir>] [--port N]                Start the hub in the foreground (default)
  llm-tracker [--path <dir>] [--port N] --daemon       Start the hub in the background
  llm-tracker daemon start [--path <dir>] [--port N]   Start the background daemon
  llm-tracker daemon stop [--path <dir>]               Stop the background daemon
  llm-tracker daemon restart [--path <dir>] [--port N] Restart the background daemon
  llm-tracker daemon status [--path <dir>]             Show daemon status
  llm-tracker daemon logs [--path <dir>] [--lines N]   Print recent daemon logs
  llm-tracker mcp [--path <dir>] [--port N]            Start the stdio MCP server
  llm-tracker status [<slug>] [--json]                 Print project status to stdout
  llm-tracker reload [<slug>] [--json]                 Reload one or all trackers from disk (requires hub)
  llm-tracker brief <slug> <taskId> [--json]           Print a task brief pack (requires hub)
  llm-tracker why <slug> <taskId> [--json]             Explain why a task matters now (requires hub)
  llm-tracker decisions <slug> [--json] [--limit N]    Print recent project decisions (requires hub)
  llm-tracker execute <slug> <taskId> [--json]         Print a deterministic execution pack (requires hub)
  llm-tracker verify <slug> <taskId> [--json]          Print a deterministic verification pack (requires hub)
  llm-tracker blockers <slug> [--json]                 Print structurally blocked tasks (requires hub)
  llm-tracker changed <slug> [<fromRev>] [--json]      Print changed tasks since a rev (requires hub)
  llm-tracker search <slug> <query> [--json] [--limit N] Semantic task search with local embeddings (requires hub)
  llm-tracker fuzzy|fuzzy-search <slug> <query> [--json] [--limit N]  Fuzzy lexical task search (requires hub)
  llm-tracker start <slug> <taskId> --assignee ID [--scratchpad TEXT] Start an explicit task atomically (requires hub)
  llm-tracker pick <slug> [<taskId>] [--assignee ID]   Claim a task atomically (requires hub)
  llm-tracker next <slug> [--json] [--limit N] [--include-gated] Print ranked executable tasks (requires hub)
  llm-tracker since <slug> [<rev>] [--json]            Print events since rev (requires hub running)
  llm-tracker rollback <slug> <rev>                    Roll a project back to a prior rev (requires hub)
  llm-tracker restore <slug> [--rev <rev>]             Restore a deleted project from its snapshot (requires hub)
  llm-tracker link <slug> <abs-path>                   Symlink an external tracker file into the workspace (requires hub)
  llm-tracker repair-linked-overlays [slug...] [--write] Apply legacy overlays to linked repo-local trackers
  llm-tracker shortcuts [--alias NAME]                 Print shell shortcuts for zero-token lt next / lt brief usage
  llm-tracker help                                     Show this help

Env:
  LLM_TRACKER_HOME    Workspace folder (overrides default)
  LLM_TRACKER_PORT    Port (overrides settings.json and default)
  LLM_TRACKER_ASSIGNEE Default assignee for start / pick / claim; required for start if --assignee is omitted

Port priority (first match wins):
  1. --port flag
  2. LLM_TRACKER_PORT env
  3. <workspace>/settings.json "port" field (editable from the UI)
  4. Default ${DEFAULT_PORT}
`);
    return;
  }
  if (cmd) {
    console.error(`Unknown command "${cmd}". Use 'llm-tracker help'.`);
    process.exit(1);
  }
  if (daemonFlag) return cmdDaemonStart(args);
  return cmdRun(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
