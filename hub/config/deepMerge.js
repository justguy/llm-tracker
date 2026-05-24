// Deep merge with array-replace semantics. Used to layer workspace-config
// overrides on top of the §25 defaults — and to layer flag/env/file sources
// on top of each other in declared precedence order.
//
// Rules:
//   - plain objects are merged key-by-key, recursively
//   - arrays REPLACE wholesale (not concatenated). The TDD calls out lists
//     like `watcher.ignore` as user-replaceable; concatenation would surprise.
//   - scalars and null on the overlay always win
//   - undefined in the overlay leaves the base value untouched (this is how
//     "later sources only fill in unspecified keys" gets enforced when the
//     loader feeds sources in priority order)
//
// Both inputs are left untouched; the result is a fresh object tree.

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepMerge(base, overlay) {
  if (overlay === undefined) return base === undefined ? undefined : structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    // Overlay wins (arrays replace, scalars replace, null replaces).
    return overlay === undefined ? structuredClone(base) : structuredClone(overlay);
  }
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
  for (const key of keys) {
    const b = base[key];
    const o = overlay[key];
    if (o === undefined) {
      out[key] = structuredClone(b);
      continue;
    }
    if (isPlainObject(b) && isPlainObject(o)) {
      out[key] = deepMerge(b, o);
    } else {
      out[key] = structuredClone(o);
    }
  }
  return out;
}

export function appliedKeys(base, overlay) {
  // Returns the dotted paths in `overlay` that actually differ from `base`.
  // Used by the loader to populate `sources[].appliedKeys` so callers can
  // see which keys each source contributed to the resolved config.
  const out = [];
  walk(base, overlay, "", out);
  return out;
}

function walk(base, overlay, prefix, out) {
  if (overlay === undefined) return;
  if (!isPlainObject(overlay)) {
    if (!deepEqual(base, overlay)) out.push(prefix || "/");
    return;
  }
  if (!isPlainObject(base)) {
    for (const key of Object.keys(overlay)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
    }
    return;
  }
  for (const key of Object.keys(overlay)) {
    const path = prefix ? `${prefix}.${key}` : key;
    walk(base[key], overlay[key], path, out);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (!deepEqual(a[k], b[k])) return false;
  return true;
}
