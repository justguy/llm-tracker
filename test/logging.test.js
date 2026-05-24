// test/logging.test.js — coverage for hub/logging (SH-0-02, TDD v0.5 §19).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  log,
  audit,
  debug,
  setAuditSink,
  setDebugSink,
  resetSinks,
  isDebugEnabled,
} from '../hub/logging/index.js';

function captureSink() {
  const events = [];
  return { events, fn: (event) => events.push(event) };
}

test('log exposes audit() and debug() methods', () => {
  assert.equal(typeof log.audit, 'function');
  assert.equal(typeof log.debug, 'function');
  // Same references as the named exports.
  assert.equal(log.audit, audit);
  assert.equal(log.debug, debug);
});

test('log.audit emits a structured event with timestamp, source, action, subject', () => {
  const capture = captureSink();
  setAuditSink(capture.fn);
  try {
    log.audit({
      source: 'http',
      action: 'token.reject',
      subject: 'session:s-abc',
      reason: 'expired',
    });
    assert.equal(capture.events.length, 1);
    const event = capture.events[0];
    assert.equal(event.channel, 'audit');
    assert.equal(event.source, 'http');
    assert.equal(event.action, 'token.reject');
    assert.equal(event.subject, 'session:s-abc');
    assert.equal(event.reason, 'expired');
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Event object is frozen so downstream consumers can't mutate.
    assert.ok(Object.isFrozen(event));
  } finally {
    resetSinks();
  }
});

test('log.audit serializes cleanly to a single JSON line', () => {
  // Verify the default sink shape by intercepting the structured event and
  // round-tripping through JSON.stringify (the default sink does exactly that).
  const capture = captureSink();
  setAuditSink(capture.fn);
  try {
    log.audit({
      source: 'adapter',
      action: 'session.force_claim',
      subject: 'session:s-xyz',
      previousHolder: 'pid:12345',
      newHolder: 'pid:67890',
    });
    const line = JSON.stringify(capture.events[0]);
    assert.equal(line.includes('\n'), false, 'audit line must not contain newlines');
    const parsed = JSON.parse(line);
    assert.equal(parsed.action, 'session.force_claim');
    assert.equal(parsed.previousHolder, 'pid:12345');
  } finally {
    resetSinks();
  }
});

test('log.audit throws TypeError when source is missing', () => {
  assert.throws(
    () => log.audit({ action: 'token.reject', subject: 'session:s-abc' }),
    (err) => err instanceof TypeError && /source/.test(err.message),
  );
});

test('log.audit throws TypeError when action is missing', () => {
  assert.throws(
    () => log.audit({ source: 'http', subject: 'session:s-abc' }),
    (err) => err instanceof TypeError && /action/.test(err.message),
  );
});

test('log.audit throws TypeError when subject is missing', () => {
  assert.throws(
    () => log.audit({ source: 'http', action: 'token.reject' }),
    (err) => err instanceof TypeError && /subject/.test(err.message),
  );
});

test('log.audit lists every missing field in a single error', () => {
  assert.throws(
    () => log.audit({}),
    (err) =>
      err instanceof TypeError &&
      /source/.test(err.message) &&
      /action/.test(err.message) &&
      /subject/.test(err.message),
  );
});

test('log.audit rejects non-object payloads', () => {
  for (const bad of [null, undefined, 'string', 42, [], true]) {
    assert.throws(() => log.audit(bad), TypeError, `payload ${JSON.stringify(bad)}`);
  }
});

test('log.audit rejects empty-string required fields', () => {
  assert.throws(
    () => log.audit({ source: '', action: 'x', subject: 'y' }),
    (err) => err instanceof TypeError && /source/.test(err.message),
  );
});

test('log.audit ignores caller-supplied timestamp / channel (reserved fields)', () => {
  const capture = captureSink();
  setAuditSink(capture.fn);
  try {
    log.audit({
      source: 'system',
      action: 'gate.override',
      subject: 'task:t-1',
      timestamp: '1999-01-01T00:00:00.000Z',
      channel: 'spoofed',
    });
    const event = capture.events[0];
    assert.notEqual(event.timestamp, '1999-01-01T00:00:00.000Z');
    assert.equal(event.channel, 'audit');
  } finally {
    resetSinks();
  }
});

test('log.debug requires source and action (subject optional)', () => {
  const capture = captureSink();
  setDebugSink(capture.fn);
  try {
    // OK without subject:
    log.debug({ source: 'watcher', action: 'fs.event.coalesced', count: 3 });
    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].action, 'fs.event.coalesced');

    // Throws without source:
    assert.throws(
      () => log.debug({ action: 'fs.event.coalesced' }),
      (err) => err instanceof TypeError && /source/.test(err.message),
    );
    // Throws without action:
    assert.throws(
      () => log.debug({ source: 'watcher' }),
      (err) => err instanceof TypeError && /action/.test(err.message),
    );
  } finally {
    resetSinks();
  }
});

test('log.debug default sink is silent unless LLM_TRACKER_LOG_DEBUG=1 / DEBUG includes "llm-tracker"', () => {
  // Save & clear env so we can test the gate without side effects.
  const originalDebugFlag = process.env.LLM_TRACKER_LOG_DEBUG;
  const originalDebug = process.env.DEBUG;
  delete process.env.LLM_TRACKER_LOG_DEBUG;
  delete process.env.DEBUG;
  try {
    assert.equal(isDebugEnabled(), false);

    // Intercept stderr to confirm nothing is written via the default sink.
    const writes = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      // Default sink is in effect (no setDebugSink override).
      log.debug({ source: 'watcher', action: 'silent.test' });
      assert.equal(writes.length, 0, 'debug must be silent when env flag unset');

      // Now flip the env flag and try again.
      process.env.LLM_TRACKER_LOG_DEBUG = '1';
      assert.equal(isDebugEnabled(), true);
      log.debug({ source: 'watcher', action: 'loud.test' });
      assert.equal(writes.length, 1, 'debug must emit when env flag set');
      const parsed = JSON.parse(writes[0]);
      assert.equal(parsed.channel, 'debug');
      assert.equal(parsed.action, 'loud.test');

      // DEBUG env var also enables it.
      delete process.env.LLM_TRACKER_LOG_DEBUG;
      process.env.DEBUG = 'foo,llm-tracker:*';
      assert.equal(isDebugEnabled(), true);
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    if (originalDebugFlag === undefined) delete process.env.LLM_TRACKER_LOG_DEBUG;
    else process.env.LLM_TRACKER_LOG_DEBUG = originalDebugFlag;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  }
});

test('setAuditSink / setDebugSink accept null to reset, and reject non-functions', () => {
  setAuditSink(null); // should not throw
  setDebugSink(null);
  assert.throws(() => setAuditSink(42), TypeError);
  assert.throws(() => setDebugSink('nope'), TypeError);
});

test('setAuditSink test hook captures audit events without touching stderr', () => {
  const writes = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  const capture = captureSink();
  setAuditSink(capture.fn);
  try {
    log.audit({ source: 'mcp', action: 'role.escalate', subject: 'user:adi' });
    assert.equal(capture.events.length, 1);
    assert.equal(writes.length, 0, 'no stderr write when custom sink is active');
  } finally {
    process.stderr.write = originalWrite;
    resetSinks();
  }
});

test('example usage: token reject, gate override, force claim, capture toggle', () => {
  const capture = captureSink();
  setAuditSink(capture.fn);
  try {
    log.audit({
      source: 'http',
      action: 'token.reject',
      subject: 'session:s-abc',
      reason: 'expired',
    });
    log.audit({
      source: 'http',
      action: 'gate.override',
      subject: 'task:t-42',
      actor: 'user:adi',
      gate: 'requires_approval',
    });
    log.audit({
      source: 'adapter',
      action: 'session.force_claim',
      subject: 'session:s-xyz',
      previousHolder: 'pid:12345',
    });
    log.audit({
      source: 'system',
      action: 'capture.toggle',
      subject: 'session:s-xyz',
      enabled: true,
    });
    assert.equal(capture.events.length, 4);
    for (const event of capture.events) {
      assert.equal(event.channel, 'audit');
      assert.ok(event.timestamp);
      assert.ok(event.source);
      assert.ok(event.action);
      assert.ok(event.subject);
    }
  } finally {
    resetSinks();
  }
});
