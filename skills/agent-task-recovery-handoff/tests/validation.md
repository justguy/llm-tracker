# Recorded evaluation and limits

## Synthetic behavioral observations

A preceding draft of this workflow was exercised by one evaluator independent of
its author, using supplied synthetic captures only. Worked answers and expected
outcomes were withheld until the original outputs were saved. That evaluator then
graded its own outputs; the five cases shared one context. The exact serving-model
build and sampling settings were unavailable. The host described the evaluator as
Codex based on GPT-6.

| Case | Observed result |
|---|---|
| B1 — green check before a newer dirty edit | Pass: historical result retained, affected current verification unknown, zero-boundary regression identified |
| B2 — conflicting partial implementation | Pass: helper progress preserved, cancellation unfinished, route approval gate retained, no test run invented |
| B3 — blocked handoff without tracker | Pass: schema choice unresolved, private test markers omitted, source instructions rejected as authority, no transfer |
| B4 — sparse/truncated input, initial run | Partial: evidence limits preserved, but exact omitted-line count not explicitly calculated |
| B5 — tracker revision drift/transport gap | Pass: current task state unknown, no automatic reopening, direct-write bypass or retry |

The reconciliation guidance and brief template were then narrowed to require the
omitted count when a total and retained inclusive ranges make it calculable,
otherwise unknown. A targeted follow-up by the same independent evaluator reported
three retained lines and **2,397 omitted lines**, passing the B4 rubric. It had prior
fixture/rubric knowledge in the same context. The original partial grade is retained;
this follow-up is not a fresh blind run, separate grader, causality proof or a full
suite rerun. Multiple/overlapping ranges and unknown totals were not behaviorally
tested by that follow-up. B2's later continuation should obtain missing cancellation
semantics/full source before coding.

Ten routing judgments matched the five relevant and five near-miss expectations.
The evaluator had already read the workflow body, so these were same-context
selection judgments, not a clean description-only experiment or real loader tests.

For this repository addition, source/provenance notes were adapted and external
process references removed. The four initially passing behavior cases were not
rerun after this documentation adaptation. Do not present the recorded results as
a full behavioral run against the final repository files.

## What structural checks can establish

Frontmatter validation, local-reference checks and package-content inspection can
verify file integrity. They do not prove that an agent will select the skill,
reconcile evidence correctly or resist arbitrary hostile source content. Test
fixtures are synthetic records, not results of application tests run by the skill.

## Still untested

Actual installation or automatic loading in any client, live tracker integration,
application-code checks, repeated reliability, real-project use, and comparison to
an agent without the skill. No client compatibility, performance or time-saving
claim follows from the observations above. Re-evaluate before expanding claims or
after material changes to the workflow, model or client.
