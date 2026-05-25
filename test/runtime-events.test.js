// test/runtime-events.test.js — sh-1-02 (TDD v0.5 §6.6, §6.10, §24)
//
// Note: §24 example events in the TDD use placeholder IDs (`evt_001`,
// `sess_001`). The canonical §6.10 patterns are `evt_<ULID>` and `ses_<ULID>`
// (note: §6.10 uses a 3-letter "ses_" prefix; the §24 example's "sess_001"
// is a docs-only shorthand). Tests use real ULIDs via makeRuntimeId().

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateRuntimeEvent,
  RUNTIME_EVENT_TYPES,
  runtimeEventsSchema,
} from "../hub/runtime/events.js";
import { makeRuntimeId } from "../hub/runtime/ids.js";

function baseValidSessionStarted(overrides = {}) {
  return {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T12:00:00Z",
    type: "session.started",
    source: "ui",
    workspace: "/Users/adil/.llm-tracker",
    session: {
      id: makeRuntimeId("ses"),
      name: "Phalanx reviewer",
      tier: "codex_app_server",
      projectSlug: "project-phalanx",
      taskId: "rm-semantix-alignment-intake",
    },
    ...overrides,
  };
}

test("valid session.started event passes", () => {
  const evt = baseValidSessionStarted();
  assert.equal(validateRuntimeEvent(evt), true);
});

test("schemaVersion: 2 is rejected", () => {
  const evt = baseValidSessionStarted({ schemaVersion: 2 });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /schemaVersion/i);
      assert.ok(Array.isArray(err.errors));
      return true;
    },
  );
});

test("schemaVersion: 0 is rejected", () => {
  const evt = baseValidSessionStarted({ schemaVersion: 0 });
  assert.throws(() => validateRuntimeEvent(evt), /schemaVersion|const/i);
});

test("missing schemaVersion is rejected", () => {
  const evt = baseValidSessionStarted();
  delete evt.schemaVersion;
  assert.throws(() => validateRuntimeEvent(evt), /schemaVersion|required/i);
});

test("missing id is rejected and the message names the field", () => {
  const evt = baseValidSessionStarted();
  delete evt.id;
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /id|required/i);
      return true;
    },
  );
});

test("missing ts is rejected", () => {
  const evt = baseValidSessionStarted();
  delete evt.ts;
  assert.throws(() => validateRuntimeEvent(evt), /ts|required/i);
});

test("missing type is rejected", () => {
  const evt = baseValidSessionStarted();
  delete evt.type;
  assert.throws(() => validateRuntimeEvent(evt), /type|required/i);
});

test("missing source is rejected", () => {
  const evt = baseValidSessionStarted();
  delete evt.source;
  assert.throws(() => validateRuntimeEvent(evt), /source|required/i);
});

test("missing workspace is rejected", () => {
  const evt = baseValidSessionStarted();
  delete evt.workspace;
  assert.throws(() => validateRuntimeEvent(evt), /workspace|required/i);
});

test("unknown type is rejected", () => {
  const evt = baseValidSessionStarted({ type: "session.totally_made_up" });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      // Either a const violation against a variant, or the type enum check.
      assert.ok(/type|enum|const|oneOf/i.test(err.message));
      return true;
    },
  );
});

test("unknown source is rejected", () => {
  const evt = baseValidSessionStarted({ source: "telepathy" });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /source|enum/i);
      return true;
    },
  );
});

test("bad date-time in ts is rejected", () => {
  const evt = baseValidSessionStarted({ ts: "not-a-real-date" });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /ts|date|format/i);
      return true;
    },
  );
});

test("non-evt_ id is rejected", () => {
  const evt = baseValidSessionStarted({ id: "evt_001" });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /id|pattern/i);
      return true;
    },
  );
});

test("empty idempotencyKey is rejected", () => {
  const evt = baseValidSessionStarted({ idempotencyKey: "" });
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /idempotencyKey|minLength|length/i);
      return true;
    },
  );
});

test("non-empty idempotencyKey is accepted", () => {
  const evt = baseValidSessionStarted({ idempotencyKey: "dedupe-key-123" });
  assert.equal(validateRuntimeEvent(evt), true);
});

test("session.warning with quiet_terminal warning passes", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:38:00Z",
    type: "session.warning",
    source: "system",
    workspace: "/Users/adil/.llm-tracker",
    sessionId: makeRuntimeId("ses"),
    warning: {
      kind: "quiet_terminal",
      minutes: 8,
      message: "No raw output recently; check terminal.",
    },
  };
  assert.equal(validateRuntimeEvent(evt), true);
});

test("session.started rejects bad session.tier", () => {
  const evt = baseValidSessionStarted();
  evt.session.tier = "self_aware";
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      // The picked error should call out /session/tier specifically.
      assert.match(err.message, /\/session\/tier/);
      assert.ok(err.errors.length >= 1);
      return true;
    },
  );
});

test("session.started rejects bad session.id pattern", () => {
  const evt = baseValidSessionStarted();
  evt.session.id = "sess_001"; // §24 example shorthand, NOT canonical §6.10
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /\/session\/id/);
      return true;
    },
  );
});

test("repo.change event passes with §24-shaped payload", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:44:00Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/Users/adil/.llm-tracker",
    projectSlug: "project-phalanx",
    repoRoot: "/Users/adil/Documents/dev/Project-Phalanx",
    path: "src/auth/session.ts",
    event: "change",
    activeSessionIds: [makeRuntimeId("ses"), makeRuntimeId("ses")],
    possibleSessionIds: [makeRuntimeId("ses")],
    attribution: "ambiguous",
    relatedTaskIds: ["task_a", "task_b"],
  };
  assert.equal(validateRuntimeEvent(evt), true);
});

test("repo.change with bad attribution is rejected", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:44:00Z",
    type: "repo.change",
    source: "watcher",
    workspace: "/Users/adil/.llm-tracker",
    projectSlug: "project-phalanx",
    repoRoot: "/Users/adil/Documents/dev/Project-Phalanx",
    path: "src/auth/session.ts",
    event: "change",
    activeSessionIds: [],
    possibleSessionIds: [],
    attribution: "totally_made_up",
    relatedTaskIds: [],
  };
  assert.throws(() => validateRuntimeEvent(evt), /attribution|enum/i);
});

test("skill.run.finished §24 example passes (with canonical IDs)", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:42:00Z",
    type: "skill.run.finished",
    source: "mcp",
    workspace: "/Users/adil/.llm-tracker",
    jobId: makeRuntimeId("job"),
    sessionId: makeRuntimeId("ses"),
    skillId: "lt.verify",
    status: "succeeded",
    summary: "Verify pack satisfied; tests passed.",
  };
  assert.equal(validateRuntimeEvent(evt), true);
});

test("job.unblocked validates as a strict JobUnblockedEvent", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:43:00Z",
    type: "job.unblocked",
    source: "http",
    workspace: "/Users/adil/.llm-tracker",
    jobId: makeRuntimeId("job"),
    sessionId: makeRuntimeId("ses"),
    previousReason: "blocked_on_dep",
    reason: "manual override",
    user: "u_alice",
  };
  assert.equal(validateRuntimeEvent(evt), true);
});

test("job.unblocked rejects missing sessionId", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T16:43:00Z",
    type: "job.unblocked",
    source: "http",
    workspace: "/Users/adil/.llm-tracker",
    jobId: makeRuntimeId("job"),
  };
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /sessionId|required/i);
      return true;
    },
  );
});

test("generic event with known type but unspecified payload still validates against base", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T12:00:00Z",
    type: "attention.ack",
    source: "ui",
    workspace: "/Users/adil/.llm-tracker",
    // No strict variant exists yet; GenericRuntimeEvent accepts arbitrary extra keys.
    attentionId: makeRuntimeId("att"),
    reason: "manually acknowledged by adi",
  };
  assert.equal(validateRuntimeEvent(evt), true);
});

test("generic event with unknown type is still rejected", () => {
  const evt = {
    schemaVersion: 1,
    id: makeRuntimeId("evt"),
    ts: "2026-05-23T12:00:00Z",
    type: "this.type.does.not.exist",
    source: "ui",
    workspace: "/Users/adil/.llm-tracker",
  };
  assert.throws(() => validateRuntimeEvent(evt));
});

test("RUNTIME_EVENT_TYPES set equals the schema's base type enum", () => {
  const schemaEnum = runtimeEventsSchema.definitions.runtimeEventType.enum;
  assert.deepEqual(new Set(RUNTIME_EVENT_TYPES), new Set(schemaEnum));
  assert.equal(RUNTIME_EVENT_TYPES.length, schemaEnum.length);
});

test("RUNTIME_EVENT_TYPES is frozen", () => {
  assert.ok(Object.isFrozen(RUNTIME_EVENT_TYPES));
});

test("thrown error has .errors and .event attached", () => {
  const evt = baseValidSessionStarted({ schemaVersion: 99 });
  let caught = null;
  try {
    validateRuntimeEvent(evt);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected throw");
  assert.ok(Array.isArray(caught.errors), ".errors should be an array");
  assert.ok(caught.errors.length >= 1);
  assert.equal(caught.event, evt);
});

test("multiple violations produce 'plus N more' suffix", () => {
  // Multiple field violations against the session.started variant: missing
  // required `session` payload, bad `source`, and bad `id` pattern.
  const evt = {
    schemaVersion: 1,
    id: "evt_001", // bad pattern
    ts: "2026-05-23T12:00:00Z",
    type: "session.started",
    source: "telepathy", // bad enum
    workspace: "/Users/adil/.llm-tracker",
    // session entirely missing
  };
  assert.throws(
    () => validateRuntimeEvent(evt),
    (err) => {
      assert.match(err.message, /plus \d+ more/);
      assert.ok(err.errors.length >= 2);
      return true;
    },
  );
});
