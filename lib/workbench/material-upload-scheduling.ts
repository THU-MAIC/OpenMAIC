export const MAX_COMPOSER_MATERIALS = 20;
export const MATERIAL_UPLOAD_CONCURRENCY = 3;

export function canAcceptMaterialFiles(occupied: number, selected: number): boolean {
  return occupied + selected <= MAX_COMPOSER_MATERIALS;
}

/** Synchronous slot accounting shared by completed, queued, and active uploads. */
export class MaterialSlotLedger {
  occupied: number;
  pending = 0;

  constructor(initialOccupied = 0) {
    this.occupied = Math.max(0, Math.min(MAX_COMPOSER_MATERIALS, initialOccupied));
  }

  canAccept(selected: number): boolean {
    return canAcceptMaterialFiles(this.occupied, selected);
  }

  reserve(selected: number): void {
    this.occupied += selected;
    this.pending += selected;
  }

  settle(succeeded: boolean): void {
    this.pending = Math.max(0, this.pending - 1);
    if (!succeeded) this.occupied = Math.max(0, this.occupied - 1);
  }

  removeCompleted(): void {
    this.occupied = Math.max(0, this.occupied - 1);
  }

  clearCompleted(): void {
    // Queued/in-flight uploads are not cancelled and retain their reservation.
    this.occupied = this.pending;
  }
}

export interface MaterialUploadIdentityGate {
  identityEstablished: boolean;
  bootstrapTail: Promise<void>;
  queue: MaterialUploadQueue;
}

export function createMaterialUploadIdentityGate(): MaterialUploadIdentityGate {
  return {
    identityEstablished: false,
    bootstrapTail: Promise.resolve(),
    queue: new MaterialUploadQueue(MATERIAL_UPLOAD_CONCURRENCY),
  };
}

class MaterialUploadQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await task(item);
      }
    }),
  );
}

export async function retryMaterialUpload<T>(
  upload: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await upload();
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error
          ? Number((error as { status: unknown }).status)
          : 0;
      if ((status !== 429 && status !== 503) || attempt >= 2) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

/**
 * The owner cookie is HttpOnly, so the browser cannot reliably tell whether a
 * batch starts without an identity. Wait for the first successful response
 * (and therefore its Set-Cookie) before parallelising the rest. If an upload
 * fails, keep serialising until one succeeds so subsequent anonymous requests
 * cannot mint competing owners.
 */
export async function uploadFirstSuccessfulThenParallel<T>(
  items: T[],
  upload: (item: T) => Promise<boolean>,
  onIdentityEstablished: () => void = () => undefined,
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    if (await upload(items[index])) {
      onIdentityEstablished();
      await mapWithConcurrency(items.slice(index + 1), MATERIAL_UPLOAD_CONCURRENCY, upload);
      return;
    }
  }
}

/**
 * Queue batches only until one successful response establishes the HttpOnly
 * owner cookie. Later batches enter the shared three-request queue directly.
 */
export function scheduleMaterialUploadBatch<T>(
  gate: MaterialUploadIdentityGate,
  items: T[],
  upload: (item: T) => Promise<boolean>,
): Promise<void> {
  const queuedUpload = (item: T) => gate.queue.run(() => upload(item));
  const run = async () => {
    if (gate.identityEstablished) {
      await Promise.all(items.map(queuedUpload));
      return;
    }
    await uploadFirstSuccessfulThenParallel(items, queuedUpload, () => {
      gate.identityEstablished = true;
    });
  };

  if (gate.identityEstablished) return run();
  const scheduled = gate.bootstrapTail.then(run);
  gate.bootstrapTail = scheduled.catch(() => undefined);
  return scheduled;
}
