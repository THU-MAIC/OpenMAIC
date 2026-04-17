/**
 * Vercel Blob Storage adapter.
 *
 * Provides persistent key-value JSON storage that works across serverless
 * function invocations. Falls back to filesystem when BLOB_READ_WRITE_TOKEN
 * is not configured (local development).
 *
 * JSON blobs use public access so reads are plain CDN fetches — zero Advanced
 * Operations consumed. Set BLOB_PUBLIC_BASE_URL to the store's public root URL
 * (e.g. https://xxxx.public.blob.vercel-storage.com) so reads work from cold
 * starts. The URL is also auto-derived from the first put() and cached for the
 * lifetime of the function invocation.
 */

import { put, list, del } from '@vercel/blob';
import { createLogger } from '@/lib/logger';
import {
  USE_SUPABASE_STORAGE,
  supabaseWriteBinary,
  supabaseGetBinaryUrl,
} from '@/lib/server/supabase-storage';

const log = createLogger('BlobStore');

/** True when Vercel Blob is configured (production). */
export const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Public base URL of the Vercel Blob store.
 * Reads are plain CDN fetches to ${_blobPublicBase}/${key} — no Advanced Op.
 * Populated from BLOB_PUBLIC_BASE_URL env var or auto-derived on first write.
 */
let _blobPublicBase: string = process.env.BLOB_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';

/**
 * Write a JSON object to blob storage.
 * Uses public access so reads can skip list() entirely.
 */
export async function writeJsonBlob(key: string, data: unknown): Promise<void> {
  const result = await put(key, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  if (!_blobPublicBase) {
    // Derive the store base URL from the returned blob URL: everything before the key path.
    const keyPath = '/' + key;
    const idx = result.url.lastIndexOf(keyPath);
    if (idx !== -1) _blobPublicBase = result.url.slice(0, idx);
  }
}

/**
 * Read a JSON object from blob storage by its key.
 * Uses a direct CDN fetch when the store base URL is known — no Advanced
 * Operation consumed. Falls back to list() only on a cold start before any
 * write has occurred in this invocation and BLOB_PUBLIC_BASE_URL is unset.
 */
export async function readJsonBlob<T>(key: string): Promise<T | null> {
  try {
    if (_blobPublicBase) {
      const url = `${_blobPublicBase}/${key}`;
      const resp = await fetch(url, { next: { revalidate: 0 } });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        log.warn(`Blob fetch failed for "${key}": ${resp.status}`);
        return null;
      }
      return (await resp.json()) as T;
    }

    // Fallback: one list() call; caches base URL for subsequent reads.
    const { blobs } = await list({ prefix: key, limit: 1 });
    const match = blobs.find((b) => b.pathname === key);
    if (!match) return null;
    if (!_blobPublicBase && match.url) {
      const keyPath = '/' + key;
      const idx = match.url.lastIndexOf(keyPath);
      if (idx !== -1) _blobPublicBase = match.url.slice(0, idx);
    }
    const resp = await fetch(match.url);
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
  if (USE_SUPABASE_STORAGE) return supabaseWriteBinary(key, data, contentType);
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
 * Uses a direct HEAD fetch when the store base URL is known.
 */
export async function getBinaryBlobUrl(key: string): Promise<string | null> {
  if (USE_SUPABASE_STORAGE) return supabaseGetBinaryUrl(key);
  try {
    if (_blobPublicBase) {
      const url = `${_blobPublicBase}/${key}`;
      const resp = await fetch(url, { method: 'HEAD', next: { revalidate: 0 } });
      return resp.ok ? url : null;
    }
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
