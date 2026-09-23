import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

export const STDIO_VISIBLE_RENDER_MS = 34;
export const STDIO_OFFSCREEN_RENDER_MS = 200;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedStream(value) {
  return value === "stderr" ? "stderr" : "stdout";
}

function entryText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function pushEntry(out, item, index, stream, text) {
  const value = entryText(text);
  if (value.length === 0) return;
  const baseId = nonEmptyString(item?.id) || nonEmptyString(item?.eventId);
  const normalized = normalizedStream(stream);
  out.push({
    id: baseId ? `${baseId}:${normalized}:${out.length}` : `stdio-${index}-${out.length}`,
    eventId: baseId || null,
    ts: nonEmptyString(item?.ts) || nonEmptyString(item?.timestamp) || nonEmptyString(item?.time) || null,
    stream: normalized,
    text: value,
  });
}

function arrayFromSource(source) {
  if (Array.isArray(source)) return source;
  if (!isRecord(source)) return [];
  for (const key of ["stdioEntries", "stdioBuffer", "output", "outputs", "runtimeEvents", "events", "chunks"]) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}

export function normalizeStdioEntries(source) {
  const out = [];
  const items = arrayFromSource(source);
  items.forEach((item, index) => {
    if (typeof item === "string") {
      pushEntry(out, null, index, "stdout", item);
      return;
    }
    if (!isRecord(item)) return;
    if (typeof item.stdout === "string") pushEntry(out, item, index, "stdout", item.stdout);
    if (typeof item.stderr === "string") pushEntry(out, item, index, "stderr", item.stderr);
    if (typeof item.text === "string" || typeof item.chunk === "string" || typeof item.data === "string") {
      pushEntry(out, item, index, item.stream || item.channel, item.text ?? item.chunk ?? item.data);
    }
  });
  return out;
}

export function filterStdioEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!needle) return list;
  return list.filter((entry) => {
    const text = typeof entry?.text === "string" ? entry.text.toLowerCase() : "";
    const stream = typeof entry?.stream === "string" ? entry.stream.toLowerCase() : "";
    return text.includes(needle) || stream.includes(needle);
  });
}

export function stdioRenderThrottleMs({ visible = true } = {}) {
  return visible === false ? STDIO_OFFSCREEN_RENDER_MS : STDIO_VISIBLE_RENDER_MS;
}

export function stdioCopyText(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => entryText(entry?.text))
    .filter((text) => text.length > 0)
    .join("");
}

function defaultCopyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) return globalThis.navigator.clipboard.writeText(text);
  return Promise.resolve(text);
}

function StdioRows({ entries }) {
  if (!entries.length) {
    return html`<div class="stdio-panel__empty">No output</div>`;
  }
  return html`
    ${entries.map((entry) => html`
      <div
        key=${entry.id}
        class=${`stdio-panel__row stdio-panel__row--${entry.stream}`}
        data-stream=${entry.stream}
      >
        <span class="stdio-panel__stream">${entry.stream}</span>
        <pre class="stdio-panel__text">${entry.text}</pre>
      </div>
    `)}
  `;
}

export function StdioPanelView({
  entries = [],
  visible = true,
  paused = false,
  follow = true,
  query = "",
  copied = false,
  viewportRef = null,
  onTogglePause,
  onToggleFollow,
  onSearch,
  onCopy,
} = {}) {
  const normalized = normalizeStdioEntries(entries);
  const filtered = filterStdioEntries(normalized, query);
  const copyText = stdioCopyText(filtered);
  const throttleMs = stdioRenderThrottleMs({ visible });

  return html`
    <section
      class="stdio-panel"
      role="region"
      aria-label="Session stdio"
      data-render-throttle-ms=${throttleMs}
      data-follow=${follow ? "true" : "false"}
      data-paused=${paused ? "true" : "false"}
    >
      <div class="stdio-panel__toolbar">
        <button
          class=${`stdio-panel__toggle ${follow ? "stdio-panel__toggle--active" : ""}`}
          type="button"
          aria-pressed=${follow ? "true" : "false"}
          onClick=${() => {
            if (typeof onToggleFollow === "function") onToggleFollow(!follow);
          }}
        >
          Follow
        </button>
        <button
          class=${`stdio-panel__toggle ${paused ? "stdio-panel__toggle--active" : ""}`}
          type="button"
          aria-pressed=${paused ? "true" : "false"}
          onClick=${() => {
            if (typeof onTogglePause === "function") onTogglePause(!paused);
          }}
        >
          Pause
        </button>
        <input
          class="stdio-panel__search"
          type="search"
          value=${query}
          placeholder="Search"
          aria-label="Search stdio"
          onInput=${(event) => {
            if (typeof onSearch === "function") onSearch(event?.currentTarget?.value || "");
          }}
        />
        <button
          class="stdio-panel__copy"
          type="button"
          disabled=${copyText.length === 0}
          onClick=${() => {
            if (typeof onCopy === "function") onCopy(copyText);
          }}
        >
          ${copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div ref=${viewportRef} class="stdio-panel__viewport" data-follow-anchor=${follow ? "bottom" : "manual"}>
        <${StdioRows} entries=${filtered} />
      </div>
    </section>
  `;
}

export function StdioPanel({
  entries = [],
  visible = true,
  copyText = defaultCopyText,
} = {}) {
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [renderedEntries, setRenderedEntries] = useState(() => normalizeStdioEntries(entries));
  const latestEntries = useMemo(() => normalizeStdioEntries(entries), [entries]);
  const viewportRef = useRef(null);

  useEffect(() => {
    if (paused) return undefined;
    const delay = stdioRenderThrottleMs({ visible });
    const timer = setTimeout(() => setRenderedEntries(latestEntries), delay);
    return () => clearTimeout(timer);
  }, [latestEntries, paused, visible]);

  useEffect(() => {
    if (!follow || paused || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [renderedEntries, follow, paused]);

  return html`
    <div>
      <${StdioPanelView}
        entries=${renderedEntries}
        visible=${visible}
        follow=${follow}
        paused=${paused}
        query=${query}
        copied=${copied}
        viewportRef=${viewportRef}
        onToggleFollow=${setFollow}
        onTogglePause=${setPaused}
        onSearch=${setQuery}
        onCopy=${async (text) => {
          await copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      />
    </div>
  `;
}
