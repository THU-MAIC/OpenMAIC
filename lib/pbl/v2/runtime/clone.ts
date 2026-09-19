export function clone<T>(value: T): T {
  return structuredClone(value);
}
