import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";

const STATUS_ORDER = ["complete", "in_progress", "not_started", "deferred"];

// ─────── Settings (localStorage) ───────
const SETTINGS_KEY = "llmtracker.settings";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

// ─────── Small components ───────

function SegBar({ counts, total, thin }) {
  const pct = (k) => (total === 0 ? 0 : (counts[k] || 0) / total * 100);
  return html`
    <div class=${`seg-bar ${thin ? "thin" : ""}`}>
      ${STATUS_ORDER.map(
        (k) =>
          html`<span class=${`seg-${k}`} style=${`width: ${pct(k)}%`} title=${`${k}: ${counts[k] || 0}`}></span>`
      )}
    </div>
  `;
}

function Badge({ kind, children, title }) {
  return html`<span class=${`badge ${kind || ""}`} title=${title || ""}>${children}</span>`;
}

function IconBtn({ label, onClick, active, title }) {
  return html`
    <button class=${`icon-btn ${active ? "active" : ""}`} onClick=${onClick} title=${title || ""}>
      ${label}
    </button>
  `;
}

// ─────── Custom dropdown ───────
function Dropdown({ value, options, onChange, renderLabel, className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return html`
    <div class=${`dropdown ${open ? "open" : ""} ${className || ""}`} ref=${ref}>
      <button class="dropdown-trigger" onClick=${() => setOpen(!open)}>
        <span class="dropdown-prompt">${">"}</span>
        <span class="dropdown-value">${renderLabel(value)}</span>
        <span class="dropdown-caret">${open ? "▲" : "▼"}</span>
      </button>
      ${open
        ? html`
          <div class="dropdown-menu">
            ${options.map(
              (o) => html`
                <button
                  key=${o}
                  class=${`dropdown-item ${o === value ? "active" : ""}`}
                  onClick=${() => {
                    onChange(o);
                    setOpen(false);
                  }}
                >
                  <span class="dot">${o === value ? "●" : " "}</span>
                  ${renderLabel(o)}
                </button>
              `
            )}
          </div>
        `
        : null}
    </div>
  `;
}

// ─────── Filter toggles (status + block) ───────
function FilterToggles({ counts, statusFilters, toggleStatus, blockedCount, openCount, blockFilters, toggleBlock }) {
  return html`
    <div class="filter-toggles">
      <div class="filter-group">
        <span class="filter-label">STATUS</span>
        ${STATUS_ORDER.map(
          (s) => html`
            <button
              key=${s}
              class=${`status-toggle status-${s} ${statusFilters.has(s) ? "active" : ""}`}
              onClick=${() => toggleStatus(s)}
              title=${`${s.replace("_", " ")} · ${counts[s] || 0}`}
            >
              ${s.replace("_", " ")}
              <span class="count">${counts[s] || 0}</span>
            </button>
          `
        )}
      </div>
      <div class="filter-group">
        <span class="filter-label">BLOCK</span>
        <button
          class=${`block-toggle blocked ${blockFilters.has("blocked") ? "active" : ""}`}
          onClick=${() => toggleBlock("blocked")}
          title=${`blocked · ${blockedCount}`}
        >
          blocked
          <span class="count">${blockedCount}</span>
        </button>
        <button
          class=${`block-toggle open ${blockFilters.has("open") ? "active" : ""}`}
          onClick=${() => toggleBlock("open")}
          title=${`open · ${openCount}`}
        >
          open
          <span class="count">${openCount}</span>
        </button>
      </div>
    </div>
  `;
}

// ─────── Card / Cell / Matrix ───────

function Card({ task, blockedBy, dragging, onDragStart, onDragEnd, onDelete }) {
  const ctx = task.context || {};
  const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
  const extraKeys = Object.keys(ctx).filter(
    (k) => k !== "tags" && k !== "notes" && k !== "files_touched"
  );
  const classes = ["card", `status-${task.status}`, dragging ? "dragging" : ""].join(" ");

  return html`
    <div
      class=${classes}
      draggable="true"
      data-task-id=${task.id}
      onDragStart=${(e) => onDragStart(e, task)}
      onDragEnd=${onDragEnd}
    >
      <button
        class="card-delete"
        title=${`Delete task ${task.id}`}
        onMouseDown=${(e) => e.stopPropagation()}
        onClick=${(e) => {
          e.stopPropagation();
          e.preventDefault();
          onDelete && onDelete(task);
        }}
      >×</button>
      <div class="card-id">${task.id}</div>
      <div class="card-title">${task.title}</div>
      ${task.goal ? html`<div class="card-goal">${task.goal}</div>` : null}
      ${ctx.notes ? html`<div class="card-goal">${ctx.notes}</div>` : null}
      ${extraKeys.length > 0
        ? html`<div class="card-context"><b>${extraKeys[0]}:</b> ${String(ctx[extraKeys[0]])}</div>`
        : null}
      <div class="card-footer">
        <${Badge} kind=${`status-${task.status}`}>${task.status.replace("_", " ")}</${Badge}>
        ${blockedBy && blockedBy.length > 0
          ? html`<${Badge} kind="blocked" title=${`Blocked by ${blockedBy.join(", ")}`}>blocked · ${blockedBy.length}</${Badge}>`
          : null}
        ${task.assignee ? html`<${Badge} kind="assignee">${task.assignee}</${Badge}>` : null}
        ${tags.map((t) => html`<${Badge} kind="tag">${t}</${Badge}>`)}
      </div>
    </div>
  `;
}

function Cell({ laneId, priorityId, tasks, blocked, filterQuery, statusFilters, blockFilters, dragState, setDragState, onDrop, onDeleteTask }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  const matchesText = (t) => {
    if (!filterQuery) return true;
    const q = filterQuery.toLowerCase();
    if (t.title.toLowerCase().includes(q)) return true;
    if (t.id.toLowerCase().includes(q)) return true;
    if ((t.goal || "").toLowerCase().includes(q)) return true;
    const tags = (t.context && t.context.tags) || [];
    if (tags.some((tag) => String(tag).toLowerCase().includes(q))) return true;
    return false;
  };

  const matchesStatus = (t) => {
    if (!statusFilters || statusFilters.size === 0) return true;
    return statusFilters.has(t.status);
  };

  const isBlocked = (t) => blocked[t.id] && blocked[t.id].length > 0;

  const matchesBlock = (t) => {
    if (!blockFilters || blockFilters.size === 0) return true;
    return blockFilters.has(isBlocked(t) ? "blocked" : "open");
  };

  const filtered = tasks.filter((t) => matchesStatus(t) && matchesBlock(t) && matchesText(t));

  const handleDragOver = (e) => {
    if (!dragState.taskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  const handleDragLeave = (e) => {
    if (ref.current && !ref.current.contains(e.relatedTarget)) setOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (!dragState.taskId) return;
    const y = e.clientY;
    let idx = 0;
    for (const child of ref.current.children) {
      if (!child.classList || !child.classList.contains("card")) continue;
      if (child.dataset.taskId === dragState.taskId) continue;
      const cr = child.getBoundingClientRect();
      if (y > cr.top + cr.height / 2) idx++;
    }
    onDrop({ taskId: dragState.taskId, swimlaneId: laneId, priorityId, targetIndex: idx });
  };

  return html`
    <div
      class=${`cell ${over ? "drop-target" : ""}`}
      ref=${ref}
      onDragOver=${handleDragOver}
      onDragLeave=${handleDragLeave}
      onDrop=${handleDrop}
    >
      ${filtered.length === 0 && tasks.length === 0
        ? html`<div class="cell-empty">no tasks</div>`
        : null}
      ${filtered.map(
        (t) => html`
          <${Card}
            key=${t.id}
            task=${t}
            blockedBy=${blocked[t.id]}
            dragging=${dragState.taskId === t.id}
            onDragStart=${(e, task) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", task.id);
              setDragState({ taskId: task.id });
            }}
            onDragEnd=${() => setDragState({ taskId: null })}
            onDelete=${onDeleteTask}
          />
        `
      )}
    </div>
  `;
}

function Matrix({ project, filterQuery, statusFilters, blockFilters, onMove, onToggleCollapse, onDeleteTask }) {
  const [dragState, setDragState] = useState({ taskId: null });
  const swimlanes = project.data.meta.swimlanes;
  const priorities = project.data.meta.priorities;
  const blocked = project.derived?.blocked || {};

  const byCell = useMemo(() => {
    const map = {};
    for (const t of project.data.tasks) {
      const key = `${t.placement.swimlaneId}::${t.placement.priorityId}`;
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    return map;
  }, [project]);

  const headerRow = html`
    <div class="hdr">
      <span class="brand">swimlane</span>
    </div>
    ${priorities.map(
      (p) => html`
        <div class=${`hdr hdr-priority ${p.id}`}>
          <span class="label">${p.label}</span>
          <span class="brand">${p.id}</span>
        </div>
      `
    )}
  `;

  const rows = swimlanes.map((lane) => {
    const per = project.derived?.perSwimlane?.[lane.id] || { counts: {}, pct: 0, total: 0 };
    const active = per.counts.in_progress || 0;
    const allComplete = per.total > 0 && per.counts.complete === per.total;
    const effectiveCollapsed =
      lane.collapsed !== undefined ? lane.collapsed : allComplete;

    if (effectiveCollapsed) {
      return html`
        <div
          class="lane-collapsed"
          key=${`lane-${lane.id}`}
          onClick=${() => onToggleCollapse(lane.id, false)}
          role="button"
          tabIndex="0"
          onKeyDown=${(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse(lane.id, false);
            }
          }}
          title="Click to expand swimlane"
        >
          <span class="lane-chevron">${"\u25B6"}</span>
          <div class="lane-collapsed-label">${lane.label}</div>
          ${lane.description ? html`<div class="lane-desc">${lane.description}</div>` : null}
          <div class="lane-collapsed-stats">
            <span>${per.total} tasks</span>
            <span class="active">· ${active} active</span>
            <span>· ${per.counts.complete || 0} done</span>
          </div>
          <${SegBar} counts=${per.counts} total=${per.total} thin />
          <span class="lane-collapsed-pct">${per.pct}%</span>
        </div>
      `;
    }

    return html`
      <div class="lane-cell" key=${`lane-${lane.id}`}>
        <div class="lane-cell-head">
          <button
            class="lane-chevron"
            onClick=${() => onToggleCollapse(lane.id, true)}
            title="Collapse swimlane"
          >${"\u25BC"}</button>
          <div class="lane-label">${lane.label}</div>
        </div>
        ${lane.description ? html`<div class="lane-desc">${lane.description}</div>` : null}
        <div class="lane-stats">
          <span>${per.total} tasks</span>
          <span class="active">· ${active} active</span>
        </div>
        <${SegBar} counts=${per.counts} total=${per.total} thin />
      </div>
      ${priorities.map(
        (p) => html`
          <${Cell}
            key=${`${lane.id}::${p.id}`}
            laneId=${lane.id}
            priorityId=${p.id}
            tasks=${byCell[`${lane.id}::${p.id}`] || []}
            blocked=${blocked}
            filterQuery=${filterQuery}
            statusFilters=${statusFilters}
            blockFilters=${blockFilters}
            dragState=${dragState}
            setDragState=${setDragState}
            onDrop=${onMove}
            onDeleteTask=${onDeleteTask}
          />
        `
      )}
    `;
  });

  return html`
    <div class="matrix-wrap">
      <div class="matrix" style=${`--col-count: ${priorities.length}`}>
        ${headerRow}
        ${rows}
      </div>
    </div>
  `;
}

// ─────── Help modal ───────
function HelpModal({ workspace, onClose }) {
  const port = typeof location !== "undefined" ? location.port || "4400" : "4400";
  const readme = workspace?.readme || "~/.llm-tracker/README.md";
  const wsPath = workspace?.workspace || "~/.llm-tracker";

  const promptFile =
    "Read " + readme + " and register this project as <slug>.\n\n" +
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
    "Read " + readme + " for the contract, then use HTTP-only (no file paths, no fs writes).\n\n" +
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
  const activePrompt = mode === "file" ? promptFile : promptHttp;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(activePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal help-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[HELP] · LLM PROJECT TRACKER</span>
          <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
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
            <h3>What the LLM writes</h3>
            <ul class="rules">
              <li><b>status</b> not_started → in_progress → complete (or deferred when parked)</li>
              <li><b>assignee</b> its model ID when it claims a task</li>
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

// ─────── Settings modal ───────
function SettingsModal({ onClose, theme, onToggleTheme, drawerPinned, onToggleDrawerPin }) {
  const [hubSettings, setHubSettings] = useState(null);
  const [portDraft, setPortDraft] = useState("");
  const [saveMsg, setSaveMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setHubSettings(data);
        setPortDraft(String(data.saved?.port ?? data.running?.port ?? ""));
      })
      .catch(() => setSaveMsg({ kind: "error", text: "failed to load hub settings" }));
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savePort = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const p = parseInt(portDraft, 10);
      if (isNaN(p) || p < 1 || p > 65535) {
        setSaveMsg({ kind: "error", text: "port must be 1–65535" });
        setSaving(false);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: p })
      });
      const body = await res.json();
      if (!res.ok) {
        setSaveMsg({ kind: "error", text: body.error || "save failed" });
      } else {
        setHubSettings(body);
        setSaveMsg({
          kind: "ok",
          text: body.restartRequired
            ? `saved — restart hub to run on :${p}`
            : "saved"
        });
      }
    } catch (e) {
      setSaveMsg({ kind: "error", text: String(e) });
    }
    setSaving(false);
  };

  const running = hubSettings?.running?.port;
  const saved = hubSettings?.saved?.port;

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal settings-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[SETTINGS]</span>
          <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
        </div>

        <div class="modal-body">
          <section>
            <h3>Hub (server-side)</h3>
            <div class="settings-row">
              <label>Port</label>
              <div class="settings-field">
                <input
                  type="number"
                  min="1"
                  max="65535"
                  class="text-input"
                  value=${portDraft}
                  onInput=${(e) => setPortDraft(e.currentTarget.value)}
                  placeholder="4400"
                />
                <button class="icon-btn" disabled=${saving} onClick=${savePort}>
                  ${saving ? "[SAVING…]" : "[SAVE]"}
                </button>
              </div>
              <div class="settings-hint">
                ${running ? `Running: :${running}` : ""}
                ${saved !== undefined && saved !== running ? ` · Saved: :${saved} (restart to apply)` : ""}
              </div>
              ${saveMsg
                ? html`<div class=${`settings-msg ${saveMsg.kind}`}>${saveMsg.text}</div>`
                : null}
            </div>
            <p class="muted">
              Env / flag overrides still win: <code>LLM_TRACKER_PORT=N</code> or <code>--port N</code>.
            </p>
          </section>

          <section>
            <h3>Board (client-side, this browser)</h3>
            <div class="settings-row">
              <label>Theme</label>
              <div class="settings-field">
                <button
                  class=${`icon-btn ${theme === "dark" ? "active" : ""}`}
                  onClick=${() => theme !== "dark" && onToggleTheme()}
                >[DARK]</button>
                <button
                  class=${`icon-btn ${theme === "light" ? "active" : ""}`}
                  onClick=${() => theme !== "light" && onToggleTheme()}
                >[LIGHT]</button>
              </div>
            </div>
            <div class="settings-row">
              <label>Overview drawer</label>
              <div class="settings-field">
                <button
                  class=${`icon-btn ${drawerPinned ? "active" : ""}`}
                  onClick=${onToggleDrawerPin}
                >${drawerPinned ? "[PINNED]" : "[UNPINNED]"}</button>
              </div>
              <div class="settings-hint">When pinned, the drawer persists open across sessions.</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

// ─────── History modal ───────
function summaryItemText(it) {
  switch (it?.kind) {
    case "added": return `+ ${it.id} "${it.title || ""}" (${it.status || "?"})`;
    case "removed": return `− ${it.id} removed`;
    case "status": return `${it.id} → ${it.to}`;
    case "placement": return `${it.id} moved`;
    case "assignee": return `${it.id} assignee: ${it.to ?? "—"}`;
    case "edit": return `${it.id} edited (${(it.keys || []).join(", ")})`;
    case "meta": return `meta.${it.key} updated`;
    case "reorder": return `reorder (${it.total} tasks)`;
    default: return JSON.stringify(it);
  }
}

function HistoryModal({ slug, onClose }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [rollingBack, setRollingBack] = useState(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/projects/${slug}/revisions`);
      if (!res.ok) throw new Error(res.statusText);
      const body = await res.json();
      const recent = [...(body.revisions || [])].sort((a, b) => b.rev - a.rev).slice(0, 10);
      setEntries(recent);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, [slug]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rollbackTo = async (rev) => {
    const ok = window.confirm(
      `Roll back to rev ${rev}?\n\nThe current state becomes a new rev on top of this rollback — nothing is discarded, you can undo the rollback the same way.`
    );
    if (!ok) return;
    setRollingBack(rev);
    try {
      const res = await fetch(`/api/projects/${slug}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: rev })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }
      await load();
    } catch (e) {
      alert(`Rollback failed: ${e.message}`);
    }
    setRollingBack(null);
  };

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="modal history-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[HISTORY] · ${slug}</span>
          <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
        </div>
        <div class="modal-body">
          ${error
            ? html`<div class="settings-msg error">failed to load: ${error}</div>`
            : entries === null
              ? html`<p class="muted">loading…</p>`
              : entries.length === 0
                ? html`<p class="muted">no history yet.</p>`
                : html`<ul class="history-list">
                    ${entries.map((e, idx) => {
                      const shown = (e.summary || []).slice(0, 3);
                      const rest = (e.summary || []).length - shown.length;
                      return html`
                        <li key=${e.rev} class="history-entry">
                          <div class="history-meta">
                            <span class="history-rev">rev ${e.rev}</span>
                            <span class="history-ts">${new Date(e.ts).toLocaleString()}</span>
                            ${e.rolledBackTo !== undefined
                              ? html`<span class="badge">rolled back to ${e.rolledBackTo}</span>`
                              : null}
                          </div>
                          <ul class="history-gist">
                            ${shown.length === 0
                              ? html`<li class="muted">no structured changes</li>`
                              : shown.map((it, i) => html`<li key=${i}>${summaryItemText(it)}</li>`)}
                            ${rest > 0 ? html`<li class="muted">…and ${rest} more</li>` : null}
                          </ul>
                          <div class="history-actions">
                            <button
                              class="icon-btn"
                              disabled=${idx === 0 || rollingBack !== null}
                              onClick=${() => rollbackTo(e.rev)}
                              title=${idx === 0 ? "This is the current revision" : `Roll back to rev ${e.rev}`}
                            >${rollingBack === e.rev ? "[ROLLING BACK…]" : idx === 0 ? "[CURRENT]" : "[UNDO TO HERE]"}</button>
                          </div>
                        </li>
                      `;
                    })}
                  </ul>`}
        </div>
      </div>
    </div>
  `;
}

// ─────── Overview drawer ───────
function Drawer({ open, pinned, onTogglePin, onClose, projects, activeSlug, onSelect, onDelete }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !pinned) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pinned, onClose]);

  if (!open) return null;

  const slugs = Object.keys(projects).sort();

  const drawerEl = html`
    <aside class=${`drawer ${pinned ? "pinned" : ""}`} onClick=${(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <span class="brand">[OVERVIEW] · ALL PROJECTS</span>
          <div class="drawer-header-actions">
            <button
              class=${`icon-btn ${pinned ? "active" : ""}`}
              onClick=${onTogglePin}
              title=${pinned ? "Unpin" : "Pin drawer (persists)"}
            >${pinned ? "[PINNED]" : "[PIN]"}</button>
            <button class="icon-btn" onClick=${onClose} title="Close (Esc)">×</button>
          </div>
        </div>
        <div class="drawer-body">
          ${slugs.length === 0
            ? html`<div class="drawer-empty">No projects yet.</div>`
            : slugs.map((s) => {
                const p = projects[s];
                const d = p.derived;
                const active = s === activeSlug;
                const err = p.error;
                return html`
                  <div
                    key=${s}
                    class=${`drawer-project ${active ? "active" : ""}`}
                    role="button"
                    tabIndex="0"
                    onClick=${() => onSelect(s)}
                  >
                    <div class="drawer-project-row">
                      <span class="drawer-project-name">${p.data?.meta?.name || s}</span>
                      ${err ? html`<span class="badge blocked">${err.kind}</span>` : null}
                      <span class="drawer-project-pct">${d?.pct ?? 0}%</span>
                      <button
                        class="drawer-project-delete"
                        title=${`Delete ${s}`}
                        onClick=${(e) => {
                          e.stopPropagation();
                          onDelete(s);
                        }}
                      >×</button>
                    </div>
                    <div class="drawer-project-slug">${s}</div>
                    ${d
                      ? html`
                        <${SegBar} counts=${d.counts} total=${d.total} thin />
                        <div class="drawer-project-meta">
                          <span>${d.total} TASKS</span>
                          <span class="active-count">${d.counts.in_progress || 0} ACTIVE</span>
                          <span>${d.counts.complete || 0} DONE</span>
                          ${(d.counts.not_started || 0) > 0
                            ? html`<span>${d.counts.not_started} TODO</span>`
                            : null}
                        </div>
                      `
                      : html`<div class="drawer-project-meta"><span>NOT YET LOADED</span></div>`}
                  </div>
                `;
              })}
        </div>
      </aside>
  `;

  if (pinned) return drawerEl;

  return html`
    <div class="drawer-overlay" onClick=${onClose}>${drawerEl}</div>
  `;
}

// ─────── Empty state ───────
function EmptyState({ workspace, onOpenHelp }) {
  return html`
    <div class="empty-state">
      <h2>${">"} No projects registered</h2>
      <p>
        The tracker auto-discovers projects in the trackers/ folder. Click <b>[HELP]</b> for the paste-ready prompt to give your LLM.
      </p>
      <button class="big-btn" onClick=${onOpenHelp}>[HELP · HOW TO REGISTER A PROJECT]</button>
    </div>
  `;
}

function ConnectionPip({ up }) {
  return html`
    <div class=${`connection-pip ${up ? "" : "down"}`}>
      <span class="dot"></span>
      <span>${up ? "live" : "reconnecting"}</span>
    </div>
  `;
}

// ─────── Header ───────
function Header({
  slugs,
  projects,
  activeSlug,
  setActive,
  project,
  workspace,
  filter,
  setFilter,
  theme,
  onToggleTheme,
  onOpenHelp,
  onOpenDrawer,
  onOpenSettings,
  onOpenHistory,
  onUndo,
  onDeleteProject
}) {
  const meta = project?.data?.meta;
  const labelFor = (s) => projects?.[s]?.data?.meta?.name || s;

  return html`
    <div class="app-header">
      <div>
        <div class="brand">LLM PROJECT TRACKER</div>
        <div class="project-select">
          <${Dropdown}
            value=${activeSlug}
            options=${slugs}
            onChange=${setActive}
            renderLabel=${labelFor}
            className="project-dropdown"
          />
        </div>
        <div class="project-meta">
          ${meta ? html`<span class="kv"><b>slug</b>${meta.slug}</span>` : null}
          ${meta ? html`<span class="kv"><b>swimlanes</b>${meta.swimlanes.length}</span>` : null}
          ${meta ? html`<span class="kv"><b>tasks</b>${project.data.tasks.length}</span>` : null}
          ${project?.data?.meta?.updatedAt
            ? html`<span class="kv"><b>updated</b>${new Date(project.data.meta.updatedAt).toLocaleTimeString()}</span>`
            : null}
        </div>
      </div>
      <div class="header-right">
        <div class="header-actions">
          <button
            class="icon-btn"
            onClick=${onUndo}
            disabled=${!project?.rev || project.rev < 2}
            title=${project?.rev >= 2 ? `Undo (rev ${project.rev} → ${project.rev - 1})` : "Nothing to undo"}
          >[UNDO]</button>
          <button
            class="icon-btn"
            onClick=${onOpenHistory}
            disabled=${!project?.slug}
            title="Recent revisions with rollback"
          >[HISTORY]</button>
          <button
            class="icon-btn danger"
            onClick=${() => onDeleteProject(project?.slug)}
            title="Delete this project"
          >[DELETE]</button>
          <button class="icon-btn" onClick=${onOpenDrawer} title="Project overview">[OVERVIEW]</button>
          <button class="icon-btn" onClick=${onToggleTheme} title=${`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            ${theme === "dark" ? "[☼]" : "[☾]"}
          </button>
          <button class="icon-btn" onClick=${onOpenSettings} title="Settings">[SETTINGS]</button>
          <button class="icon-btn" onClick=${onOpenHelp} title="Help">[?]</button>
        </div>
        <input
          class="filter-input"
          value=${filter}
          onInput=${(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter tasks — title, id, tag"
        />
        ${workspace ? html`<div class="workspace-path">WORKSPACE · ${workspace.workspace}</div>` : null}
      </div>
    </div>
  `;
}

// ─────── App ───────
function App() {
  const initialSettings = useMemo(() => loadSettings(), []);
  const [workspace, setWorkspace] = useState(null);
  const [projects, setProjects] = useState({});
  const [activeSlug, setActiveSlug] = useState(null);
  const [filter, setFilter] = useState("");
  const [wsUp, setWsUp] = useState(false);
  const [theme, setTheme] = useState(initialSettings.theme || "dark");
  const [drawerOpen, setDrawerOpen] = useState(!!initialSettings.drawerPinned);
  const [drawerPinned, setDrawerPinned] = useState(!!initialSettings.drawerPinned);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statusFilters, setStatusFilters] = useState(() => new Set());
  const [blockFilters, setBlockFilters] = useState(() => new Set());

  const toggleStatus = (s) =>
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const toggleBlock = (b) =>
    setBlockFilters((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });

  // Persist settings
  useEffect(() => {
    saveSettings({ theme, drawerPinned });
  }, [theme, drawerPinned]);

  // Apply theme class on root
  useEffect(() => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [theme]);

  useEffect(() => {
    fetch("/api/workspace").then((r) => r.json()).then(setWorkspace).catch(() => {});
  }, []);

  useEffect(() => {
    let ws;
    let retryTimer;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setWsUp(true);
      ws.onclose = () => {
        setWsUp(false);
        retryTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "SNAPSHOT") {
          setProjects(msg.projects || {});
          setActiveSlug((prev) => {
            if (prev && msg.projects[prev]) return prev;
            const slugs = Object.keys(msg.projects || {});
            return slugs.length > 0 ? slugs[0] : null;
          });
        } else if (msg.type === "UPDATE" || msg.type === "ERROR") {
          setProjects((prev) => ({ ...prev, [msg.slug]: msg.project }));
          setActiveSlug((prev) => prev || msg.slug);
        } else if (msg.type === "REMOVE") {
          setProjects((prev) => {
            const next = { ...prev };
            delete next[msg.slug];
            return next;
          });
        }
      };
    };
    connect();
    return () => {
      clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, []);

  const onMove = async ({ taskId, swimlaneId, priorityId, targetIndex }) => {
    if (!activeSlug) return;
    try {
      await fetch(`/api/projects/${activeSlug}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, swimlaneId, priorityId, targetIndex })
      });
    } catch (e) {
      console.error("move failed", e);
    }
  };

  const onToggleCollapse = async (swimlaneId, collapsed) => {
    if (!activeSlug) return;
    try {
      await fetch(`/api/projects/${activeSlug}/swimlane-collapse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swimlaneId, collapsed })
      });
    } catch (e) {
      console.error("collapse toggle failed", e);
    }
  };

  const onSelectProject = (slug) => {
    setActiveSlug(slug);
    if (!drawerPinned) setDrawerOpen(false);
  };

  const onToggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const onTogglePin = () => setDrawerPinned((p) => !p);

  const slugs = Object.keys(projects).sort();
  const active = activeSlug ? projects[activeSlug] : null;

  const onDeleteTask = async (task) => {
    if (!activeSlug) return;
    const ok = window.confirm(
      `Delete task "${task.title}" (${task.id})?\n\nThis bumps the project rev. Use [UNDO] to revert.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${activeSlug}/tasks/${task.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Delete failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onDeleteProject = async (slug) => {
    if (!slug) return;
    const entry = projects[slug];
    const name = entry?.data?.meta?.name || slug;
    const ok = window.confirm(
      `Delete project "${name}" (${slug})?\n\nThe tracker file will be removed. Snapshots and history are preserved in .snapshots/ and .history/.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Delete failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const onUndo = async () => {
    if (!active || !active.rev || active.rev < 2) return;
    const targetRev = active.rev - 1;
    const ok = window.confirm(
      `Undo last change?\n\nRolls rev ${active.rev} back to the state at rev ${targetRev}.\nNo redo — you can undo again to go further back.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${activeSlug}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: targetRev })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Undo failed: ${body.error || res.statusText}`);
      }
    } catch (e) {
      alert(`Undo failed: ${e.message}`);
    }
  };

  const drawerEl = html`
    <${Drawer}
      open=${drawerOpen}
      pinned=${drawerPinned}
      onTogglePin=${onTogglePin}
      onClose=${() => setDrawerOpen(false)}
      projects=${projects}
      activeSlug=${activeSlug}
      onSelect=${onSelectProject}
      onDelete=${onDeleteProject}
    />
  `;
  const helpEl = helpOpen ? html`<${HelpModal} workspace=${workspace} onClose=${() => setHelpOpen(false)} />` : null;
  const historyEl = historyOpen && activeSlug
    ? html`<${HistoryModal} slug=${activeSlug} onClose=${() => setHistoryOpen(false)} />`
    : null;

  const shellPinned = drawerOpen && drawerPinned;
  const shellClass = `app-shell ${shellPinned ? "drawer-pinned" : ""}`;
  const settingsEl = settingsOpen
    ? html`<${SettingsModal}
        onClose=${() => setSettingsOpen(false)}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        drawerPinned=${drawerPinned}
        onToggleDrawerPin=${onTogglePin}
      />`
    : null;

  if (slugs.length === 0) {
    return html`
      <div class=${shellClass}>
        <div class="app-header">
          <div>
            <div class="brand">LLM PROJECT TRACKER</div>
            <div class="project-title-placeholder">AWAITING PROJECTS</div>
          </div>
          <div class="header-right">
            <div class="header-actions">
              <button class="icon-btn" onClick=${onToggleTheme}>
                ${theme === "dark" ? "[☼]" : "[☾]"}
              </button>
              <button class="icon-btn" onClick=${() => setSettingsOpen(true)}>[SETTINGS]</button>
              <button class="icon-btn" onClick=${() => setHelpOpen(true)}>[?]</button>
            </div>
          </div>
        </div>
        <${EmptyState} workspace=${workspace} onOpenHelp=${() => setHelpOpen(true)} />
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
      </div>
    `;
  }

  if (!active || !active.data) {
    const err = active?.error;
    return html`
      <div class=${shellClass}>
        <${Header}
          slugs=${slugs}
          projects=${projects}
          activeSlug=${activeSlug}
          setActive=${setActiveSlug}
          project=${active}
          workspace=${workspace}
          filter=${filter}
          setFilter=${setFilter}
          theme=${theme}
          onToggleTheme=${onToggleTheme}
          onOpenHelp=${() => setHelpOpen(true)}
          onOpenDrawer=${() => setDrawerOpen(true)}
          onOpenSettings=${() => setSettingsOpen(true)}
          onOpenHistory=${() => setHistoryOpen(true)}
          onUndo=${onUndo}
          onDeleteProject=${onDeleteProject}
        />
        ${err ? html`<div class="error-banner"><b>${err.kind} error</b> — ${err.message}</div>` : null}
        <div class="empty-state"><p>Project file is not yet valid. Fix it and save.</p></div>
        <${ConnectionPip} up=${wsUp} />
        ${drawerEl}
        ${helpEl}
        ${settingsEl}
        ${historyEl}
      </div>
    `;
  }

  const meta = active.data.meta;
  const derived = active.derived;

  return html`
    <div class=${shellClass}>
      <${Header}
        slugs=${slugs}
        projects=${projects}
        activeSlug=${activeSlug}
        setActive=${setActiveSlug}
        project=${active}
        workspace=${workspace}
        filter=${filter}
        setFilter=${setFilter}
        theme=${theme}
        onToggleTheme=${onToggleTheme}
        onOpenHelp=${() => setHelpOpen(true)}
        onOpenDrawer=${() => setDrawerOpen(true)}
        onOpenSettings=${() => setSettingsOpen(true)}
        onOpenHistory=${() => setHistoryOpen(true)}
        onUndo=${onUndo}
        onDeleteProject=${onDeleteProject}
      />
      <div class="banner-row">
        ${meta.scratchpad
          ? html`<div class="scratchpad"><span class="scratchpad-label">scratchpad</span><span>${meta.scratchpad}</span></div>`
          : html`<div class="banner-spacer"></div>`}
        <${FilterToggles}
          counts=${derived.counts}
          statusFilters=${statusFilters}
          toggleStatus=${toggleStatus}
          blockedCount=${Object.keys(derived.blocked || {}).length}
          openCount=${derived.total - Object.keys(derived.blocked || {}).length}
          blockFilters=${blockFilters}
          toggleBlock=${toggleBlock}
        />
      </div>
      ${active.error
        ? html`<div class="error-banner"><b>${active.error.kind} error</b> — last valid state shown; ${active.error.message}</div>`
        : null}
      <div class="progress-strip">
        <span class="progress-label">project</span>
        <${SegBar} counts=${derived.counts} total=${derived.total} />
        <span class="progress-count">
          ${derived.counts.complete || 0} / ${derived.total}
          <span class="pct">${derived.pct}%</span>
        </span>
      </div>
      <${Matrix}
        project=${active}
        filterQuery=${filter}
        statusFilters=${statusFilters}
        blockFilters=${blockFilters}
        onMove=${onMove}
        onToggleCollapse=${onToggleCollapse}
        onDeleteTask=${onDeleteTask}
      />
      <${ConnectionPip} up=${wsUp} />
      ${drawerEl}
      ${helpEl}
      ${settingsEl}
      ${historyEl}
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
