import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { GlobalNewSessionPicker } from "../run-session/GlobalNewSessionPicker.js";

export function HubTopBarView({
  pickerOpen = false,
  selectedIndex = 0,
  sessionCount = 0,
  activeProjectName = "workspace",
  connected = false,
  onTogglePicker,
  onSelectPickerIndex,
  onOpenWizard,
  onAttach,
  onClosePicker,
} = {}) {
  return html`
    <header class="hub-top-bar">
      <div class="hub-top-bar__identity">
        <span class="hub-top-bar__eyebrow">WORKSPACE</span>
        <div class="hub-top-bar__title">Session Hub</div>
      </div>
      <div class="hub-top-bar__meta">
        <span>${activeProjectName}</span>
        <span>${sessionCount} sessions</span>
        <span data-connected=${connected ? "true" : "false"}>${connected ? "runtime online" : "runtime offline"}</span>
      </div>
      <div class="hub-top-bar__actions">
        <button
          class="hub-top-bar__new-session"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${pickerOpen ? "true" : "false"}
          onClick=${onTogglePicker}
        >
          [+ NEW SESSION]
        </button>
        <button class="hub-top-bar__attach" type="button" onClick=${onAttach}>[+ ATTACH]</button>
        <button class="hub-top-bar__broadcast" type="button" disabled title="Broadcast requires a selected multi-session target">[BROADCAST]</button>
        ${pickerOpen
          ? html`
              <div class="hub-top-bar__picker">
                <${GlobalNewSessionPicker}
                  selectedIndex=${selectedIndex}
                  onSelectIndex=${onSelectPickerIndex}
                  onOpenWizard=${onOpenWizard}
                  onClose=${onClosePicker}
                />
              </div>
            `
          : null}
      </div>
    </header>
  `;
}

export function HubTopBar({ sessionCount = 0, activeProjectName, connected = false, onOpenWizard, onAttach } = {}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const openWizard = (intent) => {
    setPickerOpen(false);
    if (typeof onOpenWizard === "function") onOpenWizard(intent);
  };
  return html`
    <${HubTopBarView}
      pickerOpen=${pickerOpen}
      selectedIndex=${selectedIndex}
      sessionCount=${sessionCount}
      activeProjectName=${activeProjectName}
      connected=${connected}
      onTogglePicker=${() => setPickerOpen((open) => !open)}
      onSelectPickerIndex=${setSelectedIndex}
      onOpenWizard=${openWizard}
      onAttach=${onAttach}
      onClosePicker=${() => setPickerOpen(false)}
    />
  `;
}
