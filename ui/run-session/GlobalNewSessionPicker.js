import { html } from "htm/preact";

export const GLOBAL_NEW_SESSION_OPTIONS = Object.freeze([
  { id: "pick_task", label: "Pick task", mode: "task_backed" },
  { id: "start_untasked", label: "Start untasked", mode: "untasked" },
  { id: "attach_existing", label: "Attach existing", mode: "attach_existing" },
]);

function clampIndex(index) {
  if (!Number.isInteger(index)) return 0;
  return Math.max(0, Math.min(GLOBAL_NEW_SESSION_OPTIONS.length - 1, index));
}

export function buildGlobalNewSessionIntent(optionId) {
  const option = GLOBAL_NEW_SESSION_OPTIONS.find((item) => item.id === optionId) || GLOBAL_NEW_SESSION_OPTIONS[0];
  return {
    source: "global_new_session",
    mode: option.mode,
    optionId: option.id,
  };
}

export function nextGlobalNewSessionIndex(currentIndex, key) {
  const current = clampIndex(currentIndex);
  if (key === "1") return 0;
  if (key === "2") return 1;
  if (key === "3") return 2;
  if (key === "ArrowDown" || key === "ArrowRight") return (current + 1) % GLOBAL_NEW_SESSION_OPTIONS.length;
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return (current + GLOBAL_NEW_SESSION_OPTIONS.length - 1) % GLOBAL_NEW_SESSION_OPTIONS.length;
  }
  return current;
}

export function GlobalNewSessionPicker({
  selectedIndex = 0,
  onSelectIndex,
  onOpenWizard,
  onClose,
} = {}) {
  const activeIndex = clampIndex(selectedIndex);
  const openOption = (option) => {
    if (typeof onOpenWizard === "function") onOpenWizard(buildGlobalNewSessionIntent(option.id));
  };
  const handleKeyDown = (event) => {
    const key = event?.key;
    if (key === "Enter") {
      event?.preventDefault?.();
      openOption(GLOBAL_NEW_SESSION_OPTIONS[activeIndex]);
      return;
    }
    if (key === "Escape") {
      event?.preventDefault?.();
      if (typeof onClose === "function") onClose();
      return;
    }
    const nextIndex = nextGlobalNewSessionIndex(activeIndex, key);
    if (nextIndex !== activeIndex) {
      event?.preventDefault?.();
      if (typeof onSelectIndex === "function") onSelectIndex(nextIndex);
    }
  };

  return html`
    <div
      class="global-new-session-picker"
      role="menu"
      aria-label="New session"
      tabindex="0"
      onKeyDown=${handleKeyDown}
    >
      ${GLOBAL_NEW_SESSION_OPTIONS.map((option, index) => html`
        <button
          key=${option.id}
          class=${`global-new-session-picker__option ${index === activeIndex ? "global-new-session-picker__option--active" : ""}`}
          type="button"
          role="menuitem"
          aria-current=${index === activeIndex ? "true" : "false"}
          data-option-id=${option.id}
          data-mode=${option.mode}
          onMouseEnter=${() => {
            if (typeof onSelectIndex === "function") onSelectIndex(index);
          }}
          onClick=${() => openOption(option)}
        >
          <span class="global-new-session-picker__shortcut">${index + 1}</span>
          <span class="global-new-session-picker__label">${option.label}</span>
        </button>
      `)}
    </div>
  `;
}
