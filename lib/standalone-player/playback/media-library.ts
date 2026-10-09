/**
 * Playback media of the exported document: the media table maps each key the
 * manifest names (speech `audioRef`, video `mediaRef`) to its bytes.
 *
 * Embedded bytes are base64 data blocks, decoded into a Blob URL the first
 * time a key is resolved (a narration clip when it plays, a slide video when
 * its slide renders) and cached for the session. Blob URLs (allowed by the
 * file's CSP as `media-src blob:`) are what both Chromium and WebKit play and
 * seek most reliably; long `data:` URIs are not. A `src` entry (an export that
 * ships its media next to the page) is used as is: the element loads the file
 * itself, the only way a page opened from disk may load a sibling file.
 *
 * Linked files go missing when the page is opened without them (straight from
 * inside a ZIP, or copied out alone). The library notices it, from a probe of
 * one file as the player opens (a linked clip, or else a linked slide image)
 * from any linked clip that fails to load, and from any slide image that fails
 * to load from a linked path, so the player can say so;
 * playback itself carries on without the media. A file whose codec the
 * browser cannot play fails the same way: on `file:` the two cannot be told
 * apart, so the notice covers both.
 */
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import {
  STANDALONE_MEDIA_TABLE_ELEMENT_ID,
  type StandaloneMediaTable,
} from '@/lib/export/standalone-html/contract';

export interface MediaLibrary {
  /** A playable URL for a media key, or `undefined` when the file has no bytes for it. */
  resolve(key: string | undefined): string | undefined;
  has(key: string | undefined): boolean;
  /** Release every decoded Blob URL. */
  dispose(): void;
  /** A media element failed to load `key`. Only linked files count as missing. */
  reportError(key: string | undefined): void;
  /** Whether a linked file (shipped next to the page) failed to load. */
  linkedMediaMissing(): boolean;
  /** Notified once when linked media is first found missing. */
  subscribe(listener: () => void): () => void;
  /** Load one linked file, so a missing folder shows before playback. */
  probeLinkedMedia(): void;
}

function readTable(doc: Document): StandaloneMediaTable {
  const element = doc.getElementById(STANDALONE_MEDIA_TABLE_ELEMENT_ID);
  if (!element?.textContent) return {};
  try {
    const table = JSON.parse(element.textContent) as unknown;
    return table && typeof table === 'object' ? (table as StandaloneMediaTable) : {};
  } catch {
    return {};
  }
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface MediaLibraryOptions {
  /**
   * Relative path of a slide image shipped next to the page, probed when the
   * media table links no file (an export without narration).
   */
  linkedImage?: string;
}

export function createMediaLibrary(doc: Document, options: MediaLibraryOptions = {}): MediaLibrary {
  let table: StandaloneMediaTable | null = null;
  const urls = new Map<string, string>();
  const listeners = new Set<() => void>();
  let missing = false;
  let probe: HTMLMediaElement | HTMLImageElement | null = null;
  const entryFor = (key: string) => {
    table ??= readTable(doc);
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };
  const markMissing = () => {
    if (missing) return;
    missing = true;
    for (const listener of listeners) listener();
  };
  const endProbe = () => {
    if (!probe) return;
    probe.onload = probe.onerror = null;
    if (probe instanceof HTMLMediaElement) probe.onloadedmetadata = null;
    probe.removeAttribute('src');
    probe = null;
  };

  // A slide image that fails to load from a linked relative path means the
  // folder is missing, even when the audio and video probes would have loaded
  // (the notice then covers images alone). `error` does not bubble, so the
  // listener is in the capture phase. Inline `data:`/`blob:` images are never
  // linked paths, so a single file never trips it.
  const onResourceError = (event: Event) => {
    const target = event.target;
    if (!target || target === doc) return;
    const tag = (target as Element).localName;
    if (tag !== 'img' && tag !== 'image') return;
    const src =
      (target as Element).getAttribute('src') ??
      (target as Element).getAttribute('href') ??
      (target as Element).getAttribute('xlink:href');
    if (isLinkedPath(src ?? undefined)) markMissing();
  };
  doc.addEventListener('error', onResourceError, true);

  return {
    reportError(key) {
      if (key && entryFor(key)?.src) markMissing();
    },
    linkedMediaMissing: () => missing,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    probeLinkedMedia() {
      if (probe || missing) return;
      table ??= readTable(doc);
      const onError = () => {
        endProbe();
        markMissing();
      };
      const entry = Object.values(table).find((candidate) => candidate?.src);
      if (entry?.src) {
        const element = doc.createElement(entry.mimeType?.startsWith('video/') ? 'video' : 'audio');
        probe = element;
        element.preload = 'metadata';
        element.muted = true;
        element.onloadedmetadata = endProbe;
        element.onerror = onError;
        element.src = entry.src;
      } else if (options.linkedImage) {
        const image = doc.createElement('img');
        probe = image;
        image.onload = endProbe;
        image.onerror = onError;
        image.src = options.linkedImage;
      }
    },
    has(key) {
      if (!key) return false;
      const entry = entryFor(key);
      return !!entry && !!(entry.src || (entry.embedded && doc.getElementById(entry.embedded)));
    },
    resolve(key) {
      if (!key) return undefined;
      const cached = urls.get(key);
      if (cached) return cached;
      const entry = entryFor(key);
      if (!entry) return undefined;
      if (entry.src) return entry.src;
      const block = entry.embedded ? doc.getElementById(entry.embedded) : null;
      if (!block?.textContent) return undefined;
      try {
        const blob = new Blob([decodeBase64(block.textContent)], {
          type: entry.mimeType || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      } catch {
        return undefined;
      }
    },
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      endProbe();
      doc.removeEventListener('error', onResourceError, true);
      listeners.clear();
    },
  };
}

/** Whether a slide image source is a file shipped next to the page (a relative path). */
function isLinkedPath(src: string | undefined): src is string {
  return !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('#');
}

/** The first slide image, background or poster the manifest names by relative path, if any. */
export function firstLinkedImage(scenes: readonly ManifestScene[]): string | undefined {
  for (const scene of scenes) {
    if (scene.content.type !== 'slide') continue;
    const slide = scene.content.canvas;
    if (slide.background?.type === 'image' && isLinkedPath(slide.background.image?.src)) {
      return slide.background.image.src;
    }
    for (const element of slide.elements ?? []) {
      if (element.type === 'image' && isLinkedPath(element.src)) return element.src;
      if (element.type === 'video' && isLinkedPath(element.poster)) return element.poster;
    }
  }
  return undefined;
}
