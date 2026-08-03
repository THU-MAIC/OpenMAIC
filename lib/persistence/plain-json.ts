function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function isPlainArray(value: unknown[]): boolean {
  const arrayPrototype = Object.getPrototypeOf(value) as object | null;
  const objectPrototype =
    arrayPrototype === null ? null : (Object.getPrototypeOf(arrayPrototype) as object | null);
  return objectPrototype !== null && Object.getPrototypeOf(objectPrototype) === null;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Canonicalize app-owned values before a strict JSON persistence boundary.
 *
 * Optional object members use `undefined` naturally in application state, but
 * JSON represents their absence by omitting the member. Arrays and unusual
 * objects are deliberately not made lossy here: sparse arrays, undefined array
 * entries, accessors, Date, Map, class instances, and other non-JSON values
 * remain visible to the storage package's fail-loud validation.
 */
export function omitUndefinedObjectMembers<T>(value: T): T {
  return canonicalize(value, new WeakMap<object, object>());
}

function canonicalize<T>(value: T, seen: WeakMap<object, object>): T {
  if (value === null || typeof value !== 'object') return value;

  const prior = seen.get(value);
  if (prior) return prior as T;

  if (Array.isArray(value)) {
    if (!isPlainArray(value)) return value;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) return value;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) return value;
    }

    const copy = new Array(value.length);
    seen.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) continue;
      Object.defineProperty(copy, index, {
        ...descriptor,
        value: canonicalize(descriptor.value, seen),
      });
    }
    return copy as T;
  }

  if (!isPlainObject(value)) return value;
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string') return value;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) return value;
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, copy);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) continue;
    Object.defineProperty(copy, key, {
      ...descriptor,
      value: canonicalize(descriptor.value, seen),
    });
  }
  return copy as T;
}
