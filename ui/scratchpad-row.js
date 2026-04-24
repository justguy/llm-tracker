import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "htm/preact";
import { Bracket } from "./primitives.js";

export function relativeTime(iso) {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ScratchpadRow({ slug, text, updatedAt, expanded, onToggleExpand, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  const startEdit = (e) => {
    e?.stopPropagation();
    setDraft(text || "");
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };
  const commit = async () => {
    if (saving || draft.length > 5000) return;
    setSaving(true);
    const ok = await onSave(slug, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const stamp = relativeTime(updatedAt);
  const rowClass = [
    "scratchpad-row",
    expanded ? "scratchpad-row--expanded" : "",
    editing ? "scratchpad-row--editing" : "",
  ].filter(Boolean).join(" ");

  return html`
    <div class=${rowClass} onClick=${(e) => e.stopPropagation()} onMouseDown=${(e) => e.stopPropagation()}>
      <span class="scratchpad-row__label">NOTE</span>
      ${editing
        ? html`<textarea
            ref=${textareaRef}
            class="scratchpad-row__textarea"
            maxlength="5000"
            placeholder="plain text — ≤ 5000 chars"
            value=${draft}
            onInput=${(e) => setDraft(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
            }}
          />`
        : html`<span class="scratchpad-row__text">${text || html`<em style="color:var(--ink-3);font-style:normal">(empty)</em>`}</span>`
      }
      ${stamp && !editing ? html`<span class="scratchpad-row__stamp">${stamp}</span>` : null}
      <${Bracket}
        label=${editing ? "CANCEL" : expanded ? "COLLAPSE" : "EXPAND"}
        soft
        onClick=${editing ? cancelEdit : () => onToggleExpand(slug)}
        disabled=${saving}
      />
      <${Bracket}
        label=${saving ? "SAVING…" : editing ? "SAVE" : "EDIT"}
        soft
        onClick=${editing ? commit : startEdit}
        disabled=${saving || (editing && draft.length > 5000)}
      />
    </div>
  `;
}
