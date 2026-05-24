// SH-0-03 CLI library: implements `llm-tracker config session-hub`.
//
// Prints the resolved workspace config (just the `sessionHub:` block) as
// either JSON (default) or YAML when `--format yaml` is passed. Exits with
// status 1 on usage errors or load failures so shells / CI can detect them.
//
// The thin command shim under bin/commands/config.js wires this into the
// top-level argv parser. We keep the actual logic here (under hub/) so it can
// be exercised directly from tests without spawning the bin script.

import { stringify as yamlStringify } from "yaml";
import { loadWorkspaceConfig } from "../config/loader.js";

const USAGE = `Usage: llm-tracker config session-hub [--format json|yaml] [--path <workspace>] [--config <file>]`;

function formatLoadError(err) {
  const lines = [`Failed to load workspace config: ${err.message || String(err)}`];
  if (err.file) lines.push(`  file: ${err.file}`);
  if (typeof err.line === "number") {
    lines.push(`  at: line ${err.line}${typeof err.column === "number" ? `, col ${err.column}` : ""}`);
  }
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    for (const e of err.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

export async function runConfigCommand({
  args,
  workspaceRoot,
  loadConfig = loadWorkspaceConfig,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code)
} = {}) {
  const subcommand = args?._?.[1];
  if (!subcommand) {
    stderr.write(USAGE + "\n");
    return exit(1);
  }
  if (subcommand !== "session-hub") {
    stderr.write(`Unknown subcommand "${subcommand}".\n${USAGE}\n`);
    return exit(1);
  }

  const format = (args.flags.format || "json").toLowerCase();
  if (format !== "json" && format !== "yaml") {
    stderr.write(`--format must be "json" or "yaml" (got "${format}")\n`);
    return exit(1);
  }

  if (!workspaceRoot) {
    stderr.write("config: workspace path could not be resolved\n");
    return exit(1);
  }

  let result;
  try {
    result = await loadConfig({
      workspaceRoot,
      configFlag: args.flags.config
    });
  } catch (err) {
    stderr.write(formatLoadError(err) + "\n");
    return exit(1);
  }

  const payload = {
    resolved: result.resolved?.sessionHub ?? null,
    sources: result.sources
  };

  if (format === "yaml") {
    stdout.write(yamlStringify(payload));
    return exit(0);
  }
  stdout.write(JSON.stringify(payload, null, 2) + "\n");
  return exit(0);
}
