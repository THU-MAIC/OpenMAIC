/**
 * What every host hook registry (`lib/server/persistence-hooks`,
 * `lib/server/generation-run-hooks`) checks a registration with: a misspelled
 * hook is refused rather than silently never called, and every hook is read
 * once and bound to the object the host passed.
 */

export function assertServer(entryPoint: string): void {
  if (typeof window !== 'undefined') throw new Error(`${entryPoint} is server-only`);
}

export function isOptionalFunction(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

/** Levenshtein distance, for the "did you mean" hint. Keys are short. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The first key of `target` that is not a known key, if any.
 *
 * Every hook is optional, so a misspelled one (`authorizeCreat`) would
 * otherwise register cleanly and never run -- for a gate, a silent bypass.
 *
 * - A plain object may carry nothing but known keys.
 * - A class instance legitimately carries state, so only its function-valued
 *   properties are checked: its own and those of its prototype chain up to
 *   `Object.prototype`, excluding `constructor`. A helper method is
 *   indistinguishable from a misspelled hook, so a host class must keep
 *   helpers private (`#helper`), non-function, or pass a plain object.
 */
export function unknownKey(target: object, known: readonly string[]): string | undefined {
  const knownKeys = new Set(known);
  const prototype: unknown = Object.getPrototypeOf(target);
  if (prototype === Object.prototype || prototype === null) {
    return Object.keys(target).find((key) => !knownKeys.has(key));
  }
  for (
    let level: object | null = target;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (key === 'constructor' || knownKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(level, key);
      if (typeof descriptor?.value === 'function') return key;
    }
  }
  return undefined;
}

export function unknownKeyMessage(key: string, known: readonly string[], kind: string): string {
  const suggestion = known.find((candidate) => editDistance(key, candidate) <= 2);
  return (
    `does not know the ${kind} ${JSON.stringify(key)}` +
    (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : '') +
    '. A host class must keep helper methods private (#method) or non-function, ' +
    'or register a plain object.'
  );
}

/**
 * A method of `owner`, bound to it, or `undefined`. Read once, through normal
 * property access, so a hook defined on a class prototype -- or as a
 * non-enumerable property -- is kept: copying with `{ ...owner }` takes only
 * own enumerable properties and would silently drop it, and with it a gate.
 */
export function boundMethod<T>(owner: object, value: unknown): T | undefined {
  return typeof value === 'function' ? (value.bind(owner) as T) : undefined;
}
