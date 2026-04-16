import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { historyActionText } from "../lib/intelligence.js";

function summaryItemText(it) {
  switch (it?.kind) {
    case "added": return `+ ${it.id} "${it.title || ""}" (${it.status || "?"})`;
    case "removed": return `- ${it.id} removed`;
    case "status": return `${it.id} -> ${it.to}`;
    case "placement": return `${it.id} moved`;
    case "assignee": return `${it.id} assignee: ${it.to ?? "-"}`;
    case "edit": return `${it.id} edited (${(it.keys || []).join(", ")})`;
    case "meta": return `meta.${it.key} updated`;
    case "reorder": return `reorder (${it.total} tasks)`;
    default: return JSON.stringify(it);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function HistoryModal({ slug, onClose }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [rollingBack, setRollingBack] = useState(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/projects/${slug}/history?limit=20`);
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error || res.statusText);
      const events = [...(body.events || [])].sort((a, b) => (b.rev ?? -1) - (a.rev ?? -1));
      setHistory({ ...body, events });
      setError(null);
    } catch (err) {
      setError(err.message);
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
      `Roll back to rev ${rev}?\n\nThe current state becomes a new rev on top of this rollback.`
    );
    if (!ok) return;
    setRollingBack(rev);
    try {
      const res = await fetch(`/api/projects/${slug}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: rev })
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error || res.statusText);
      await load();
    } catch (err) {
      alert(`Rollback failed: ${err.message}`);
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
            : history === null
              ? html`<p class="muted">loading…</p>`
              : history.events.length === 0
                ? html`<p class="muted">no history yet.</p>`
                : html`<ul class="history-list">
                    ${history.events.map((entry, idx) => {
                      const shown = (entry.summary || []).slice(0, 3);
                      const rest = (entry.summary || []).length - shown.length;
                      const isCurrent = entry.rev === history.currentRev;
                      return html`
                        <li key=${entry.rev} class="history-entry">
                          <div class="history-meta">
                            <span class="history-rev">rev ${entry.rev}</span>
                            <span class="history-ts">${new Date(entry.ts).toLocaleString()}</span>
                            <span class="badge">${historyActionText(entry)}</span>
                            ${Number.isInteger(entry.rolledBackTo)
                              ? html`<span class="badge blocked">from ${entry.rolledBackFrom ?? "?"}</span>`
                              : null}
                          </div>
                          <ul class="history-gist">
                            ${shown.length === 0
                              ? html`<li class="muted">no structured changes</li>`
                              : shown.map((item, itemIndex) => html`<li key=${itemIndex}>${summaryItemText(item)}</li>`)}
                            ${rest > 0 ? html`<li class="muted">...and ${rest} more</li>` : null}
                          </ul>
                          <div class="history-actions">
                            <button
                              class="icon-btn"
                              disabled=${isCurrent || rollingBack !== null}
                              onClick=${() => rollbackTo(entry.rev)}
                              title=${isCurrent ? "This is the current revision" : `Roll back to rev ${entry.rev}`}
                            >${rollingBack === entry.rev ? "[ROLLING BACK...]" : isCurrent ? "[CURRENT]" : "[ROLL BACK]"}</button>
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
