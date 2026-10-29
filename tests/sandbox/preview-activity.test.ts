import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreviewActivity, previewShell } from '../../scripts/sandbox-preview-activity.mjs';

const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
let loaded: () => void;
let visible: () => void;
let appDocument: { addEventListener: ReturnType<typeof vi.fn> } | null;
let documentState: { visibilityState: string; addEventListener: ReturnType<typeof vi.fn> };
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  listeners.clear();
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  documentState = {
    visibilityState: 'visible',
    addEventListener: vi.fn((_name, fn) => {
      visible = fn;
    }),
  };
  vi.stubGlobal('document', documentState);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'http://preview.localhost/__openmaic_preview' });
  vi.stubGlobal('Document', {
    prototype: Object.create(null, {
      visibilityState: {
        get() {
          return documentState.visibilityState;
        },
      },
    }),
  });
  const nativeListen = EventTarget.prototype.addEventListener;
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    name,
    listener,
    options,
  ) {
    if (Object.hasOwn(this, 'addEventListener')) this.addEventListener(name, listener, options);
    else nativeListen.call(this, name, listener, options);
  });
  appDocument = {
    addEventListener: vi.fn((name: string, fn: (event: { isTrusted: boolean }) => void) =>
      listeners.set(name, fn),
    ),
  };
  installPreviewActivity(
    {
      addEventListener: (_name: string, fn: () => void) => {
        loaded = fn;
      },
      get contentDocument() {
        return appDocument;
      },
    },
    'test-only-activity-capability',
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('tracks input before iframe load, follows document replacement and does not duplicate listeners', async () => {
  // The first document is usable while resources are still pending; no load event.
  listeners.get('keydown')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0].headers.get('x-openmaic-preview-activity')).toBe(
    'test-only-activity-capability',
  );
  loaded();
  await vi.advanceTimersByTimeAsync(1000);
  expect(appDocument!.addEventListener).toHaveBeenCalledTimes(3);

  // Navigating replaces the Document before the next iframe load event, too.
  appDocument = null;
  await vi.advanceTimersByTimeAsync(100);
  listeners.clear();
  appDocument = { addEventListener: vi.fn((name, fn) => listeners.set(name, fn)) };
  await vi.advanceTimersByTimeAsync(100);
  expect(appDocument.addEventListener).toHaveBeenCalledTimes(3);
  listeners.get('pointerdown')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('coalesces real iframe input and never reports load, synthetic events, quiet time or hidden input', async () => {
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fetchMock).not.toHaveBeenCalled();
  listeners.get('pointerdown')!({ isTrusted: false });
  expect(fetchMock).not.toHaveBeenCalled();
  listeners.get('pointerdown')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  listeners.get('keydown')!({ isTrusted: true });
  listeners.get('wheel')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  documentState.visibilityState = 'hidden';
  visible();
  listeners.get('keydown')!({ isTrusted: true });
  documentState.visibilityState = 'visible';
  visible();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([429, 500, 502, 503, 504])(
  'retries input after HTTP %s but drops a revoked batch',
  async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    listeners.get('keydown')!({ isTrusted: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    listeners.get('keydown')!({ isTrusted: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  },
);

it('uses an isolated shell in both iframe and new-tab modes, and drops the bootstrap ticket before mounting app HTML', () => {
  const html = previewShell('test-nonce');
  expect(html).toContain("frame.src='/'");
  expect(html).toContain('nonce="test-nonce"');
  expect(html.indexOf("ticket=''")).toBeLessThan(html.indexOf("document.createElement('iframe')"));
  expect(html).not.toContain('postMessage');
});
