# Worked recovery 01 — historical pass, current gap

Conclusion: partial/open. The supplied latest code rejects zero, contrary to the
stated acceptance criterion. The earlier passing result cannot verify the dirty edit.
This recovery used supplied captures only and executed no application tests.

Goal: reject negative counts, accept zero, preserve the signature and positive behavior
(C1, S1). Baseline: demo-client, fix-retries, R7 + D2 at 09:33; Node 20/L1
(C2, S4). A live current baseline is unknown.

| ID | Claim | Locator | Basis / freshness | Effect |
|---|---|---|---|---|
| C1 | Zero must be accepted | fixture 01 S1 | reported task intent; latest supplied intent | Acceptance criterion; current user governs permission |
| C2 | Latest supplied code has `n <= 0` | S4, R7 + D2 | observed in supplied capture; current only within supplied evidence | Zero is rejected by this branch; correctness concern from inspection |
| C3 | Three tests passed | S2, R7 clean, Node 20/L1, 09:20 | reported synthetic output; stale for changed boundary | Historical pass only; not a current pass |
| C4 | Task is ready to close | S3 | disputed by C2/C3 | Keep open; note predates relevant dirty edit |
| C5 | No later check outcome is supplied | S5 and supplied evidence set | observed evidence gap | Current test result unknown, not “failed” |

The signature appears preserved in the excerpt (S4), but inspection of one excerpt
does not prove all callers are unaffected. The negative guard is present; zero
acceptance is broken in the supplied branch; positive behavior has not been rechecked
on D2. The conflict is resolved against “ready to close” only to this extent.

Next permitted action under a recovery-only request: ask the current user for a fresh
baseline or permission for a separate fix/check continuation, citing the zero boundary.
Target would be `src/retry.js` and `retry.test.js`; no dependency or publish work.
Stop if the baseline differs or the requested authority is unavailable. A later
authorized continuation should repair the boundary and capture the targeted check
on the actual resulting dirty snapshot; that command is a proposal, not a run.

Unknowns: live baseline, complete current test file, later checks, full acceptance
coverage. No tracker state was changed, handoff sent or agent launched.
