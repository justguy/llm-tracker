import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortDraft } from "../ui/app-logic.js";

test("parsePortDraft accepts exact decimal port values only", () => {
  assert.equal(parsePortDraft("4400"), 4400);
  assert.equal(parsePortDraft(" 8080 "), 8080);
  assert.equal(parsePortDraft(3000), 3000);
  assert.equal(parsePortDraft("1e3"), null);
  assert.equal(parsePortDraft("123abc"), null);
  assert.equal(parsePortDraft("0"), null);
  assert.equal(parsePortDraft("65536"), null);
  assert.equal(parsePortDraft(""), null);
  assert.equal(parsePortDraft(null), null);
});
