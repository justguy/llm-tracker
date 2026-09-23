// Shared primitives for v0.7 AttentionAction handlers.

export function createAttentionActionHandler(config) {
  const {
    kind,
    eventType,
    required = [],
    requiredOptions = [],
    capability,
    permission,
    buildEvent,
  } = config || {};
  if (!kind || typeof kind !== "string") throw new TypeError("AttentionAction handler kind required");
  if (!eventType || typeof eventType !== "string") throw new TypeError(`${kind}: eventType required`);
  if (typeof buildEvent !== "function") throw new TypeError(`${kind}: buildEvent function required`);

  return async function handleAttentionAction(input = {}, deps = {}) {
    const item = record(input.item);
    const action = record(input.action);
    const options = record(input.options);
    const check = checkAction({ kind, item, action, options, deps, required, requiredOptions, capability, permission });
    if (!check.ok) return check;

    const event = {
      schemaVersion: 1,
      ts: isoNow(deps.now),
      type: eventType,
      source: options.source || "attention_action",
      workspace: deps.workspace || options.workspace || "",
      ...buildEvent({ item, action, options, deps }),
    };
    if (options.idempotencyKey) event.idempotencyKey = `${options.idempotencyKey}:${kind}`;

    const append = deps.runtimeStore?.append;
    if (typeof append !== "function") {
      return disabled(kind, "runtimeStore.append unavailable", { event });
    }
    const result = await append.call(deps.runtimeStore, event);
    return {
      ok: true,
      enabled: true,
      kind,
      event,
      eventId: result?.eventId || event.id || null,
      evidenceRef: result?.eventId || event.id || null,
      rev: Number.isInteger(result?.rev) ? result.rev : null,
    };
  };
}

function checkAction({ kind, item, action, options, deps, required, requiredOptions, capability, permission }) {
  if (action.kind && action.kind !== kind) return disabled(kind, `handler expected ${kind}, got ${action.kind}`);
  if (action.enabled === false) return disabled(kind, action.disabledReason || "Action disabled");
  const missing = [];
  for (const field of required) {
    if (!nonEmptyString(item[field]) && !nonEmptyString(action[field]) && !nonEmptyString(options[field])) {
      missing.push(field);
    }
  }
  for (const field of requiredOptions) {
    if (!nonEmptyString(options[field])) missing.push(`options.${field}`);
  }
  if (missing.length > 0) return disabled(kind, `Requires ${missing.join(", ")}`, { missing });
  if (permission && !hasPermission(permission, options, deps)) {
    return disabled(kind, `Permission '${permission}' required`, { permission });
  }
  if (capability && !hasCapability(capability, item, action, options, deps)) {
    return disabled(kind, `Provider capability '${capability}' required`, {
      capability,
      disabledReason: `Provider capability '${capability}' required`,
    });
  }
  return { ok: true, enabled: true, kind };
}

function hasPermission(permission, options, deps) {
  const permissions = options.permissions || deps.permissions;
  if (permissions === true) return true;
  if (Array.isArray(permissions)) return permissions.includes(permission);
  if (permissions && typeof permissions === "object") return permissions[permission] === true;
  return true;
}

function hasCapability(capability, item, action, options, deps) {
  const candidates = [
    action.providerCapabilities,
    item.providerCapabilities,
    options.providerCapabilities,
    deps.providerCapabilities,
  ];
  for (const caps of candidates) {
    if (caps && typeof caps === "object" && caps[capability] === true) return true;
  }
  return false;
}

export function disabled(kind, disabledReason, extra = {}) {
  return {
    ok: false,
    enabled: false,
    kind,
    disabledReason,
    ...extra,
  };
}

export function value(input, field, fallback = undefined) {
  const { item, action, options } = input;
  return firstString(options?.[field], action?.[field], item?.[field], fallback);
}

export function firstString(...values) {
  for (const candidate of values) {
    if (nonEmptyString(candidate)) return candidate;
  }
  return undefined;
}

export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isoNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return new Date().toISOString();
}
