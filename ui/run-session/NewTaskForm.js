import { html } from "htm/preact";

function text(value) {
  return typeof value === "string" ? value : "";
}

function nonEmpty(value) {
  const s = text(value).trim();
  return s.length > 0 ? s : null;
}

export function parseDefinitionOfDone(value) {
  if (Array.isArray(value)) return value.map(text).map((item) => item.trim()).filter(Boolean);
  return text(value)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildNewTaskFormDraft(input = {}) {
  const form = {
    title: text(input.title),
    projectSlug: text(input.projectSlug),
  };
  const lane = nonEmpty(input.lane);
  if (lane) form.lane = lane;
  const priority = nonEmpty(input.priority);
  if (priority) form.priority = priority;
  const dod = parseDefinitionOfDone(input.dod);
  if (dod.length > 0) form.dod = dod;
  return form;
}

export function newTaskFormReady(form = {}) {
  return Boolean(nonEmpty(form.title) && nonEmpty(form.projectSlug));
}

export function NewTaskForm({
  form = {},
  disabled = false,
  onChange,
  onCancel,
} = {}) {
  const dodText = Array.isArray(form.dod) ? form.dod.join("\n") : text(form.dod);
  const update = (patch) => onChange?.(buildNewTaskFormDraft({ ...form, ...patch }));

  return html`
    <div class="run-session-new-task" role="group" aria-label="New task">
      <label>
        <span>Title</span>
        <input
          class="text-input"
          value=${text(form.title)}
          disabled=${disabled}
          onInput=${(event) => update({ title: event.currentTarget.value })}
        />
      </label>
      <label>
        <span>Project</span>
        <input
          class="text-input"
          value=${text(form.projectSlug)}
          disabled=${disabled}
          onInput=${(event) => update({ projectSlug: event.currentTarget.value })}
        />
      </label>
      <div class="run-session-new-task__row">
        <label>
          <span>Lane</span>
          <input
            class="text-input"
            value=${text(form.lane)}
            disabled=${disabled}
            onInput=${(event) => update({ lane: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>Priority</span>
          <input
            class="text-input"
            value=${text(form.priority)}
            disabled=${disabled}
            onInput=${(event) => update({ priority: event.currentTarget.value })}
          />
        </label>
      </div>
      <label>
        <span>DoD</span>
        <textarea
          class="text-input"
          rows="3"
          value=${dodText}
          disabled=${disabled}
          onInput=${(event) => update({ dod: event.currentTarget.value })}
        />
      </label>
      <button
        class="icon-btn"
        type="button"
        disabled=${disabled}
        onClick=${onCancel}
      >
        [CANCEL]
      </button>
    </div>
  `;
}
