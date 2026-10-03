import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type MaterialByteInput = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export interface MaterialByteStore {
  put(key: string, body: MaterialByteInput, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Delete every object whose key starts with `prefix` (a `/`-terminated folder). */
  deletePrefix(prefix: string): Promise<void>;
  /** The objects directly under `prefix` (a `/`-terminated folder), with when each was written. */
  list(prefix: string): Promise<Array<{ key: string; modifiedAt: number }>>;
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

  /** Written to a temporary file and renamed into place: a reader never sees a torn object. */
  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    const path = safeLocalPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await pipeline(nodeReadable(body), createWriteStream(temporary));
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(safeLocalPath(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true });
  }

  async list(prefix: string): Promise<Array<{ key: string; modifiedAt: number }>> {
    if (!prefix.endsWith('/')) throw new Error(`invalid material object prefix: ${prefix}`);
    const folder = safeLocalPath(this.root, prefix.slice(0, -1));
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const name of names) {
      const info = await stat(join(folder, name)).catch(() => null);
      if (info?.isFile()) entries.push({ key: `${prefix}${name}`, modifiedAt: info.mtimeMs });
    }
    return entries;
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) throw new Error(`invalid material object prefix: ${prefix}`);
    await rm(safeLocalPath(this.root, prefix.slice(0, -1)), { force: true, recursive: true });
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
 * Where a material's extraction results are stored, next to its bytes: one
 * immutable object per attempt (`materialExtractionResultKey`), so an attempt
 * that lost its lease can never overwrite or delete the result another
 * attempt published. They go with the material.
 */
export function materialExtractionResultPrefix(ossKey: string): string {
  return `${ossKey}.extraction/`;
}

/** The result object of one extraction attempt. */
export function materialExtractionResultKey(ossKey: string, attempt: string): string {
  return `${materialExtractionResultPrefix(ossKey)}${attempt}.json`;
}

/**
 * Delete a material's objects: its extraction results and its bytes. Resolves
 * once they are gone or confirmed absent; throws to keep the material's row
 * (the pointer to them) for the next pass.
 */
export async function deleteMaterialObjects(
  store: MaterialByteStore,
  ossKey: string,
): Promise<void> {
  await store.deletePrefix(materialExtractionResultPrefix(ossKey));
  await store.delete(ossKey);
}
