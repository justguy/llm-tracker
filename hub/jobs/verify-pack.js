// SH-5-04 stub-protocol stamper (TASKS §1.5 stub-friendly hand-off table).
//
// This file exists so Track 2's RunSessionService (sh-3-05) can compile
// against the verify-pack stamping API before Track 4 lands full composition.
// Until then it returns an immutable, structurally valid pack without composing
// task/profile/workspace defaults. Once sh-5-03 (profiles) and sh-3-05 are in,
// replace this with the §11.6.1 implementation:
//
//   stampVerifyPack({ jobId, tracker, profile, workspace }) -> VerifyPack
//
//   - compose items in precedence order: task.verify.items -> profile
//     defaults -> workspace defaults
//   - collision rule: earlier source wins on `id` (later sources do not
//     override an earlier id)
//   - validate task.verify.items per sh-5-07 before merge
//   - patches to task.verify after stamping must NOT widen an in-flight pack

function cloneItems(items) {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function freezePack(pack) {
  return Object.freeze({
    ...pack,
    items: cloneItems(Array.isArray(pack.items) ? pack.items : [])
  });
}

export function stampVerifyPack(input = {}) {
  if (input && typeof input === "object" && Array.isArray(input.items)) {
    return freezePack(input);
  }

  const stampedFromRev =
    Number.isInteger(input?.stampedFromRev)
      ? input.stampedFromRev
      : (input?.tracker?.meta?.rev ?? null);

  return freezePack({
    jobId: input?.jobId ?? input?.job?.id ?? null,
    stampedAt: input?.stampedAt ?? new Date().toISOString(),
    stampedFromRev,
    items: []
  });
}
