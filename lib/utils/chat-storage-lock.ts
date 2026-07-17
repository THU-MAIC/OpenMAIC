const CHAT_STORAGE_GLOBAL_LOCK = 'openmaic:chat-storage:all';
const DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS = 5_000;
type FallbackLockMode = 'shared' | 'exclusive';
interface FallbackLockWaiter {
  mode: FallbackLockMode;
  start(): void;
}

const fallbackWaiters: FallbackLockWaiter[] = [];
let fallbackReaders = 0;
let fallbackWriter = false;

export function chatStoragePartitionLockName(key: string): string {
  const name = `openmaic:chat-storage:${encodeURIComponent(key)}`;
  return name === CHAT_STORAGE_GLOBAL_LOCK ? `${name}:partition` : name;
}

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

function pumpFallbackLocks(): void {
  if (fallbackWriter || fallbackWaiters.length === 0) return;
  if (fallbackWaiters[0]!.mode === 'exclusive') {
    if (fallbackReaders === 0) fallbackWaiters.shift()!.start();
    return;
  }
  while (fallbackWaiters[0]?.mode === 'shared' && !fallbackWriter) {
    fallbackWaiters.shift()!.start();
  }
}

function withFallbackRuntimeLock<T>(
  mode: FallbackLockMode,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const waiter: FallbackLockWaiter = {
      mode,
      start() {
        started = true;
        signal?.removeEventListener('abort', onAbort);
        if (mode === 'shared') fallbackReaders += 1;
        else fallbackWriter = true;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            if (mode === 'shared') fallbackReaders -= 1;
            else fallbackWriter = false;
            pumpFallbackLocks();
          });
      },
    };
    const onAbort = (): void => {
      if (started) return;
      const index = fallbackWaiters.indexOf(waiter);
      if (index >= 0) fallbackWaiters.splice(index, 1);
      reject(signal?.reason);
      pumpFallbackLocks();
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    fallbackWaiters.push(waiter);
    pumpFallbackLocks();
  });
}

/** Let runtime writers run together while excluding whole-store maintenance. */
export async function withRuntimeStorageSharedLock<T>(work: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (manager) {
    return manager.request(CHAT_STORAGE_GLOBAL_LOCK, { mode: 'shared' }, work);
  }
  return typeof window === 'undefined' ? work() : withFallbackRuntimeLock('shared', work);
}

/**
 * Bound caller wait time without cancelling the protected work. The shared
 * lock remains held until `work` really settles, so late storage writes cannot
 * resume after destructive maintenance has overtaken them.
 */
export async function withRuntimeStorageSharedLockUntilSettled<T>(
  work: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const protectedWork = withRuntimeStorageSharedLock(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      protectedWork,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RuntimeStorageExclusiveLockOptions {
  acquireTimeoutMs?: number;
}

export class RuntimeStorageLockAcquisitionTimeoutError extends Error {}

/** Quiesce runtime mutations before destructive whole-store work. */
export function withRuntimeStorageExclusiveLock<T>(
  work: () => Promise<T>,
  options: RuntimeStorageExclusiveLockOptions = {},
): Promise<T> {
  const manager = locks();
  if (!manager && typeof window === 'undefined') {
    return work();
  }

  const configuredTimeout = options.acquireTimeoutMs ?? DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS;
  const acquireTimeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_EXCLUSIVE_ACQUIRE_TIMEOUT_MS;
  let acquired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeoutError = new RuntimeStorageLockAcquisitionTimeoutError(
    `Timed out acquiring the runtime maintenance lock after ${acquireTimeoutMs}ms`,
  );
  const guardedWork = async (): Promise<T> => {
    acquired = true;
    clearTimeout(timer);
    return work();
  };
  // Cross-realm exclusion is impossible without Web Locks. The fallback still
  // coordinates every writer in this realm and preserves the pre-cutover
  // ability to perform an explicit whole-database clear.
  const request = manager
    ? manager.request(CHAT_STORAGE_GLOBAL_LOCK, { signal: controller.signal }, guardedWork)
    : withFallbackRuntimeLock('exclusive', guardedWork, controller.signal);

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (acquired) return;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, acquireTimeoutMs);
    void request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Let a bounded public operation finish while retaining the exclusive lock
 * until its underlying destructive work actually settles. `releaseCaller`
 * may be invoked once the caller-visible safety budget has elapsed; the lock
 * remains owned until `work` itself returns.
 */
export function withRuntimeStorageExclusiveLockUntilSettled<T>(
  work: (releaseCaller: (value: T) => void) => Promise<T>,
  options: RuntimeStorageExclusiveLockOptions = {},
): Promise<T> {
  let callerSettled = false;
  let resolveCaller!: (value: T) => void;
  let rejectCaller!: (reason?: unknown) => void;
  const caller = new Promise<T>((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });
  const releaseCaller = (value: T): void => {
    if (callerSettled) return;
    callerSettled = true;
    resolveCaller(value);
  };
  const protectedWork = withRuntimeStorageExclusiveLock(async () => {
    try {
      const value = await work(releaseCaller);
      releaseCaller(value);
      return value;
    } catch (error) {
      if (!callerSettled) {
        callerSettled = true;
        rejectCaller(error);
      }
      throw error;
    }
  }, options);
  void protectedWork.catch((error) => {
    if (!callerSettled) {
      callerSettled = true;
      rejectCaller(error);
    }
  });
  return caller;
}

/** Compatibility aliases for the chat cutover's partitioned writers. */
export const withChatStorageSharedLock = withRuntimeStorageSharedLock;
export const withChatStorageExclusiveLock = withRuntimeStorageExclusiveLock;
