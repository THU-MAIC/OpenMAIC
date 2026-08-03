/**
 * Shared payload guard for JSON-carrying backends (HTTP transport, Postgres
 * JSONB). The browser backend persists payloads via structured clone, which
 * preserves values JSON cannot represent (Map, Set, Date, NaN, negative zero,
 * nested undefined, bigint, symbol-keyed or non-enumerable properties). A JSON
 * backend that accepted those would silently hand back different data on the
 * next read — appendRecord's return value and a later listRecords would
 * disagree. JSON backends therefore narrow the accepted payload domain and
 * fail loud at the write boundary.
 *
 * The narrowing is exactly "survives JSON.stringify/JSON.parse losslessly":
 * characters that round-trip through JSON (including U+2028/U+2029, legal in
 * JSON strings per RFC 8259) are accepted. Two string exceptions — applied to
 * object keys as well as values — keep the payload domain identical across
 * JSON backends rather than letting one accept what another must refuse: the
 * NUL code point (U+0000), which Postgres jsonb cannot store (error 22P05),
 * and unpaired UTF-16 surrogates, which jsonb rejects (22P02) and which other
 * JSON stacks silently replace with U+FFFD.
 */

interface NonJsonValue {
  pointer: string;
  reason: string;
}

function isPlainPrototype(value: object): boolean {
  // Realm-agnostic: a plain object's chain is value -> (some realm's)
  // Object.prototype -> null, or value -> null for null-proto objects.
  // Identity against this realm's Object.prototype would reject ordinary
  // objects from another realm (vm, iframe), which JSON round-trips fine.
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function isCanonicalIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

// In u-mode a surrogate pair is consumed as one astral code point, so this
// class matches exactly the unpaired surrogates.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function definesToJson(value: object): boolean {
  // Mirror JSON.stringify exactly: it reads the own-most 'toJSON' and only
  // invokes it when callable. A non-callable data value shadows anything
  // above it and is an ordinary member, so it is safe; an accessor cannot be
  // inspected without invoking it, so it is rejected outright.
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON');
    if (descriptor !== undefined) {
      if ('value' in descriptor) return typeof descriptor.value === 'function';
      return true;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function findNonJsonString(value: string, pointer: string): NonJsonValue | undefined {
  if (value.includes('\u0000')) {
    return { pointer, reason: 'string contains the NUL code point (\\u0000)' };
  }
  if (LONE_SURROGATE.test(value)) {
    return { pointer, reason: 'string contains an unpaired UTF-16 surrogate' };
  }
  return undefined;
}

/**
 * True when `value` contains neither of the two string exceptions above.
 * SQL backends also use this to decide that a lookup key can never match a
 * stored row (the write gate provably refuses such keys), so this predicate
 * and the write-side string rule must stay coupled — hence the shared export.
 */
export function isLosslessJsonString(value: string): boolean {
  return findNonJsonString(value, '') === undefined;
}

function findNonJsonValue(
  value: unknown,
  pointer: string,
  seen: Set<object>,
): NonJsonValue | undefined {
  if (value === null || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return { pointer, reason: 'negative zero (JSON serializes it as 0)' };
    }
    if (Number.isFinite(value)) return undefined;
    return { pointer, reason: `non-finite number ${String(value)}` };
  }
  if (typeof value === 'string') {
    return findNonJsonString(value, pointer);
  }
  if (typeof value !== 'object') {
    return { pointer, reason: `${typeof value} is not a JSON value` };
  }
  if (seen.has(value)) return { pointer, reason: 'circular reference' };
  // toJSON is the one channel through which a prototype can alter JSON output
  // (prototype properties themselves never serialize, and own accessors are
  // rejected below), so refusing it closes prototype influence entirely. The
  // probe walks descriptors instead of reading the property: a [[Get]] would
  // execute an inherited accessor, letting a stateful getter hide from the
  // check and reappear at stringify time. Mutating the object graph after
  // validation is out of scope, as it is for every other validated property.
  if (definesToJson(value)) {
    return { pointer, reason: 'value defines toJSON (would serialize differently than validated)' };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // Realm-agnostic plain-array check: a plain array's chain is
      // arr -> Array.prototype -> Object.prototype -> null. Subclasses add a
      // hop and null-proto arrays short-circuit; comparing against this
      // realm's Array.prototype identity would reject ordinary arrays from
      // another realm (vm, iframe), which JSON round-trips fine.
      const arrayProto = Object.getPrototypeOf(value) as object | null;
      const objectProto =
        arrayProto === null ? null : (Object.getPrototypeOf(arrayProto) as object | null);
      if (objectProto === null || Object.getPrototypeOf(objectProto) !== null) {
        return {
          pointer,
          reason: 'array with a non-Array prototype (subclass/null-proto) does not survive JSON',
        };
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !isCanonicalIndex(key, value.length)) {
          return {
            pointer: `${pointer}/${String(key)}`,
            reason: 'array carries a non-index own property (dropped by JSON)',
          };
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && (descriptor.get || descriptor.set)) {
          return {
            pointer: `${pointer}/${key}`,
            reason: 'accessor property (its value can change between validation and JSON)',
          };
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          return { pointer: `${pointer}/${index}`, reason: 'sparse array hole' };
        }
        const nested = findNonJsonValue(value[index], `${pointer}/${index}`, seen);
        if (nested) return nested;
      }
      return undefined;
    }
    if (!isPlainPrototype(value)) {
      return {
        pointer,
        reason: 'not a plain object (Map, Set, Date, class instances do not survive JSON)',
      };
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return { pointer, reason: 'symbol-keyed own property (dropped by JSON)' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && !descriptor.enumerable) {
        return {
          pointer: `${pointer}/${key}`,
          reason: 'non-enumerable own property (dropped by JSON)',
        };
      }
      if (descriptor && (descriptor.get || descriptor.set)) {
        return {
          pointer: `${pointer}/${key}`,
          reason: 'accessor property (its value can change between validation and JSON)',
        };
      }
      const keyIssue = findNonJsonString(key, `${pointer}/${key}`);
      if (keyIssue) {
        return { pointer: keyIssue.pointer, reason: `object key: ${keyIssue.reason}` };
      }
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) {
        return { pointer: `${pointer}/${key}`, reason: 'undefined member (dropped by JSON)' };
      }
      const nested = findNonJsonValue(member, `${pointer}/${key}`, seen);
      if (nested) return nested;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/** Throw unless `value` survives JSON serialization losslessly. */
export function assertJsonValue(value: unknown, label: string): void {
  const offender = findNonJsonValue(value, '', new Set());
  if (offender) {
    throw new Error(
      `@openmaic/storage: ${label} is not a plain JSON value at ` +
        `'${offender.pointer || '/'}': ${offender.reason}`,
    );
  }
}
