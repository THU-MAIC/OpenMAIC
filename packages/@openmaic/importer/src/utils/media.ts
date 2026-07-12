/**
 * Media utilities — MIME type detection, path resolution, and blob URL management.
 */

/**
 * Determine MIME type from file extension.
 * Covers images, video, and audio formats used in PPTX files.
 */
export function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    emf: 'image/x-emf',
    wmf: 'image/x-wmf',
    webp: 'image/webp',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Resolve a relative media path (from rels) to its canonical path in PptxFiles.media.
 * Rels targets are relative like "../media/image1.png".
 * Media paths in PptxFiles are like "ppt/media/image1.png".
 */
export function resolveMediaPath(target: string): string {
  const fileName = target.split('/').pop() || '';
  return `ppt/media/${fileName}`;
}

/**
 * Get or create a blob URL for a media file, using a cache to avoid duplicates.
 *
 * @param mediaPath - Canonical path (e.g. "ppt/media/image1.png")
 * @param data - Raw media data (Uint8Array or ArrayBuffer)
 * @param cache - Map to store/retrieve cached blob URLs
 * @returns The blob URL string
 */
export function getOrCreateBlobUrl(
  mediaPath: string,
  data: Uint8Array | ArrayBuffer,
  cache: Map<string, string>,
): string {
  let url = cache.get(mediaPath);
  if (!url) {
    const mime = getMimeType(mediaPath);
    const blob = new Blob([data as unknown as BlobPart], { type: mime });
    url = URL.createObjectURL(blob);
    cache.set(mediaPath, url);
  }
  return url;
}

/**
 * Build a data URL string from raw base64 and MIME.
 */
export function toDataUrl(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}
