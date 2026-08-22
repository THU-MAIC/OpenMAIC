export type ArchiveMediaKind = 'image' | 'video' | 'audio';

export interface ArchiveMediaDescriptor {
  extension: string;
  mimeType: string;
}

const DEFAULT_BY_KIND: Readonly<Record<ArchiveMediaKind, ArchiveMediaDescriptor>> = {
  image: { extension: 'jpg', mimeType: 'image/jpeg' },
  video: { extension: 'mp4', mimeType: 'video/mp4' },
  audio: { extension: 'mp3', mimeType: 'audio/mpeg' },
};

const MIME_BY_EXTENSION: Readonly<Record<ArchiveMediaKind, Readonly<Record<string, string>>>> = {
  image: {
    avif: 'image/avif',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  },
  video: {
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    ogv: 'video/ogg',
    webm: 'video/webm',
  },
  audio: {
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/x-m4a',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    mpeg: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
    webm: 'audio/webm',
  },
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mpeg',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

/**
 * Normalize untrusted archive metadata against the authoritative media kind.
 * The returned extension and MIME are one inseparable pair: a valid hint must
 * belong to the kind's allowlist, and every other value falls back by kind.
 *
 * This is label coherence, not byte validation. Exporters deliberately neither
 * inspect nor transcode payload bytes; like runtime and renderer consumers, they
 * trust the authoritative kind metadata. Bytes that do not match that kind are
 * already-corrupt store state outside the archive/export contract.
 */
export function canonicalArchiveMedia(
  kind: ArchiveMediaKind,
  input: { mimeType?: string; extension?: string },
): ArchiveMediaDescriptor {
  const allowed = MIME_BY_EXTENSION[kind];
  let extension: string | undefined;

  if (typeof input.extension === 'string' && /^[a-z0-9]+$/i.test(input.extension)) {
    const candidate = input.extension.toLowerCase();
    if (allowed[candidate]) extension = candidate;
  }

  if (
    !extension &&
    typeof input.mimeType === 'string' &&
    input.mimeType === input.mimeType.toLowerCase()
  ) {
    const candidate = EXTENSION_BY_MIME[input.mimeType];
    if (candidate && allowed[candidate]) extension = candidate;
  }

  if (!extension) return DEFAULT_BY_KIND[kind];
  return { extension, mimeType: allowed[extension] };
}
