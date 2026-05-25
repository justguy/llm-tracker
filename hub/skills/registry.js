// hub/skills/registry.js — SH-5-02 (TDD v0.5 §11.1, §11.2, §6.5)
//
// SkillsRegistry — in-memory catalog of SkillDefinitions. Boots with the
// built-in skills from hub/skills/builtins/index.js and accepts additional
// definitions through register(). Mirrors hub/jobs/registry.js (SH-5-01) in
// structure: frozen enum exports, dependency-injection constructor with
// reasonable defaults, errors carry a stable `.code` for callers.
//
// What this module is responsible for:
//   - Validating every SkillDefinition (built-in or user-supplied) against
//     the §11.1 shape: required id/title/description, appliesTo[] of strings,
//     defaultPhases[] of §6.5 SkillPhase values, and an adapters{} object
//     whose sub-shapes each match the TDD's `{ shortcut | tool | path |
//     endpoint }` contract.
//   - Freezing both the per-skill object (including nested adapters /
//     defaultPhases / appliesTo) and the registry's internal list so callers
//     cannot mutate the catalog after registration.
//   - Surfacing read-only lookups: list() in declaration order, get()/has()
//     by id, resolveAdapter(skillId, kind) returning the adapter descriptor
//     or undefined when absent, and phasesFor(skillId) for the §11.3 hook
//     pipeline (returns [] for unknown ids).
//
// What this module does NOT do:
//   - Compose skill plans from job profiles — SH-5-03 owns hub/jobs/profiles
//     and hub/jobs/skill-plan; the registry only exposes the static catalog
//     those modules consume.
//   - Execute skill runs or emit RuntimeEvents — that belongs to whatever
//     adapter the caller chooses (codex app server, mcp prompt dispatcher,
//     etc.). The registry returns adapter descriptors so callers can route
//     themselves.
//   - Persist definitions. The catalog is rebuilt in-process on each startup
//     from the built-ins module plus any caller-supplied definitions.

import { BUILT_IN_SKILLS } from "./builtins/index.js";

/**
 * @typedef {"before_start" | "on_start" | "checkpoint" | "on_quiet" | "on_blocked" | "before_complete" | "after_complete" | "on_rollover" | "on_resume"} SkillPhase
 */

/**
 * @typedef {"codexSkill" | "mcpPrompt" | "promptTemplate" | "httpAction"} SkillAdapterKind
 */

/**
 * @typedef {object} SkillDefinition
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string[]} appliesTo
 * @property {SkillPhase[]} defaultPhases
 * @property {object} adapters
 * @property {{ shortcut: string }} [adapters.codexSkill]
 * @property {{ tool: string }} [adapters.mcpPrompt]
 * @property {{ path: string }} [adapters.promptTemplate]
 * @property {{ endpoint: string }} [adapters.httpAction]
 */

/** TDD §6.5 SkillPhase enum. Frozen so callers can rely on identity. */
export const ALLOWED_SKILL_PHASES = Object.freeze([
  "before_start",
  "on_start",
  "checkpoint",
  "on_quiet",
  "on_blocked",
  "before_complete",
  "after_complete",
  "on_rollover",
  "on_resume",
]);

/** TDD §11.1 adapter kinds. Frozen. */
export const ALLOWED_SKILL_ADAPTER_KINDS = Object.freeze([
  "codexSkill",
  "mcpPrompt",
  "promptTemplate",
  "httpAction",
]);

/** Re-export so callers don't need a second import. */
export { BUILT_IN_SKILLS };

/**
 * Build a registry-shaped Error. The `code` field is the stable contract for
 * HTTP/CLI/MCP layers; the message is for humans.
 *
 * @param {string} message
 * @param {string} code
 * @param {object} [details]
 * @returns {Error & { code: string; details?: object }}
 */
function makeError(message, code, details) {
  const err = /** @type {any} */ (new Error(message));
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/**
 * Assert that `value` is a non-empty string.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {string} context
 */
function assertNonEmptyString(value, field, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw makeError(
      `${context}: ${field} required (non-empty string)`,
      "INVALID_SKILL_DEFINITION",
      { field },
    );
  }
}

/**
 * Per-adapter validators. Each returns a frozen clone of the supplied
 * descriptor or throws an INVALID_SKILL_ADAPTER error.
 *
 * @type {Record<SkillAdapterKind, (value: unknown, context: string) => object>}
 */
const ADAPTER_VALIDATORS = {
  codexSkill(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw makeError(`${context}: adapters.codexSkill must be an object`, "INVALID_SKILL_ADAPTER", { kind: "codexSkill" });
    }
    const { shortcut } = /** @type {{ shortcut?: unknown }} */ (value);
    if (typeof shortcut !== "string" || shortcut.length === 0) {
      throw makeError(
        `${context}: adapters.codexSkill.shortcut required (non-empty string)`,
        "INVALID_SKILL_ADAPTER",
        { kind: "codexSkill", field: "shortcut" },
      );
    }
    return Object.freeze({ shortcut });
  },
  mcpPrompt(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw makeError(`${context}: adapters.mcpPrompt must be an object`, "INVALID_SKILL_ADAPTER", { kind: "mcpPrompt" });
    }
    const { tool } = /** @type {{ tool?: unknown }} */ (value);
    if (typeof tool !== "string" || tool.length === 0) {
      throw makeError(
        `${context}: adapters.mcpPrompt.tool required (non-empty string)`,
        "INVALID_SKILL_ADAPTER",
        { kind: "mcpPrompt", field: "tool" },
      );
    }
    return Object.freeze({ tool });
  },
  promptTemplate(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw makeError(`${context}: adapters.promptTemplate must be an object`, "INVALID_SKILL_ADAPTER", { kind: "promptTemplate" });
    }
    const { path } = /** @type {{ path?: unknown }} */ (value);
    if (typeof path !== "string" || path.length === 0) {
      throw makeError(
        `${context}: adapters.promptTemplate.path required (non-empty string)`,
        "INVALID_SKILL_ADAPTER",
        { kind: "promptTemplate", field: "path" },
      );
    }
    return Object.freeze({ path });
  },
  httpAction(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw makeError(`${context}: adapters.httpAction must be an object`, "INVALID_SKILL_ADAPTER", { kind: "httpAction" });
    }
    const { endpoint } = /** @type {{ endpoint?: unknown }} */ (value);
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw makeError(
        `${context}: adapters.httpAction.endpoint required (non-empty string)`,
        "INVALID_SKILL_ADAPTER",
        { kind: "httpAction", field: "endpoint" },
      );
    }
    return Object.freeze({ endpoint });
  },
};

/**
 * Validate a raw SkillDefinition and return a deeply-frozen clone. Throws
 * with .code on the first invariant violation.
 *
 * @param {unknown} raw
 * @returns {SkillDefinition}
 */
function normalizeDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw makeError("register: definition must be an object", "INVALID_SKILL_DEFINITION");
  }
  const def = /** @type {SkillDefinition} */ (raw);
  const context = `register('${typeof def.id === "string" ? def.id : "<no-id>"}')`;
  assertNonEmptyString(def.id, "id", context);
  assertNonEmptyString(def.title, "title", context);
  assertNonEmptyString(def.description, "description", context);

  if (!Array.isArray(def.appliesTo) || def.appliesTo.length === 0) {
    throw makeError(`${context}: appliesTo must be a non-empty string[]`, "INVALID_SKILL_DEFINITION", { field: "appliesTo" });
  }
  for (const entry of def.appliesTo) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw makeError(`${context}: appliesTo entries must be non-empty strings`, "INVALID_SKILL_DEFINITION", { field: "appliesTo" });
    }
  }

  if (!Array.isArray(def.defaultPhases) || def.defaultPhases.length === 0) {
    throw makeError(`${context}: defaultPhases must be a non-empty SkillPhase[]`, "INVALID_SKILL_DEFINITION", { field: "defaultPhases" });
  }
  for (const phase of def.defaultPhases) {
    if (!ALLOWED_SKILL_PHASES.includes(/** @type {SkillPhase} */ (phase))) {
      throw makeError(
        `${context}: defaultPhase '${phase}' not in ${ALLOWED_SKILL_PHASES.join("|")}`,
        "INVALID_SKILL_PHASE",
        { phase, allowed: [...ALLOWED_SKILL_PHASES] },
      );
    }
  }

  if (!def.adapters || typeof def.adapters !== "object" || Array.isArray(def.adapters)) {
    throw makeError(`${context}: adapters must be an object`, "INVALID_SKILL_DEFINITION", { field: "adapters" });
  }
  /** @type {Record<string, object>} */
  const adapters = {};
  let adapterCount = 0;
  for (const key of Object.keys(def.adapters)) {
    if (!ALLOWED_SKILL_ADAPTER_KINDS.includes(/** @type {SkillAdapterKind} */ (key))) {
      throw makeError(
        `${context}: unknown adapter kind '${key}'`,
        "INVALID_SKILL_ADAPTER",
        { kind: key, allowed: [...ALLOWED_SKILL_ADAPTER_KINDS] },
      );
    }
    const validator = ADAPTER_VALIDATORS[/** @type {SkillAdapterKind} */ (key)];
    adapters[key] = validator(/** @type {any} */ (def.adapters)[key], context);
    adapterCount += 1;
  }
  if (adapterCount === 0) {
    throw makeError(`${context}: adapters must declare at least one adapter`, "INVALID_SKILL_DEFINITION", { field: "adapters" });
  }

  return /** @type {SkillDefinition} */ (Object.freeze({
    id: def.id,
    title: def.title,
    description: def.description,
    appliesTo: Object.freeze([...def.appliesTo]),
    defaultPhases: Object.freeze([...def.defaultPhases]),
    adapters: Object.freeze(adapters),
  }));
}

/**
 * Catalog of SkillDefinitions. Lookup-only after construction; register()
 * lets tests/extensions add definitions before the catalog is handed to
 * downstream consumers.
 */
export class SkillsRegistry {
  /**
   * @param {{ definitions?: Iterable<SkillDefinition> }} [opts]
   */
  constructor(opts = {}) {
    const definitions = opts && opts.definitions !== undefined ? opts.definitions : BUILT_IN_SKILLS;
    if (!definitions || typeof (/** @type {any} */ (definitions))[Symbol.iterator] !== "function") {
      throw makeError("SkillsRegistry: definitions must be iterable", "INVALID_SKILL_DEFINITIONS");
    }
    /** @type {Map<string, SkillDefinition>} */
    this._byId = new Map();
    /** @type {SkillDefinition[]} */
    this._order = [];
    for (const def of definitions) {
      this.register(def);
    }
  }

  /**
   * Register a SkillDefinition. Validates the shape, freezes the result,
   * and rejects duplicate ids.
   *
   * @param {SkillDefinition} definition
   * @returns {SkillDefinition} the frozen, normalized clone now stored
   */
  register(definition) {
    const normalized = normalizeDefinition(definition);
    if (this._byId.has(normalized.id)) {
      throw makeError(
        `register: skill id '${normalized.id}' already registered`,
        "DUPLICATE_SKILL_ID",
        { id: normalized.id },
      );
    }
    this._byId.set(normalized.id, normalized);
    this._order.push(normalized);
    return normalized;
  }

  /**
   * All registered skills in declaration order. Returns a fresh array so
   * callers cannot mutate internal ordering.
   *
   * @returns {SkillDefinition[]}
   */
  list() {
    return [...this._order];
  }

  /**
   * Look up a skill by id. Returns null when no such skill exists so
   * callers don't have to try/catch.
   *
   * @param {string} skillId
   * @returns {SkillDefinition | null}
   */
  get(skillId) {
    if (typeof skillId !== "string") return null;
    return this._byId.get(skillId) || null;
  }

  /**
   * @param {string} skillId
   * @returns {boolean}
   */
  has(skillId) {
    if (typeof skillId !== "string") return false;
    return this._byId.has(skillId);
  }

  /**
   * Resolve a skill's adapter descriptor. Returns undefined when either
   * the skill is unknown or the adapter is not defined on that skill —
   * callers that need to differentiate can use has()/get() first.
   *
   * @param {string} skillId
   * @param {SkillAdapterKind} kind
   * @returns {object | undefined}
   */
  resolveAdapter(skillId, kind) {
    if (!ALLOWED_SKILL_ADAPTER_KINDS.includes(kind)) {
      throw makeError(
        `resolveAdapter: kind '${kind}' not in ${ALLOWED_SKILL_ADAPTER_KINDS.join("|")}`,
        "INVALID_SKILL_ADAPTER",
        { kind, allowed: [...ALLOWED_SKILL_ADAPTER_KINDS] },
      );
    }
    const skill = this.get(skillId);
    if (!skill) return undefined;
    return skill.adapters[/** @type {keyof typeof skill.adapters} */ (kind)];
  }

  /**
   * Default lifecycle phases for a skill. Returns an empty array for
   * unknown skills so caller plan-generation code can compose with
   * concat() without null guards.
   *
   * @param {string} skillId
   * @returns {SkillPhase[]}
   */
  phasesFor(skillId) {
    const skill = this.get(skillId);
    if (!skill) return [];
    return [...skill.defaultPhases];
  }
}
