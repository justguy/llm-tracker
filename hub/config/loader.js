// SH-0-03 workspace-config loader.
//
// Lookup order (first match wins for the file body; later sources only fill
// in keys the higher-precedence ones left undefined):
//   1. --config <path> flag (resolved by the caller and passed in)
//   2. LLM_TRACKER_CONFIG env var
//   3. <workspaceRoot>/llm-tracker.config.yaml
//   4. <workspaceRoot>/.llm-tracker/config.yaml
//   5. built-in §25 defaults (always merged in as the base)
//
// Implementation note on "flag wins; later sources only fill in unspecified
// keys": the user-facing contract is that the highest-precedence file's keys
// take effect verbatim, while ANY key that file omits falls through to the
// next source down (and eventually to defaults). We implement this by
// folding sources from LOWEST precedence to HIGHEST with deepMerge so the
// later (higher-precedence) overlay wins on every defined key.
//
// On parse failure the loader THROWS with a message that names the file and
// the line/column reported by the YAML parser. The server boot path catches
// this and reports a startup error; the HTTP route catches it and returns
// 500 with the same line-anchored error body.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseDocument, LineCounter } from "yaml";
import { cloneDefaults, WORKSPACE_CONFIG_DEFAULTS } from "./defaults.js";
import { deepMerge, appliedKeys } from "./deepMerge.js";
import { validateWorkspaceConfig } from "./validator.js";

function resolveCandidatePath(workspaceRoot, candidate) {
  if (!candidate) return null;
  return isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate);
}

function readYamlFile(filePath) {
  // Returns { data, error? }. `error` carries a line-anchored message ready
  // for the loader to throw.
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`workspace config: cannot read ${filePath}: ${e.message}`);
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter, prettyErrors: true });
  if (doc.errors && doc.errors.length > 0) {
    const first = doc.errors[0];
    const pos = first.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    const err = new Error(
      `workspace config: malformed YAML in ${filePath}${where}: ${first.message}`
    );
    err.file = filePath;
    if (pos) {
      err.line = pos.line;
      err.column = pos.col;
    }
    err.code = "WORKSPACE_CONFIG_PARSE_ERROR";
    throw err;
  }
  const data = doc.toJS({ maxAliasCount: 100 });
  return data == null ? {} : data;
}

function describeSources(sources) {
  // Each entry: { kind, path? }. `kind` is one of flag | env | file | defaults.
  return sources.map((s) => {
    const out = { kind: s.kind };
    if (s.path) out.path = s.path;
    if (s.appliedKeys) out.appliedKeys = s.appliedKeys;
    return out;
  });
}

export const WORKSPACE_CONFIG_FILE_CANDIDATES = [
  "llm-tracker.config.yaml",
  join(".llm-tracker", "config.yaml")
];

export const WORKSPACE_CONFIG_ENV_VAR = "LLM_TRACKER_CONFIG";

export async function loadWorkspaceConfig({
  workspaceRoot,
  configFlag,
  env = process.env
} = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new Error("loadWorkspaceConfig: workspaceRoot (absolute path) is required");
  }

  // Gather source candidates in PRIORITY order (highest first). We will fold
  // them in REVERSE so the highest-priority overlay wins on the merge.
  const candidates = [];

  if (configFlag) {
    const flagPath = resolveCandidatePath(workspaceRoot, configFlag);
    if (!existsSync(flagPath)) {
      throw new Error(
        `workspace config: --config path does not exist: ${flagPath}`
      );
    }
    candidates.push({ kind: "flag", path: flagPath });
  }

  const envPath = env?.[WORKSPACE_CONFIG_ENV_VAR];
  if (envPath) {
    const resolvedEnvPath = resolveCandidatePath(workspaceRoot, envPath);
    if (!existsSync(resolvedEnvPath)) {
      throw new Error(
        `workspace config: ${WORKSPACE_CONFIG_ENV_VAR}=${envPath} but file does not exist: ${resolvedEnvPath}`
      );
    }
    candidates.push({ kind: "env", path: resolvedEnvPath });
  }

  for (const rel of WORKSPACE_CONFIG_FILE_CANDIDATES) {
    const abs = join(workspaceRoot, rel);
    if (existsSync(abs)) {
      candidates.push({ kind: "file", path: abs });
    }
  }

  // No file source found at all → return defaults wholesale.
  if (candidates.length === 0) {
    return {
      resolved: cloneDefaults(),
      sources: [{ kind: "defaults" }],
      raw: {}
    };
  }

  // Parse every candidate up front so a malformed file in any tier throws
  // BEFORE we do partial work. This is what "fails startup with a
  // line-anchored error" means in DoD #4.
  const parsed = candidates.map((src) => ({
    ...src,
    data: readYamlFile(src.path)
  }));

  // Validate each parsed source against the LOOSE schema. A schema violation
  // also throws — startup must fail loudly.
  for (const src of parsed) {
    const { ok, errors } = validateWorkspaceConfig(src.data);
    if (!ok) {
      const err = new Error(
        `workspace config: schema violation in ${src.path}: ${errors.join("; ")}`
      );
      err.file = src.path;
      err.code = "WORKSPACE_CONFIG_SCHEMA_ERROR";
      err.errors = errors;
      throw err;
    }
  }

  // Fold defaults + sources from lowest precedence (defaults) up to highest
  // (flag). The deepMerge semantics ("overlay wins on every defined key,
  // arrays replace wholesale") give us the contract from DoD #1.
  const defaults = cloneDefaults();
  const sources = [{ kind: "defaults" }];

  // Lowest-priority source first in the merge so highest-priority wins.
  // `parsed` was built highest→lowest in `candidates`; reverse for the fold.
  const lowestFirst = parsed.slice().reverse();
  let merged = defaults;
  for (const src of lowestFirst) {
    const before = merged;
    merged = deepMerge(merged, src.data);
    sources.push({
      kind: src.kind,
      path: src.path,
      appliedKeys: appliedKeys(before, src.data)
    });
  }

  return {
    resolved: merged,
    sources: describeSources(sources),
    // The unmerged data from each source, ordered from highest to lowest
    // precedence. Handy for debugging / dry-run tooling later.
    raw: Object.fromEntries(parsed.map((s) => [s.path, s.data]))
  };
}

export { WORKSPACE_CONFIG_DEFAULTS };
