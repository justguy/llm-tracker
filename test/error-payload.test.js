import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrackerErrorBody, inferTrackerErrorHint } from "../hub/error-payload.js";

test("inferTrackerErrorHint explains invalid reference syntax", () => {
  const hint = inferTrackerErrorHint(
    "/tasks/0/references/0: reference must use path:line or path:line-line; bare URLs are invalid"
  );
  assert.match(hint, /path:line/);
  assert.match(hint, /Bare URLs are invalid/);
});

test("inferTrackerErrorHint explains patch-mode task creation guardrail", () => {
  const hint = inferTrackerErrorHint(
    "new tasks added through patch mode must start as not_started or in_progress; rejecting t-019 (complete)"
  );
  assert.match(hint, /not_started/);
  assert.match(hint, /owning row/);
});

test("buildTrackerErrorBody emits error, type, hint, and legacy compatibility fields", () => {
  const body = buildTrackerErrorBody({
    message: "/tasks/0/references/0: reference must use path:line or path:line-line; bare URLs are invalid",
    kind: "schema",
    path: "/tmp/example.json",
    repair: { moveTasksTo: "exec" }
  });

  assert.equal(body.error, body.message);
  assert.equal(body.type, "schema");
  assert.equal(body.kind, "schema");
  assert.equal(body.path, "/tmp/example.json");
  assert.deepEqual(body.repair, { moveTasksTo: "exec" });
  assert.match(body.hint, /path:line/);
});
