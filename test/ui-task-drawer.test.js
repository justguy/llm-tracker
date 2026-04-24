import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskDrawerMode } from "../ui/task-drawer.js";

test("normalizeTaskDrawerMode accepts valid initial drawer modes", () => {
  for (const mode of ["brief", "why", "execute", "verify"]) {
    assert.equal(normalizeTaskDrawerMode(mode), mode);
  }
});

test("normalizeTaskDrawerMode falls back to brief for invalid initial drawer modes", () => {
  for (const mode of [null, undefined, "", "read", "WHY", "next"]) {
    assert.equal(normalizeTaskDrawerMode(mode), "brief");
  }
});
