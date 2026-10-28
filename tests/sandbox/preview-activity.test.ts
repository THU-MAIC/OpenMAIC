import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreviewActivity, previewShell } from '../../scripts/sandbox-preview-activity.mjs';

const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
let loaded: () => void;
let visible: () => void;
let documentState: { visibilityState: string; addEventListener: ReturnType<typeof vi.fn> };
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  listeners.clear();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 204 });
  documentState = {
    visibilityState: 'visible',
    addEventListener: vi.fn((_name, fn) => {
      visible = fn;
    }),
  };
  vi.stubGlobal('document', documentState);
  vi.stubGlobal('fetch', fetchMock);
  installPreviewActivity({
    addEventListener: (_name: string, fn: () => void) => {
      loaded = fn;
    },
    contentDocument: {
      addEventListener: (name: string, fn: (event: { isTrusted: boolean }) => void) =>
        listeners.set(name, fn),
    },
  });
  loaded();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

it('retains genuine unsent input after transient failures, but stops retrying a revoked grant', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
  listeners.get('keydown')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  listeners.get('keydown')!({ isTrusted: true });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('uses an isolated shell in both iframe and new-tab modes, and drops the bootstrap ticket before mounting app HTML', () => {
  const html = previewShell('test-nonce');
  expect(html).toContain("frame.src='/'");
  expect(html).toContain('nonce="test-nonce"');
  expect(html.indexOf("ticket=''")).toBeLessThan(html.indexOf("document.createElement('iframe')"));
  expect(html).not.toContain('postMessage');
});
