import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";

const MODE_LABELS = { command: "COMMAND", fuzzy: "FUZZY", semantic: "SEMANTIC" };

function inferMode(query) {
  if (!query) return "command";
  if (query.startsWith(">")) return "command";
  if (query.startsWith("~")) return "fuzzy";
  if (query.startsWith("?")) return "semantic";
  return "command";
}

function stripPrefix(query) {
  if (!query) return query;
  if (query.startsWith(">") || query.startsWith("~") || query.startsWith("?")) return query.slice(1).trimStart();
  return query;
}

function matchesFilter(text, q) {
  return text.toLowerCase().includes(q.toLowerCase());
}

function ProjectRow({ proj, slug, active }) {
  const meta = proj?.data?.meta;
  const name = meta?.name || slug;
  const derived = proj?.derived;
  const pct = derived?.pct ?? 0;
  const rev = proj?.rev ?? null;
  return html`
    <span class="palette-row__icon">◧</span>
    <span class="palette-row__main">
      <span class="palette-row__label">${name}</span>
      ${active ? html`<span class="palette-row__sub"> · active</span>` : null}
    </span>
    <span class="palette-row__hint">${rev != null ? `r${rev}` : ""} ${pct}%</span>
  `;
}

function TaskRow({ item }) {
  const icon = item.status === "complete" ? "◉" : "·";
  return html`
    <span class="palette-row__icon">${icon}</span>
    <span class="palette-row__main">
      <span class="palette-row__label">${item.title}</span>
      <span class="palette-row__sub">${item.id}${item.swimlaneId ? ` · ${item.swimlaneId}` : ""}${item.priorityId ? ` · ${item.priorityId}` : ""}</span>
    </span>
    <span class="palette-row__hint">${item.status || ""}</span>
  `;
}

function ActionRow({ action }) {
  return html`
    <span class="palette-row__icon">${action.icon || "→"}</span>
    <span class="palette-row__main">
      <span class="palette-row__label">${action.label}</span>
    </span>
    ${action.hint ? html`<span class="palette-row__hint">${action.hint}</span>` : null}
  `;
}

export function CommandPalette({ open, onClose, projects, activeSlug, actions, onOpenTaskDrawer, setActive, onToggleCollapse }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [taskResults, setTaskResults] = useState([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const fetchRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setTaskResults([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const mode = inferMode(query);
  const bare = stripPrefix(query);

  useEffect(() => {
    if (!open || (mode !== "fuzzy" && mode !== "semantic") || bare.length < 2 || !activeSlug) {
      setTaskResults([]);
      setTaskLoading(false);
      if (fetchRef.current) { fetchRef.current.abort(); fetchRef.current = null; }
      return;
    }

    if (fetchRef.current) fetchRef.current.abort();
    const ctrl = new AbortController();
    fetchRef.current = ctrl;

    const endpoint = mode === "semantic"
      ? `/api/projects/${activeSlug}/search?q=${encodeURIComponent(bare)}&limit=10`
      : `/api/projects/${activeSlug}/fuzzy-search?q=${encodeURIComponent(bare)}&limit=10`;

    setTaskLoading(true);
    const timer = setTimeout(() => {
      fetch(endpoint, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((body) => {
          if (!ctrl.signal.aborted) {
            setTaskResults(body.matches || []);
            setTaskLoading(false);
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) { setTaskResults([]); setTaskLoading(false); }
        });
    }, 200);

    return () => { clearTimeout(timer); ctrl.abort(); fetchRef.current = null; };
  }, [open, mode, bare, activeSlug]);

  const slugs = Object.keys(projects || {}).sort();

  const projectRows = (() => {
    const filterQ = bare || "";
    return slugs
      .filter((s) => !filterQ || matchesFilter(projects[s]?.data?.meta?.name || s, filterQ) || matchesFilter(s, filterQ))
      .map((s) => ({ kind: "project", key: `proj:${s}`, slug: s }));
  })();

  const actionRows = (() => {
    const filterQ = bare || "";
    return (actions || [])
      .filter((a) => !filterQ || matchesFilter(a.label, filterQ))
      .map((a) => ({ kind: "action", key: `act:${a.label}`, action: a }));
  })();

  const taskRows = taskResults.map((t) => ({ kind: "task", key: `task:${t.id}`, item: t }));

  let rows;
  if (mode === "fuzzy" || mode === "semantic") {
    rows = taskLoading
      ? [{ kind: "info", key: "loading", label: `${mode === "semantic" ? "SEMANTIC" : "FUZZY"} · searching…` }]
      : taskRows.length > 0
        ? taskRows
        : bare.length >= 2
          ? [{ kind: "info", key: "empty", label: "No results" }]
          : [{ kind: "info", key: "hint", label: `Type ≥ 2 chars to search ${mode === "semantic" ? "semantically" : "with fuzzy match"}` }];
  } else {
    rows = [...projectRows, ...actionRows];
  }

  const clampedCursor = rows.length > 0 ? Math.min(cursor, rows.length - 1) : 0;

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[clampedCursor];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [clampedCursor]);

  const runRow = (row) => {
    if (!row) return;
    if (row.kind === "project") {
      setActive(row.slug);
      onClose();
    } else if (row.kind === "task") {
      const slug = activeSlug;
      const taskId = row.item.id;
      const swimlaneId = row.item.swimlaneId;
      if (slug && swimlaneId && onToggleCollapse) {
        onToggleCollapse(slug, swimlaneId, false);
      }
      if (onOpenTaskDrawer) onOpenTaskDrawer(slug, taskId, "brief");
      onClose();
    } else if (row.kind === "action") {
      row.action.run?.();
      onClose();
    }
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selectableRow = rows.find((r, i) => i === clampedCursor && r.kind !== "info");
      runRow(selectableRow);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return html`
    <div
      class="palette-backdrop"
      onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="palette-panel" role="dialog" aria-label="Command palette" aria-modal="true">
        <div class="palette-mode">${MODE_LABELS[mode] || "COMMAND"}</div>
        <input
          ref=${inputRef}
          class="palette-input"
          type="text"
          placeholder="Filter · search · run command"
          value=${query}
          onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${onKey}
          autocomplete="off"
          spellcheck="false"
        />
        <div class="palette-divider"></div>
        <div class="palette-results" ref=${listRef}>
          ${rows.map((row, i) => {
            const isActive = i === clampedCursor && row.kind !== "info";
            if (row.kind === "info") {
              return html`<div key=${row.key} class="palette-row palette-row--info">${row.label}</div>`;
            }
            return html`
              <div
                key=${row.key}
                class=${`palette-row ${isActive ? "palette-row--active" : ""}`}
                onMouseEnter=${() => setCursor(i)}
                onMouseDown=${(e) => { e.preventDefault(); runRow(row); }}
              >
                ${row.kind === "project"
                  ? html`<${ProjectRow} proj=${projects[row.slug]} slug=${row.slug} active=${row.slug === activeSlug} />`
                  : row.kind === "task"
                    ? html`<${TaskRow} item=${row.item} />`
                    : html`<${ActionRow} action=${row.action} />`}
              </div>
            `;
          })}
        </div>
        <div class="palette-footer">↑↓ navigate · ↵ run · esc close · ~ fuzzy · ? semantic</div>
      </div>
    </div>
  `;
}
