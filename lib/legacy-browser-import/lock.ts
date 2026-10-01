/**
 * The cross-tab lock the importer's runs take (Web Locks), shared by the
 * course import (`./index.ts`) and the custom agents import
 * (`./agents-import.ts`), each under its own name.
 */

/**
 * Run `work` holding the Web Lock `name`, or answer `'busy-elsewhere'` when
 * another tab holds it. Without a lock manager (`null` or `undefined`) `work`
 * runs unlocked: tabs are then not serialized.
 */
export async function withImportLock<T>(
  name: string,
  locks: LockManager | null | undefined,
  work: () => Promise<T>,
): Promise<T | 'busy-elsewhere'> {
  if (!locks) return work();
  return locks.request(name, { ifAvailable: true }, async (lock) =>
    lock ? work() : ('busy-elsewhere' as const),
  );
}

/** `navigator.locks` where the browser has it. */
export function defaultLocks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}
