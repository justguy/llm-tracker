import { isContextPackKind } from "../service.js";
import { composeStartPack } from "./start.js";
import { composeResumePack } from "./resume.js";
import { composeRolloverPack } from "./rollover.js";
import { composeHandoffPack } from "./handoff.js";
import { composeReviewPack } from "./review.js";
import { composeVerifyPack } from "./verify.js";
import { composeCloseoutPack } from "./closeout.js";
import { composeChangedSincePack } from "./changed-since.js";

export { composeStartPack } from "./start.js";
export { composeResumePack } from "./resume.js";
export { composeRolloverPack } from "./rollover.js";
export { composeHandoffPack } from "./handoff.js";
export { composeReviewPack } from "./review.js";
export { composeVerifyPack } from "./verify.js";
export { composeCloseoutPack } from "./closeout.js";
export { composeChangedSincePack } from "./changed-since.js";
export { PACK_SOURCE, composePack } from "./shared.js";

export const CONTEXT_PACK_COMPOSERS = Object.freeze({
  start: composeStartPack,
  resume: composeResumePack,
  rollover: composeRolloverPack,
  handoff: composeHandoffPack,
  review: composeReviewPack,
  verify: composeVerifyPack,
  closeout: composeCloseoutPack,
  changed_since: composeChangedSincePack,
});

export function composeContextPack(kind, params = {}, deps = {}) {
  if (!isContextPackKind(kind) || !CONTEXT_PACK_COMPOSERS[kind]) {
    const err = new Error(`composeContextPack: unsupported kind '${kind}'`);
    err.code = "INVALID_KIND";
    err.details = { allowed: Object.keys(CONTEXT_PACK_COMPOSERS) };
    throw err;
  }
  return CONTEXT_PACK_COMPOSERS[kind](params, deps);
}

export default CONTEXT_PACK_COMPOSERS;
