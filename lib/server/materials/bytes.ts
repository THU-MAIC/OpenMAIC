import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { assertPortableMaterialObjectKey } from './object-keys';

export type MaterialByteInput = Buffer | Uint8Array | Readable | ReadableStream<Uint8Array>;

export type MaterialByteStoreErrorCode =
  | 'MATERIAL_BYTE_INVALID_KEY'
  | 'MATERIAL_BYTE_WRITE_FAILED'
  | 'MATERIAL_BYTE_READ_FAILED'
  | 'MATERIAL_BYTE_DELETE_FAILED'
  | 'ENOENT';

/** Closed storage error whose public message never contains a key or local path. */
export class MaterialByteStoreError extends Error {
  override readonly name = 'MaterialByteStoreError';

  constructor(
    readonly code: MaterialByteStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MaterialByteStore {
  /** A rejected replacement must leave any previously committed object intact. */
  put(key: string, body: MaterialByteInput, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotently remove the object and any backend-owned incomplete replacement. */
  delete(key: string): Promise<void>;
  /** Optional backend capability used to reclaim crash-orphaned session objects. */
  deletePrefix?(prefix: string): Promise<void>;
}

function nodeReadable(body: MaterialByteInput): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
  return Readable.from(body);
}

function safeLocalPath(root: string, key: string): string {
  try {
    assertPortableMaterialObjectKey(key);
  } catch {
    throw new MaterialByteStoreError('MATERIAL_BYTE_INVALID_KEY', 'invalid material object key');
  }
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new MaterialByteStoreError('MATERIAL_BYTE_INVALID_KEY', 'invalid material object key');
  }
  return path;
}

function storageFailure(
  error: unknown,
  code: Exclude<MaterialByteStoreErrorCode, 'MATERIAL_BYTE_INVALID_KEY' | 'ENOENT'>,
  message: string,
): MaterialByteStoreError {
  if (error instanceof MaterialByteStoreError) return error;
  return new MaterialByteStoreError(code, message);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Local/self-hosted material byte storage, rooted under the runtime data directory. */
export class LocalMaterialByteStore implements MaterialByteStore {
  private readonly root: string;

  constructor(root: string = resolve(process.cwd(), 'data')) {
    this.root = resolve(root);
  }

  async put(key: string, body: MaterialByteInput, _mime?: string): Promise<void> {
    let pendingPath: string | undefined;
    try {
      const path = safeLocalPath(this.root, key);
      pendingPath = `${path}.pending-${randomUUID()}`;
      await mkdir(dirname(path), { recursive: true });
      await pipeline(nodeReadable(body), createWriteStream(pendingPath));
      await rename(pendingPath, path);
    } catch (error) {
      if (pendingPath) await rm(pendingPath, { force: true }).catch(() => undefined);
      throw storageFailure(error, 'MATERIAL_BYTE_WRITE_FAILED', 'material byte write failed');
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(safeLocalPath(this.root, key));
    } catch (error) {
      if (error instanceof MaterialByteStoreError) throw error;
      if (hasErrorCode(error, 'ENOENT')) {
        throw new MaterialByteStoreError('ENOENT', 'material bytes are unavailable');
      }
      throw storageFailure(error, 'MATERIAL_BYTE_READ_FAILED', 'material byte read failed');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const path = safeLocalPath(this.root, key);
      await rm(path, { force: true });
      const directory = dirname(path);
      const pendingPrefix = `${basename(path)}.pending-`;
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(pendingPrefix))
          .map((entry) => rm(resolve(directory, entry), { force: true })),
      );
    } catch (error) {
      throw storageFailure(error, 'MATERIAL_BYTE_DELETE_FAILED', 'material byte deletion failed');
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) {
      throw new MaterialByteStoreError(
        'MATERIAL_BYTE_INVALID_KEY',
        'invalid material object prefix',
      );
    }
    try {
      await rm(safeLocalPath(this.root, prefix.slice(0, -1)), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      throw storageFailure(error, 'MATERIAL_BYTE_DELETE_FAILED', 'material byte deletion failed');
    }
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
