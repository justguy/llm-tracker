import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeTime } from "../ui/scratchpad-row.js";

test("relativeTime returns an empty label without a timestamp", () => {
  assert.equal(relativeTime(null), "");
  assert.equal(relativeTime(""), "");
});

test("relativeTime formats elapsed seconds, minutes, hours, and days", () => {
  const originalNow = Date.now;
  Date.now = () => new Date("2026-04-23T12:00:00.000Z").getTime();
  try {
    assert.equal(relativeTime("2026-04-23T11:59:31.000Z"), "29s ago");
    assert.equal(relativeTime("2026-04-23T11:58:00.000Z"), "2m ago");
    assert.equal(relativeTime("2026-04-23T09:00:00.000Z"), "3h ago");
    assert.equal(relativeTime("2026-04-20T11:59:59.000Z"), "3d ago");
  } finally {
    Date.now = originalNow;
  }
});
