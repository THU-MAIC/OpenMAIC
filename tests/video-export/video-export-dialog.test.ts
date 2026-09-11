// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  render: vi.fn(),
  zip: vi.fn(),
  subtitles: vi.fn(),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/video-export-app/use-render-video', () => ({
  useRenderVideo: () => ({
    rendering: false,
    percent: 0,
    etaMs: null,
    options: { resolution: '1080p', fps: 30, quality: 'standard', burnInSubtitles: false },
    setOptions: vi.fn(),
    renderVideo: mocks.render,
  }),
}));
vi.mock('@/lib/video-export-app/use-export-video', () => ({
  useExportVideo: () => ({ exporting: false, exportVideo: mocks.zip }),
}));
vi.mock('@/lib/video-export-app/use-download-subtitles', () => ({
  useDownloadSubtitles: () => ({ downloading: false, downloadSubtitles: mocks.subtitles }),
}));
import { VideoExportDialog } from '@/components/stage/video-export-dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const onOpenChange = vi.fn();
async function show(open: boolean) {
  await act(async () => root.render(createElement(VideoExportDialog, { open, onOpenChange })));
}
function button(key: string) {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent === key);
  expect(found, key).toBeDefined();
  return found!;
}
async function click(key: string) {
  await act(async () => button(key).click());
}
function response(accepting?: boolean, enabled = true) {
  return { ok: true, json: async () => ({ enabled, accepting }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('video export queue preflight', () => {
  it('blocks MP4 while busy, leaves other exports usable, and recovers on manual recheck', async () => {
    mocks.fetch.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    await show(true);
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('export.videoQueueBusy');
    await click('export.videoDownloadZip');
    await click('export.videoDownloadSubtitles');
    expect(mocks.zip).toHaveBeenCalledWith('1080p', false);
    expect(mocks.subtitles).toHaveBeenCalledWith('srt');
    await click('export.videoRenderMp4');
    expect(mocks.render).not.toHaveBeenCalled();
    await click('export.videoRecheckQueue');
    expect(button('export.videoRenderMp4').disabled).toBe(false);
    expect(document.querySelector('[role="status"]')).toBeNull();
    await click('export.videoRenderMp4');
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate checks and MP4 while a recheck is pending', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockResolvedValueOnce(response(false)).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await show(true);
    await click('export.videoRecheckQueue');
    expect(button('export.videoCheckingQueue').disabled).toBe(true);
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    await click('export.videoCheckingQueue');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => resolve(response(true)));
    expect(button('export.videoRenderMp4').disabled).toBe(false);
  });

  it('ignores a late response from an earlier opening', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce(response(false));
    await show(true);
    await show(false);
    await show(true);
    await act(async () => resolve(response(true)));
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('allows older services without admission state', async () => {
    mocks.fetch.mockResolvedValue(response());
    await show(true);
    expect(button('export.videoRenderMp4').disabled).toBe(false);
  });

  it('preserves the ZIP-only UI when the service is disabled', async () => {
    mocks.fetch.mockResolvedValue(response(undefined, false));
    await show(true);
    expect(document.body.textContent).not.toContain('export.videoRenderMp4');
    expect(document.body.textContent).toContain('export.videoServiceHint');
    expect(button('export.videoDownloadZip').disabled).toBe(false);
  });
});
