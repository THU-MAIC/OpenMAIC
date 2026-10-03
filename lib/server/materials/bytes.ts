import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type MaterialByteInput = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface MaterialByteStore {
  put(key: string, body: MaterialByteInput, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

function nodeReadable(body: MaterialByteInput): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
  return Readable.from(body);
}

function safeLocalPath(root: string, key: string): string {
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`invalid material object key: ${key}`);
  }
  return path;
}

/** Local/self-hosted material byte storage, rooted under the runtime data directory. */
export class LocalMaterialByteStore implements MaterialByteStore {
  private readonly root: string;

  constructor(root: string = resolve(process.cwd(), 'data')) {
    this.root = resolve(root);
  }

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    const path = safeLocalPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(nodeReadable(body), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(safeLocalPath(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true });
  }
}

let sharedStore: MaterialByteStore | null = null;

export function getMaterialByteStore(): MaterialByteStore {
  sharedStore ??= new LocalMaterialByteStore();
  return sharedStore;
}

export function setMaterialByteStoreForTests(store: MaterialByteStore | null): void {
  sharedStore = store;
}

/**
 * The object a material's extraction result is stored in, next to its bytes
 * (`lib/server/materials/extraction.ts`): it lives and goes with them.
 */
export function materialExtractionResultKey(ossKey: string): string {
  return `${ossKey}.extraction.json`;
}

/**
 * Delete a material's objects: its bytes and its extraction result. Resolves
 * once both are gone or confirmed absent; throws to keep the material's row
 * (the pointer to them) for the next reclaim pass.
 */
export async function deleteMaterialObjects(
  store: MaterialByteStore,
  ossKey: string,
): Promise<void> {
  await store.delete(materialExtractionResultKey(ossKey));
  await store.delete(ossKey);
}
