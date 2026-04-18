import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasNormalizedReferences,
  isReferenceString,
  normalizeEffort,
  normalizeTaskReferences
} from "../hub/references.js";

test("normalizeTaskReferences prefers explicit references and folds in legacy reference", () => {
  const refs = normalizeTaskReferences({
    reference: "hub/store.js:1-20",
    references: ["ARCHITECTURE.md:10-40", "hub/store.js:1-20"]
  });

  assert.deepEqual(refs, ["ARCHITECTURE.md:10-40", "hub/store.js:1-20"]);
});

test("hasNormalizedReferences is true for legacy reference only", () => {
  assert.equal(hasNormalizedReferences({ reference: "hub/server.js:1-10" }), true);
  assert.equal(hasNormalizedReferences({}), false);
});

test("isReferenceString validates path and line ranges", () => {
  assert.equal(isReferenceString("hub/server.js:1-20"), true);
  assert.equal(isReferenceString("hub/server.js"), false);
});

test("normalizeEffort accepts only known effort values", () => {
  assert.equal(normalizeEffort("m"), "m");
  assert.equal(normalizeEffort("huge"), null);
  assert.equal(normalizeEffort(null), null);
});
