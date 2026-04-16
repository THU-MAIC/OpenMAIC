/**
 * Vercel Blob Storage adapter.
 *
 * Provides persistent key-value JSON storage that works across serverless
 * function invocations. Falls back to filesystem when BLOB_READ_WRITE_TOKEN
 * is not configured (local development).
 */

import { put, list, del } from '@vercel/blob';
import { createLogger } from '@/lib/logger';

const log = createLogger('BlobStore');

/** True when Vercel Blob is configured (production). */
export const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Write a JSON object to blob storage.
 * Uses `addRandomSuffix: false` so the path is deterministic and overwritable.
 */
export async function writeJsonBlob(key: string, data: unknown): Promise<void> {
  await put(key, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/**
 * Read a JSON object from blob storage by its key.
 * Returns null if the blob doesn't exist.
 */
export async function readJsonBlob<T>(key: string): Promise<T | null> {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    // Ensure exact match (list returns prefix matches)
    const match = blobs.find((b) => b.pathname === key);
    if (!match) return null;

    const resp = await fetch(match.downloadUrl, {
      headers: {
        authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
      },
    });
    if (!resp.ok) {
      log.warn(`Blob fetch failed for "${key}": ${resp.status}`);
      return null;
    }
    return (await resp.json()) as T;
  } catch (error) {
    log.error(`Failed to read blob "${key}":`, error);
    return null;
  }
}

/**
 * Write binary data (audio, images, video) to blob storage.
 * Uses public access so the URL can be used directly by clients.
 * Returns the public blob URL.
 */
export async function writeBinaryBlob(
  key: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const result = await put(key, data, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return result.url;
}

/**
 * Get the public URL for a binary blob, or null if it doesn't exist.
 */
export async function getBinaryBlobUrl(key: string): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    const match = blobs.find((b) => b.pathname === key);
    return match?.url ?? null;
  } catch (error) {
    log.warn(`Failed to look up blob "${key}":`, error);
    return null;
  }
}

/**
 * Delete a blob by key. Silently ignores if the blob doesn't exist.
 */
export async function deleteBlob(key: string): Promise<void> {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    const match = blobs.find((b) => b.pathname === key);
    if (match) {
      await del(match.url);
    }
  } catch (error) {
    log.warn(`Failed to delete blob "${key}":`, error);
  }
}
