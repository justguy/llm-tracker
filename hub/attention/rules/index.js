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
import { sandboxEscapeRequestedRule } from "./sandbox_escape_requested.js";
import { providerErrorRule } from "./provider_error.js";
import { wrapRuleWithAutoClear } from "./auto_clear.js";

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
  sandboxEscapeRequestedRule,
  providerErrorRule,
};
export { wrapRuleWithAutoClear } from "./auto_clear.js";

/**
 * Register every SH-4-03 rule on `engine`, wrapped with the SH-4-04
 * auto-clear behaviour so an item the rule stops emitting receives one
 * final tick with `clearedAt` set (TDD §8A.3 "Clear rules"). Idempotent:
 * registering the same kind twice simply replaces the slot.
 * `unbound_session` is left alone — it ships from the engine constructor
 * (SH-4-02) and is not listed in §8A.3 clear rules.
 *
 * @param {import("../engine.js").AttentionEngine} engine
 * @returns {void}
 */
export function registerAllRules(engine) {
  if (!engine || typeof engine.registerRule !== "function") {
    throw new TypeError("registerAllRules: engine.registerRule is required");
  }
  engine.registerRule("approval_needed", wrapRuleWithAutoClear(approvalNeededRule));
  engine.registerRule("blocked", wrapRuleWithAutoClear(blockedRule));
  engine.registerRule("conflict", wrapRuleWithAutoClear(conflictRule));
  engine.registerRule("outside_allowed_paths", wrapRuleWithAutoClear(outsideAllowedPathsRule));
  engine.registerRule("not_responding", wrapRuleWithAutoClear(notRespondingRule));
  engine.registerRule("quiet", wrapRuleWithAutoClear(quietRule));
  engine.registerRule("context_high", wrapRuleWithAutoClear(contextHighRule));
  engine.registerRule("done_needs_closeout", wrapRuleWithAutoClear(doneNeedsCloseoutRule));
  engine.registerRule("done_claimed_verify_missing", wrapRuleWithAutoClear(doneClaimedVerifyMissingRule));
  engine.registerRule("verify_missing", wrapRuleWithAutoClear(verifyMissingRule));
  engine.registerRule("sandbox_escape_requested", wrapRuleWithAutoClear(sandboxEscapeRequestedRule));
  engine.registerRule("provider_error", wrapRuleWithAutoClear(providerErrorRule));
}
