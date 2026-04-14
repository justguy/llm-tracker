import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateProject } from "./validator.js";
import { deriveProject } from "./progress.js";

// ANSI ─────────────────────────────────────────────────────────────
const CAN_COLOR_DEFAULT =
  process.stdout && process.stdout.isTTY && !process.env.NO_COLOR;

const AMBER = "38;5;214";
const GREEN = "38;5;42";
const RED = "38;5;203";
const GRAY = "38;5;245";
const MUTED = "38;5;240";
const BOLD = "1";

function c(code, s, on) {
  return on ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}
function padr(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(-n) : " ".repeat(n - str.length) + str;
}

// Data ─────────────────────────────────────────────────────────────
export function loadProjects(workspace) {
  const dir = join(workspace, "trackers");
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".errors.json"))
    .sort()
    .map((f) => {
      const slug = f.slice(0, -5);
      const path = join(dir, f);
      try {
        const raw = readFileSync(path, "utf-8");
        const data = JSON.parse(raw);
        const v = validateProject(data);
        if (!v.ok) return { slug, ok: false, error: v.errors.join("; "), path };
        return { slug, ok: true, data, derived: deriveProject(data), path };
      } catch (e) {
        return { slug, ok: false, error: `parse: ${e.message}`, path };
      }
    });
}

// Renderers ────────────────────────────────────────────────────────
function segBar(counts, total, width, useColor) {
  if (total === 0) return c(MUTED, "░".repeat(width), useColor);
  const comp = Math.min(width, Math.round((counts.complete || 0) / total * width));
  const prog = Math.min(width - comp, Math.round((counts.in_progress || 0) / total * width));
  const notS = Math.min(width - comp - prog, Math.round((counts.not_started || 0) / total * width));
  const def = Math.max(0, width - comp - prog - notS);
  return (
    c(GREEN, "█".repeat(comp), useColor) +
    c(AMBER, "█".repeat(prog), useColor) +
    c(GRAY, "█".repeat(notS), useColor) +
    c(MUTED, "░".repeat(def), useColor)
  );
}

export function renderDashboard(projects, workspace, { useColor = CAN_COLOR_DEFAULT } = {}) {
  const W = 22;
  const LINE = c(MUTED, "─".repeat(84), useColor);
  const lines = [];
  lines.push("");
  lines.push(`  ${c(AMBER, "WORKSPACE", useColor)}  ${workspace}`);
  lines.push(`  ${LINE}`);
  lines.push(
    `  ${c(AMBER, pad("SLUG", 14), useColor)} ${c(AMBER, pad("NAME", 28), useColor)} ${c(AMBER, padr("TASKS", 6), useColor)}  ${c(AMBER, pad("PROGRESS", W), useColor)}  ${c(AMBER, padr("PCT", 5), useColor)}`
  );
  lines.push(`  ${LINE}`);

  let tot = 0, active = 0, done = 0, blocked = 0, valid = 0;
  for (const p of projects) {
    if (!p.ok) {
      lines.push(`  ${c(BOLD, pad(p.slug, 14), useColor)} ${c(RED, "[ERROR]", useColor)} ${p.error}`);
      continue;
    }
    valid++;
    tot += p.derived.total;
    active += p.derived.counts.in_progress || 0;
    done += p.derived.counts.complete || 0;
    blocked += Object.keys(p.derived.blocked || {}).length;
    const name = pad(p.data.meta.name || "", 28);
    const tasks = padr(p.derived.total, 6);
    const pctStr = padr(p.derived.pct + "%", 5);
    lines.push(
      `  ${c(BOLD, pad(p.slug, 14), useColor)} ${name} ${tasks}  ${segBar(p.derived.counts, p.derived.total, W, useColor)}  ${c(GREEN, pctStr, useColor)}`
    );
  }
  lines.push(`  ${LINE}`);
  lines.push(
    `  ${c(AMBER, "TOTAL", useColor)}  ${valid} projects · ${tot} tasks · ${c(AMBER, active + " active", useColor)} · ${c(RED, blocked + " blocked", useColor)} · ${c(GREEN, done + " complete", useColor)}`
  );
  lines.push("");
  return lines.join("\n");
}

export function renderProject(project, { useColor = CAN_COLOR_DEFAULT } = {}) {
  if (!project.ok) return `${c(RED, "[ERROR]", useColor)} ${project.slug}: ${project.error}\n`;
  const { data, derived, slug, path } = project;
  const LINE = c(MUTED, "─".repeat(84), useColor);
  const blockedN = Object.keys(derived.blocked || {}).length;

  const lines = [];
  lines.push("");
  lines.push(`  ${c(BOLD, data.meta.name, useColor)}  ${c(MUTED, `[${slug}]`, useColor)}`);
  lines.push(`  ${c(MUTED, path, useColor)}`);
  lines.push(`  ${LINE}`);
  lines.push(
    `  ${c(GREEN, padr(derived.pct + "%", 5), useColor)}  ${segBar(derived.counts, derived.total, 28, useColor)}  ${derived.counts.complete || 0}/${derived.total}   ·  ${c(AMBER, (derived.counts.in_progress || 0) + " active", useColor)}  ·  ${c(RED, blockedN + " blocked", useColor)}  ·  ${c(MUTED, (derived.counts.deferred || 0) + " deferred", useColor)}`
  );

  if (data.meta.scratchpad) {
    lines.push("");
    lines.push(`  ${c(AMBER, "[SCRATCHPAD]", useColor)}`);
    for (const line of data.meta.scratchpad.split("\n")) {
      lines.push(`  ${c(AMBER, line, useColor)}`);
    }
  }

  lines.push("");
  lines.push(`  ${c(AMBER, "SWIMLANES", useColor)}`);
  lines.push(`  ${LINE}`);
  for (const lane of data.meta.swimlanes) {
    const per = derived.perSwimlane[lane.id] || { counts: {}, pct: 0, total: 0 };
    const flag =
      lane.collapsed === true
        ? "  " + c(MUTED, "[collapsed]", useColor)
        : lane.collapsed === false
        ? "  " + c(MUTED, "[expanded]", useColor)
        : "";
    lines.push(
      `  ${c(BOLD, pad(lane.label, 18), useColor)} ${c(GREEN, padr(per.pct + "%", 5), useColor)}  ${segBar(per.counts, per.total, 16, useColor)}  ${per.counts.complete || 0}/${per.total}   ·  ${c(AMBER, (per.counts.in_progress || 0) + " active", useColor)}${flag}`
    );
  }

  if (blockedN > 0) {
    lines.push("");
    lines.push(`  ${c(RED, "BLOCKED TASKS", useColor)}`);
    lines.push(`  ${LINE}`);
    for (const id of Object.keys(derived.blocked)) {
      const t = data.tasks.find((x) => x.id === id);
      const deps = derived.blocked[id].join(", ");
      lines.push(
        `  ${c(BOLD, pad(id, 12), useColor)} ${pad(t?.title || "", 40)} ${c(MUTED, "← " + deps, useColor)}`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function renderJson(projects, workspace) {
  return JSON.stringify(
    {
      workspace,
      projects: projects.map((p) =>
        p.ok
          ? {
              slug: p.slug,
              name: p.data.meta.name,
              total: p.derived.total,
              pct: p.derived.pct,
              counts: p.derived.counts,
              blocked: p.derived.blocked,
              perSwimlane: p.derived.perSwimlane,
              scratchpad: p.data.meta.scratchpad || ""
            }
          : { slug: p.slug, error: p.error, path: p.path }
      )
    },
    null,
    2
  );
}
