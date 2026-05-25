import { execFileSync as defaultExecFileSync } from "node:child_process";

const USAGE =
  "Usage: llm-tracker session attach --project <slug> --task <taskId> --agent <id> [--cwd <path>] [--repo-root <path>] [--worktree <path>] [--json]";

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function mcpCommand({ workspace, port } = {}) {
  const parts = ["llm-tracker", "mcp"];
  if (workspace) parts.push("--path", shellQuote(workspace));
  if (port) parts.push("--port", shellQuote(port));
  return parts.join(" ");
}

export function discoverRepoRoot(cwd, execFileSync = defaultExecFileSync) {
  if (!nonEmptyString(cwd)) return { repoRoot: null, repoKnown: false, error: "cwd required" };
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const repoRoot = String(out || "").trim();
    return repoRoot
      ? { repoRoot, repoKnown: true, error: null }
      : { repoRoot: null, repoKnown: false, error: "git rev-parse returned no path" };
  } catch (err) {
    return {
      repoRoot: null,
      repoKnown: false,
      error: err?.message || "git rev-parse failed",
    };
  }
}

export function buildAttachPayload({
  projectSlug,
  taskId,
  agent,
  cwd,
  repoRoot,
  worktreePath,
  name,
} = {}) {
  const payload = {
    name: nonEmptyString(name) || `${agent}:${projectSlug}/${taskId}`,
    tier: "manual",
    projectSlug,
    taskId,
    agent,
    cwd,
  };
  if (nonEmptyString(repoRoot)) payload.repoRoot = repoRoot;
  if (nonEmptyString(worktreePath)) payload.worktreePath = worktreePath;
  return payload;
}

export function renderAttachContract({ session, token, workspace, port, repoKnown, repoError } = {}) {
  const sessionId = session?.id || "";
  const jobId = session?.activeJobId || "";
  const repoRoot = session?.repoRoot || "";
  const worktreePath = session?.worktreePath || "";
  const command = mcpCommand({ workspace, port });
  const repoLine = repoKnown && repoRoot ? `repoRoot=${repoRoot}` : "repo unknown";
  const lines = [
    `Attached llm-tracker session ${sessionId}`,
    `project=${session?.projectSlug || ""} task=${session?.taskId || ""} agent=${session?.agent || ""}`,
    `cwd=${session?.cwd || ""}`,
    repoLine,
  ];
  if (worktreePath) lines.push(`worktreePath=${worktreePath}`);
  if (!repoKnown && repoError) lines.push(`repoDiscovery=${repoError}`);
  lines.push("");
  lines.push("Pasteable contract:");
  lines.push(`export LT_SESSION_ID=${shellQuote(sessionId)}`);
  lines.push(`export LT_JOB_ID=${shellQuote(jobId)}`);
  lines.push(`export LT_SESSION_TOKEN=${shellQuote(token || "")}`);
  lines.push("export LT_MCP_URL='stdio://llm-tracker-mcp'");
  lines.push(`export LT_MCP_COMMAND=${shellQuote(command)}`);
  lines.push("");
  lines.push("You are attached to llm-tracker session " + sessionId + (jobId ? ` and job ${jobId}.` : "."));
  lines.push("Use tracker_session_heartbeat every 5 minutes and report meaningful progress through the session MCP tools.");
  if (token) lines.push(`token=${token}`);
  else lines.push("token unavailable: hub session token store did not return cleartext");
  return lines.join("\n");
}

export async function runSessionAttachCommand({
  args,
  resolveWorkspace,
  httpRequest,
  execFileSync = defaultExecFileSync,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  if (args?._?.[1] !== "attach") {
    stderr.write(`${USAGE}\n`);
    return exit(1);
  }
  if (typeof resolveWorkspace !== "function" || typeof httpRequest !== "function") {
    stderr.write("session attach: workspace/http dependencies not provided\n");
    return exit(1);
  }

  const flags = args.flags || {};
  const projectSlug = nonEmptyString(flags.project);
  const taskId = nonEmptyString(flags.task);
  const agent = nonEmptyString(flags.agent);
  if (!projectSlug || !taskId || !agent) {
    stderr.write(`${USAGE}\n`);
    return exit(1);
  }

  const workspace = resolveWorkspace(flags.path);
  const sessionCwd = nonEmptyString(flags.cwd) || cwd;
  const explicitRepoRoot = nonEmptyString(flags["repo-root"]);
  const discovered = explicitRepoRoot
    ? { repoRoot: explicitRepoRoot, repoKnown: true, error: null }
    : discoverRepoRoot(sessionCwd, execFileSync);
  const worktreePath = nonEmptyString(flags.worktree) || nonEmptyString(flags["worktree-path"]);
  const payload = buildAttachPayload({
    projectSlug,
    taskId,
    agent,
    cwd: sessionCwd,
    repoRoot: discovered.repoRoot,
    worktreePath,
    name: nonEmptyString(flags.name),
  });

  const { status, body, port } = await httpRequest(workspace, flags.port, "POST", "/api/sessions", payload);
  if (status === 0) {
    stderr.write(`Session attach failed: hub not reachable. Start it with 'llm-tracker'.\n`);
    return exit(1);
  }
  if (status >= 400) {
    const message = body?.error?.message || body?.error || body?.raw || "request failed";
    stderr.write(`Session attach failed (${status}): ${message}\n`);
    return exit(1);
  }

  const result = {
    session: body.session,
    token: body.token,
    rev: body.rev,
    eventId: body.eventId,
    repoKnown: discovered.repoKnown,
    repoError: discovered.error,
  };
  const contract = renderAttachContract({
    session: body.session,
    token: body.token?.token,
    workspace,
    port,
    repoKnown: discovered.repoKnown,
    repoError: discovered.error,
  });

  if (flags.json) {
    stdout.write(JSON.stringify({ ...result, contract }, null, 2) + "\n");
    return exit(0);
  }
  stdout.write(contract + "\n");
  return exit(0);
}
