// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installPreviewReadiness } from '../../scripts/sandbox-preview-activity.mjs';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['interactive', 'complete'] as const)(
  'promotes parsed HTML at %s without waiting for pending images or the iframe load event',
  async (state) => {
    vi.useFakeTimers();
    const notify = vi.fn(),
      prepare = vi.fn();
    vi.stubGlobal('parent', { postMessage: notify });
    const frame = document.createElement('iframe');
    document.body.append(frame);
    vi.spyOn(Document.prototype, 'URL', 'get').mockReturnValue('https://isolated.example/');
    vi.spyOn(Document.prototype, 'readyState', 'get').mockReturnValue(state);
    installPreviewReadiness(frame, 'https://app.example', prepare);
    await vi.advanceTimersByTimeAsync(100);
    expect(prepare).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({ type: 'openmaic-preview-ready' }, 'https://app.example');
    await vi.advanceTimersByTimeAsync(500);
    expect(notify).toHaveBeenCalledOnce();
  },
);

it('does not promote an unparsed or blank document, and reports non-HTML as an error', async () => {
  vi.useFakeTimers();
  const notify = vi.fn();
  vi.stubGlobal('parent', { postMessage: notify });
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const url = vi.spyOn(Document.prototype, 'URL', 'get').mockReturnValue('about:blank');
  const state = vi.spyOn(Document.prototype, 'readyState', 'get').mockReturnValue('interactive');
  const type = vi.spyOn(Document.prototype, 'contentType', 'get').mockReturnValue('text/html');
  installPreviewReadiness(frame, 'https://app.example');
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).not.toHaveBeenCalled();
  url.mockReturnValue('https://isolated.example/');
  state.mockReturnValue('loading');
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).not.toHaveBeenCalled();
  state.mockReturnValue('interactive');
  type.mockReturnValue('application/json');
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledWith({ type: 'openmaic-preview-error' }, 'https://app.example');
});
