// hub/attention/rules/index.js — SH-4-03 (TDD v0.5 §8A.3)
//
// Barrel for the per-kind AttentionEngine rule functions. `registerAllRules`
// is the explicit wiring entry point — downstream callers (engine bootstrap,
// integration tests) call this once on a fresh `AttentionEngine` to install
// every implemented rule. No rule self-registers at module load; consumers
// stay in control of which rules are active.
//
// NOTE: `unbound_session` is intentionally omitted here — SH-4-02 ships it
// inside `hub/attention/engine.js` so it's already wired on every fresh
// engine. Re-registering it from this barrel would silently replace the
// engine's bundled rule with an identical function and complicate teardown
// in tests.

import { approvalNeededRule } from "./approval_needed.js";
import { blockedRule } from "./blocked.js";
import { conflictRule } from "./conflict.js";
import { outsideAllowedPathsRule } from "./outside_allowed_paths.js";
import { notRespondingRule } from "./not_responding.js";
import { quietRule } from "./quiet.js";
import { contextHighRule } from "./context_high.js";
import { doneNeedsCloseoutRule } from "./done_needs_closeout.js";
import { doneClaimedVerifyMissingRule } from "./done_claimed_verify_missing.js";
import { verifyMissingRule } from "./verify_missing.js";

export {
  approvalNeededRule,
  blockedRule,
  conflictRule,
  outsideAllowedPathsRule,
  notRespondingRule,
  quietRule,
  contextHighRule,
  doneNeedsCloseoutRule,
  doneClaimedVerifyMissingRule,
  verifyMissingRule,
};

/**
 * Register every SH-4-03 rule on `engine`. Idempotent: registering the
 * same kind twice simply replaces the slot. `unbound_session` is left
 * alone — it ships from the engine constructor (SH-4-02).
 *
 * @param {import("../engine.js").AttentionEngine} engine
 * @returns {void}
 */
export function registerAllRules(engine) {
  if (!engine || typeof engine.registerRule !== "function") {
    throw new TypeError("registerAllRules: engine.registerRule is required");
  }
  engine.registerRule("approval_needed", approvalNeededRule);
  engine.registerRule("blocked", blockedRule);
  engine.registerRule("conflict", conflictRule);
  engine.registerRule("outside_allowed_paths", outsideAllowedPathsRule);
  engine.registerRule("not_responding", notRespondingRule);
  engine.registerRule("quiet", quietRule);
  engine.registerRule("context_high", contextHighRule);
  engine.registerRule("done_needs_closeout", doneNeedsCloseoutRule);
  engine.registerRule("done_claimed_verify_missing", doneClaimedVerifyMissingRule);
  engine.registerRule("verify_missing", verifyMissingRule);
}
