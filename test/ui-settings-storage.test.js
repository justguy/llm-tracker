import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings, saveSettings, SETTINGS_KEY } from "../ui/settings-storage.js";

function storageWithValue(value) {
  return {
    saved: new Map([[SETTINGS_KEY, value]]),
    getItem(key) {
      return this.saved.has(key) ? this.saved.get(key) : null;
    },
    setItem(key, nextValue) {
      this.saved.set(key, nextValue);
    }
  };
}

test("loadSettings returns a parsed settings object", () => {
  assert.deepEqual(loadSettings(storageWithValue('{"drawerPinned":true,"view":"tree"}')), {
    drawerPinned: true,
    view: "tree"
  });
});

test("loadSettings rejects null, primitive, array, and malformed JSON values", () => {
  assert.deepEqual(loadSettings(storageWithValue("null")), {});
  assert.deepEqual(loadSettings(storageWithValue('"tree"')), {});
  assert.deepEqual(loadSettings(storageWithValue("[1,2,3]")), {});
  assert.deepEqual(loadSettings(storageWithValue("{nope")), {});
});

test("saveSettings serializes settings under the shared key", () => {
  const storage = storageWithValue(null);
  saveSettings({ drawerPinned: false }, storage);
  assert.equal(storage.getItem(SETTINGS_KEY), '{"drawerPinned":false}');
});
