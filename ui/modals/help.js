import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

export function HelpModal({ workspace, onClose }) {
  const port = typeof location !== "undefined" ? location.port || "4400" : "4400";
  const readme = workspace?.readme || "~/.llm-tracker/README.md";
  const wsPath = workspace?.workspace || "~/.llm-tracker";

  const promptFile =
    "Read http://localhost:" + port + "/help (or " + readme + " on disk) and register this project as <slug>.\n\n" +
    "WORKSPACE IS AT: " + wsPath + "\n" +
    "Every path you read or write MUST begin with that absolute path. " +
    "Do NOT create a new .llm-tracker/ folder anywhere else. " +
    "Do NOT write README.md, templates/, or settings.json — they already exist at the workspace. " +
    "If you're about to create any of those, STOP: you're in the wrong directory.\n\n" +
    "Registration (ONE time): write the full project to " + wsPath + "/trackers/<slug>.json\n\n" +
    "Updates (constant): use FILE PATCH mode — write each change as a small JSON patch to\n" +
    "  " + wsPath + "/patches/<slug>.<timestamp>.json\n" +
    "containing only the fields you're changing. The hub merges and deletes the patch file.\n\n" +
    "Patch body:\n" +
    '  {"tasks":{"t-001":{"status":"complete","context":{"notes":"..."}}},"meta":{"scratchpad":"..."}}\n\n' +
    "Read the tracker only at decision points (claiming next task, resolving a blocker). Writes are fire-and-forget.";

  const promptHttp =
    "Read http://localhost:" + port + "/help for the live contract, then use HTTP-only (no file paths, no fs writes).\n\n" +
    "IMPORTANT — ALWAYS use --data-binary @file.json, never inline -d '...'.\n" +
    "Inline curl -d strips newlines and corrupts JSON bodies that contain quotes, " +
    "newlines, or special characters. Write the body to a file first, then send it with " +
    "--data-binary. Use --data-raw only for tiny payloads you are certain have no shell-special chars.\n\n" +
    "Register this project as <slug> by PUTting the full tracker JSON:\n" +
    "  1. Write the full project to /tmp/<slug>-init.json\n" +
    "  2. curl -X PUT http://localhost:" + port + "/api/projects/<slug> \\\n" +
    "       -H 'Content-Type: application/json' \\\n" +
    "       --data-binary @/tmp/<slug>-init.json\n\n" +
    "Update with small patches — only include fields you're changing:\n" +
    "  1. Write the patch to /tmp/<slug>-patch.json\n" +
    "  2. curl -X POST http://localhost:" + port + "/api/projects/<slug>/patch \\\n" +
    "       -H 'Content-Type: application/json' \\\n" +
    "       --data-binary @/tmp/<slug>-patch.json\n\n" +
    "Patch body shape: {\"tasks\":{\"<id>\":{\"status\":\"complete\"}},\"meta\":{\"scratchpad\":\"...\"}}\n\n" +
    "Pull changes since a rev (avoid re-reading the whole tracker):\n" +
    "  curl http://localhost:" + port + "/api/projects/<slug>/since/<your-last-rev>\n\n" +
    "If any call fails: rerun with -i to capture headers, and parse the JSON response body " +
    "(the hub always returns JSON errors with {error, type, hint}).\n\n" +
    "One-time: the user may need to pre-approve curl to localhost:" + port + ". After that, HTTP mode " +
    "requires no filesystem access to the tracker workspace.";

  const [mode, setMode] = useState("file");
  const [copied, setCopied] = useState(false);
  const [liveHelp, setLiveHelp] = useState("");
  const [helpError, setHelpError] = useState(null);
  const [helpCopied, setHelpCopied] = useState(false);
  const activePrompt = mode === "file" ? promptFile : promptHttp;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(activePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const copyHelp = async () => {
    if (!liveHelp) return;
    try {
      await navigator.clipboard.writeText(liveHelp);
      setHelpCopied(true);
      setTimeout(() => setHelpCopied(false), 1800);
    } catch {}
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    fetch("/help")
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        return response.text();
      })
      .then((text) => {
        setLiveHelp(text);
        setHelpError(null);
      })
      .catch((error) => setHelpError(error.message));
  }, []);

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal help-modal" role="dialog" aria-modal="true" aria-label="Help" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[HELP] · LLM PROJECT TRACKER</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
        </div>

        <div class="modal-body">
          <section>
            <h3>How it works</h3>
            <p>
              Every project is one JSON file in <code>trackers/</code>. The hub is authoritative for structure (task order, which tasks exist, swimlane collapse). The LLM is authoritative for content (status, assignee, context, priorities). The LLM sends tiny patches; the hub merges them under a per-project lock; the UI renders live over WebSocket.
            </p>
          </section>

          <section>
            <h3>Register a project — pick a write mode</h3>
            <div class="mode-tabs">
              <button
                class=${`mode-tab ${mode === "file" ? "active" : ""}`}
                onClick=${() => setMode("file")}
              >[MODE A · FILE PATCHES]</button>
              <button
                class=${`mode-tab ${mode === "http" ? "active" : ""}`}
                onClick=${() => setMode("http")}
              >[MODE B · HTTP PATCHES]</button>
            </div>
            <p class="muted">
              ${mode === "file"
                ? "Bash-less. Works in any CLI with filesystem Write access (Claude Code, Cursor, Aider, …) without approval. The LLM writes small patch files; the hub picks them up and deletes them."
                : "Fastest. Requires a one-time pre-approval of curl-to-localhost in your CLI. After that, every update is a single HTTP POST."}
            </p>
            <div class="copy-block" onClick=${copy}>
              <code class="copy-block-text">${activePrompt}</code>
              <button class="copy-btn">${copied ? "[COPIED]" : "[COPY]"}</button>
            </div>
            <p class="muted">Replace <code>${"<slug>"}</code> with the project ID you want (lowercase, dash-separated).</p>
          </section>

          <section>
            <h3>Live Contract (/help)</h3>
            ${helpError
              ? html`<p class="muted">failed to load /help: ${helpError}</p>`
              : liveHelp
                ? html`
                    <div class="copy-block contract-block" onClick=${copyHelp}>
                      <code class="copy-block-text">${liveHelp}</code>
                      <button class="copy-btn">${helpCopied ? "[COPIED]" : "[COPY]"}</button>
                    </div>
                  `
                : html`<p class="muted">loading /help…</p>`}
          </section>

          <section>
            <h3>What the LLM writes</h3>
            <ul class="rules">
              <li><b>status</b> not_started → in_progress → complete (or deferred when parked)</li>
              <li><b>assignee</b> its model ID when it claims a task</li>
              <li><b>kind</b> optional "group" for tree-view container rows</li>
              <li><b>parent_id</b> optional containing task ID; supports nested groups and is not a blocker</li>
              <li><b>dependencies</b> task IDs this one blocks on</li>
              <li><b>blocker_reason</b> one sentence when stuck</li>
              <li><b>context.*</b> tags, files_touched, notes — free-form diagnostics</li>
              <li><b>placement.priorityId / swimlaneId</b> — yes, it can re-prioritize or re-home tasks</li>
              <li><b>meta.scratchpad</b> a status banner to you (pin, test count, next milestone)</li>
              <li><b>New tasks</b> appended to the end of tasks[] automatically</li>
            </ul>
          </section>

          <section>
            <h3>What the hub enforces (LLM can't break)</h3>
            <ul class="rules">
              <li><b>Task array order</b> — hub preserves it; reorder happens only via your UI drag.</li>
              <li><b>Deletion</b> — LLMs can't remove tasks. They deprecate with status: "deferred". Humans delete via the UI.</li>
              <li><b>meta.swimlanes[i].collapsed</b> — hub always keeps the current value; LLM submissions for this field are dropped.</li>
              <li><b>updatedAt, rev</b> — hub-owned; LLM submissions are ignored.</li>
            </ul>
          </section>

          <section>
            <h3>Status from any shell</h3>
            <p>
              <code>npx llm-tracker status</code> — dashboard of all projects<br/>
              <code>npx llm-tracker status ${"<slug>"}</code> — one project in detail<br/>
              <code>npx llm-tracker status --json</code> — machine-readable for tool chains
            </p>
          </section>

          <section>
            <h3>Workspace</h3>
            <ul class="rules">
              <li><b>README:</b> <code>${readme}</code></li>
              <li><b>Workspace:</b> <code>${wsPath}</code></li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  `;
}
