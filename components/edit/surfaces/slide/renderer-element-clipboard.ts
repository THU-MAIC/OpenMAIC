import type { PPTElement } from '@openmaic/dsl';

const CLIPBOARD_KIND = 'openmaic/renderer-elements';
const CLIPBOARD_VERSION = 1;

interface RendererElementClipboardPayload {
  readonly kind: typeof CLIPBOARD_KIND;
  readonly version: typeof CLIPBOARD_VERSION;
  readonly elements: PPTElement[];
}

export interface RendererElementClipboard {
  write(elements: readonly PPTElement[]): Promise<boolean>;
  read(): Promise<PPTElement[] | null>;
}

function cloneElements(elements: readonly PPTElement[]): PPTElement[] {
  return JSON.parse(JSON.stringify(elements)) as PPTElement[];
}

function parsePayload(value: string): PPTElement[] | null {
  try {
    const payload = JSON.parse(value) as Partial<RendererElementClipboardPayload>;
    if (
      payload.kind !== CLIPBOARD_KIND ||
      payload.version !== CLIPBOARD_VERSION ||
      !Array.isArray(payload.elements) ||
      payload.elements.some(
        (element) =>
          !element ||
          typeof element !== 'object' ||
          typeof element.id !== 'string' ||
          typeof element.type !== 'string',
      )
    ) {
      return null;
    }
    return cloneElements(payload.elements as PPTElement[]);
  } catch {
    return null;
  }
}

/** Browser clipboard with a session-local fallback for denied permissions. */
export function createRendererElementClipboard(): RendererElementClipboard {
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
      } satisfies RendererElementClipboardPayload);
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
        const copied = parsePayload(await navigator.clipboard.readText());
        return copied;
      } catch {
        return fallback ? cloneElements(fallback) : null;
      }
    },
  };
}

export interface RendererClipboardPasteState {
  payloadKey: string | null;
  count: number;
}

export function createRendererClipboardPasteState(): RendererClipboardPasteState {
  return { payloadKey: null, count: 0 };
}
