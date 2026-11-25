import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreviewActivity } from '../../scripts/sandbox-preview-activity.mjs';

/**
 * The owning workbench may ask the preview shell where one element of the application is, so
 * it can point at it from outside. Nothing else may ask, and nothing but geometry is answered.
 */
const APP_ORIGIN = 'https://app.example.com';
const getter = (key: string) => ({
  get(this: Record<string, unknown>) {
    return this[key];
  },
});
const notify = vi.fn();
const owner = { postMessage: notify };
const element = { rect: { x: 40, y: 120, width: 200, height: 48, top: 120 }, revealed: 0 };
const application = {
  root: {},
  found: element as typeof element | null,
  asked: [] as string[],
};
let message: (event: Record<string, unknown>) => void;
const ask = (data: unknown, from: Partial<{ source: unknown; origin: string; trusted: boolean }>) =>
  message({
    isTrusted: from.trusted ?? true,
    source: from.source ?? owner,
    origin: from.origin ?? APP_ORIGIN,
    data,
  });

beforeEach(() => {
  vi.useFakeTimers();
  notify.mockReset();
  element.revealed = 0;
  application.found = element;
  application.asked = [];
  vi.stubGlobal('parent', owner);
  vi.stubGlobal('location', { href: 'http://preview.localhost/__openmaic_preview' });
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('Document', {
    prototype: Object.create(null, {
      visibilityState: getter('visibilityState'),
      documentElement: getter('root'),
      querySelector: {
        value(this: typeof application, selector: string) {
          this.asked.push(selector);
          return this.found;
        },
      },
    }),
  });
  vi.stubGlobal('HTMLElement', {
    prototype: Object.create(null, {
      inert: {
        get(this: { off?: boolean }) {
          return !!this.off;
        },
        set(this: { off?: boolean }, value: boolean) {
          this.off = value;
        },
      },
    }),
  });
  vi.stubGlobal('MessageEvent', {
    prototype: Object.create(null, {
      source: getter('source'),
      origin: getter('origin'),
      data: getter('data'),
    }),
  });
  vi.stubGlobal('HTMLIFrameElement', {
    prototype: Object.create(null, { contentDocument: getter('application') }),
  });
  vi.stubGlobal('Element', {
    prototype: {
      getBoundingClientRect(this: typeof element) {
        return this.rect;
      },
      scrollIntoView(this: typeof element) {
        this.revealed++;
      },
    },
  });
  // The shell registers through the native method it captured; keep what it listens for.
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    name,
    listener,
  ) {
    if (name === 'message') message = listener as unknown as typeof message;
  });
  installPreviewActivity({ application }, 'test-only-activity-capability', APP_ORIGIN, true);
  notify.mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('answers its owner with where the element is, and brings it into view when asked to', () => {
  ask({ type: 'openmaic-preview-measure', selector: '#send', requestId: 7, reveal: true }, {});
  expect(application.asked).toEqual(['#send']);
  expect(element.revealed).toBe(1);
  expect(notify).toHaveBeenCalledWith(
    {
      type: 'openmaic-preview-rect',
      requestId: 7,
      rect: { x: 40, y: 120, width: 200, height: 48 },
      viewport: { width: 800, height: 600 },
    },
    APP_ORIGIN,
  );
  // Asking again without `reveal` only measures.
  ask({ type: 'openmaic-preview-measure', selector: '#send', requestId: 8 }, {});
  expect(element.revealed).toBe(1);
});

it('says so when nothing matches, and never throws at its owner', () => {
  application.found = null;
  ask({ type: 'openmaic-preview-measure', selector: '.missing', requestId: 1 }, {});
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: 1, rect: null }),
    APP_ORIGIN,
  );
});

it('answers no one but its owner, from its owner origin, through a real event', () => {
  const request = { type: 'openmaic-preview-measure', selector: '#send', requestId: 2 };
  ask(request, { source: {} });
  ask(request, { origin: 'https://elsewhere.example.com' });
  ask(request, { trusted: false });
  expect(application.asked).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

it('ignores a request that is not a short selector with a numbered id', () => {
  ask({ type: 'openmaic-preview-measure', selector: 'a'.repeat(201), requestId: 3 }, {});
  ask(
    { type: 'openmaic-preview-measure', selector: { toString: () => '#send' }, requestId: 4 },
    {},
  );
  ask({ type: 'openmaic-preview-measure', selector: '#send', requestId: 'five' }, {});
  expect(application.asked).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});
