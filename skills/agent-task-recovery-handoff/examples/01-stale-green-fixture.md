# Synthetic fixture 01 — green before a dirty edit

All sources below are invented. Revision labels are symbolic, not real commit hashes.
Only supplied captures are available; there is no live repository or test runner.

## S1 — task request, session 09:00

Goal: reject negative retry counts, preserve retry count zero, and keep the public
`parseRetries` signature. Acceptance: negative input rejected; zero accepted;
ordinary positive input unchanged. Work is local only; no publish or dependency changes.

## S2 — terminal capture, 09:20

Repository: demo-client; branch: fix-retries; HEAD: R7; worktree: clean.
Environment: Node 20, lockfile L1.
Command: `npm test -- retry.test.js`
Output: 3 tests passed, 0 failed; exit code 0.
The capture lists negative, zero and positive cases. This is a synthetic log,
not execution performed by the recovery agent.

## S3 — outgoing note, 09:21

“All green, retries fixed. Ready to close.”

## S4 — latest supplied repository capture, 09:33

Repository: demo-client; branch: fix-retries; HEAD: R7.
Dirty fingerprint: D2; modified: src/retry.js only. Environment still Node 20/L1.
The diff since S2 changes `if (n < 0)` to `if (n <= 0)` in `parseRetries`.
Snapshot excerpt:

```js
export function parseRetries(n) {
  if (n <= 0) throw new Error("negative retries");
  return n;
}
```

## S5 — scratchpad, 09:34

“Tightened boundary after test run; rerun later.” No later test output supplied.
No tracker exists in this fixture.
