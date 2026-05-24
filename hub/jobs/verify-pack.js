// SH-5-04 stub-protocol no-op (TASKS §1.5 stub-friendly hand-off table).
//
// This file exists so Track 2's RunSessionService (sh-3-05) can compile and
// import the verify-pack stamping API before Track 4 lands the full
// composition. Once sh-5-03 (profiles) and sh-3-05 are in, replace this with
// the §11.6.1 implementation:
//
//   stampVerifyPack({ jobId, tracker, profile, workspace }) -> VerifyPack
//
//   - compose items in precedence order: task.verify.items -> profile
//     defaults -> workspace defaults
//   - collision rule: earlier source wins on `id` (later sources do not
//     override an earlier id)
//   - validate task.verify.items per sh-5-07 before merge
//   - return an immutable VerifyPack { jobId, stampedAt, stampedFromRev, items }
//   - patches to task.verify after stamping must NOT widen an in-flight pack

export function stampVerifyPack(pack) {
  return pack;
}
