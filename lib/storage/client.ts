export async function sha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload a single blob to object storage and return its CDN URL.
 *
 * The content hash dedups uploads server-side, so re-uploading the same bytes
 * is cheap and returns the same URL (makes callers idempotent). Returns `null`
 * on any failure or when storage is unconfigured — callers decide the fallback.
 */
export async function uploadBlobToStorage(
  blob: Blob,
  type: 'media' | 'audio' | 'poster',
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const hash = await sha256(blob);
    const formData = new FormData();
    formData.append('hash', hash);
    formData.append('type', type);
    formData.append('file', blob);
    const res = await fetch('/api/storage/upload', { method: 'POST', body: formData, signal });
    if (!res.ok) return null;
    const { url } = await res.json();
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}
