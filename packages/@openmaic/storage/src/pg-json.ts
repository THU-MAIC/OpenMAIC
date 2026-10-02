/**
 * Shared encoding boundary for every PostgreSQL JSONB parameter written by the
 * storage backends. JSON.stringify emits two escape families that PostgreSQL
 * jsonb refuses, aborting the whole statement (and, for an agent session, the
 * whole run):
 *
 *  - U+0000, serialized as `\u0000`   -> SQLSTATE 22P05
 *  - a lone UTF-16 surrogate (`\udXXX`) -> SQLSTATE 22P02
 *
 * Both are replaced with U+FFFD before the value reaches a jsonb parameter.
 * Valid surrogate pairs (emoji) are legal and must survive.
 *
 * Sanitizing the *serialized* text is unsafe: a literal `\ud800` in the content
 * is emitted as `\\ud800`, so any regex or scanner that does not pair backslash
 * escapes would rewrite it and produce invalid JSON. Instead the replacement
 * runs on the in-memory values and object keys before `JSON.stringify`. A
 * replacer cannot see object keys, so an object whose keys contain an offender
 * is rebuilt explicitly; values are otherwise serialized exactly as before.
 *
 * Two distinct keys can sanitize to the same string (for example `"a\u0000"`
 * and `"a\uFFFD"` both become `"a\uFFFD"`). Emitting both members under that
 * one key would silently drop one, so a later colliding member is emitted under
 * a deterministic disambiguated key instead.
 */

const REPLACEMENT = '\uFFFD';

/**
 * Disambiguation for two members whose sanitized keys collide. The first member
 * keeps the plain sanitized key; each later colliding member gets `#2`, `#3`,
 * ... appended to that key until the result is unique among the keys emitted so
 * far (whether a prior key was sanitized or already collision-free). The
 * separator is ASCII `#` followed by an ordinal: it contains no NUL or
 * surrogate, and the sanitizer alone can only ever emit U+FFFD, never `#`, so a
 * suffixed key cannot be confused with a bare replacement result. Member order
 * is preserved.
 */
const KEY_COLLISION_SEPARATOR = '#';

/**
 * Replace every U+0000 and unpaired UTF-16 surrogate code unit with U+FFFD.
 * Returns the input unchanged when it contains no offender, so the common case
 * allocates nothing and JSON output stays byte-identical.
 */
export function sanitizeJsonString(value: string): string {
  let result = '';
  let last = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A valid pair is one astral code point: keep both code units.
        index += 1;
        continue;
      }
    }
    if (code !== 0x0000 && !isHighSurrogate && !isLowSurrogate) continue;
    result += value.slice(last, index) + REPLACEMENT;
    last = index + 1;
  }
  return last === 0 ? value : result + value.slice(last);
}

/**
 * `JSON.stringify` replacer: sanitize string values, and rebuild an object only
 * when one of its keys needs sanitizing. Arrays and all other values pass
 * through so stringify's own member/array/toJSON semantics are preserved.
 *
 * The rebuilt object has a null prototype so an own `__proto__` member stays an
 * own data property: assigning `__proto__` on a normal `{}` invokes the
 * prototype setter and drops the member from the JSON output. Colliding
 * sanitized keys are disambiguated as described on `KEY_COLLISION_SEPARATOR`.
 * Exported for direct unit testing of the fast path and disambiguation.
 */
export function sanitizeJsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return sanitizeJsonString(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  let keysChanged = false;
  const rebuilt: Record<string, unknown> = Object.create(null);
  const emitted = new Set<string>();
  for (const key of Object.keys(value)) {
    const safeKey = sanitizeJsonString(key);
    if (safeKey !== key) keysChanged = true;
    let emittedKey = safeKey;
    if (emitted.has(emittedKey)) {
      let ordinal = 2;
      do {
        emittedKey = `${safeKey}${KEY_COLLISION_SEPARATOR}${ordinal}`;
        ordinal += 1;
      } while (emitted.has(emittedKey));
    }
    emitted.add(emittedKey);
    rebuilt[emittedKey] = (value as Record<string, unknown>)[key];
  }
  return keysChanged ? rebuilt : value;
}

/**
 * Serialize `value` for a PostgreSQL JSONB parameter, sanitizing the two
 * escape families jsonb cannot store. `label` names the value in the thrown
 * error when it is not JSON-serializable.
 */
export function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value === undefined ? null : value, sanitizeJsonValue);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    return encoded;
  } catch (error) {
    throw new Error(`@openmaic/storage: ${label} is not JSON-serializable`, { cause: error });
  }
}
