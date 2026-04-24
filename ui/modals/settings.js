import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { parsePortDraft } from "../app-logic.js";

export function SettingsModal({ onClose, theme, onToggleTheme, drawerPinned, onToggleDrawerPin }) {
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
      const p = parsePortDraft(portDraft);
      if (p == null) {
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
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="brand">[SETTINGS]</span>
          <button class="icon-btn" aria-label="Close dialog" onClick=${onClose} title="Close (Esc)">×</button>
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
