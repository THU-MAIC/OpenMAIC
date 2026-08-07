import type { PPTElement } from '@openmaic/dsl';
import { isValidEditorElement } from '../core';

const CLIPBOARD_KIND = 'openmaic/editor-elements';
const LEGACY_CLIPBOARD_KIND = 'openmaic/renderer-elements';
const CLIPBOARD_VERSION = 1;

interface ElementClipboardPayload {
  readonly kind: typeof CLIPBOARD_KIND | typeof LEGACY_CLIPBOARD_KIND;
  readonly version: typeof CLIPBOARD_VERSION;
  readonly elements: PPTElement[];
}

export interface ElementClipboard {
  write(elements: readonly PPTElement[]): Promise<boolean>;
  read(): Promise<PPTElement[] | null>;
}

export interface ClipboardPasteState {
  payloadKey: string | null;
  count: number;
}

function cloneElements(elements: readonly PPTElement[]): PPTElement[] {
  return JSON.parse(JSON.stringify(elements)) as PPTElement[];
}

export function parseElementClipboardPayload(value: string): PPTElement[] | null {
  try {
    const payload = JSON.parse(value) as Partial<ElementClipboardPayload>;
    if (
      (payload.kind !== CLIPBOARD_KIND && payload.kind !== LEGACY_CLIPBOARD_KIND) ||
      payload.version !== CLIPBOARD_VERSION ||
      !Array.isArray(payload.elements) ||
      payload.elements.some((element) => !isValidEditorElement(element))
    ) {
      return null;
    }
    return cloneElements(payload.elements as PPTElement[]);
  } catch {
    return null;
  }
}

/** Browser clipboard with a session-local fallback for denied permissions. */
export function createElementClipboard(): ElementClipboard {
  let fallback: PPTElement[] | null = null;

  return {
    async write(elements) {
      if (elements.length === 0) return false;
      const copied = cloneElements(elements);
      fallback = copied;
      const payload = JSON.stringify({
        kind: CLIPBOARD_KIND,
        version: CLIPBOARD_VERSION,
        elements: copied,
      } satisfies ElementClipboardPayload);
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return true;
      try {
        await navigator.clipboard.writeText(payload);
      } catch {
        // The in-memory copy remains usable when the browser denies access.
      }
      return true;
    },

    async read() {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
        return fallback ? cloneElements(fallback) : null;
      }
      try {
        return parseElementClipboardPayload(await navigator.clipboard.readText());
      } catch {
        return fallback ? cloneElements(fallback) : null;
      }
    },
  };
}

export function createClipboardPasteState(): ClipboardPasteState {
  return { payloadKey: null, count: 0 };
}
