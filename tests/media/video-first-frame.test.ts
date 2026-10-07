// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureVideoFirstFrame } from '@/lib/media/video-first-frame';

/** The decoding elements the helper created, in order. */
let videos: HTMLVideoElement[];

beforeEach(() => {
  videos = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const element = createElement(tag);
    if (tag === 'video') {
      Object.defineProperty(element, 'videoWidth', { value: 640 });
      Object.defineProperty(element, 'videoHeight', { value: 360 });
      Object.defineProperty(element, 'duration', { value: 4 });
      vi.spyOn(element as HTMLVideoElement, 'load').mockImplementation(() => {});
      videos.push(element as HTMLVideoElement);
    }
    return element;
  }) as typeof document.createElement);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
    callback(new Blob(['frame'], { type: 'image/jpeg' }));
  });
});

afterEach(() => vi.restoreAllMocks());

const mp4 = () => new Blob(['mp4 bytes'], { type: 'video/mp4' });

async function decodingElement(): Promise<HTMLVideoElement> {
  await vi.waitFor(() => expect(videos[0]?.getAttribute('src')).toBeTruthy());
  return videos[0];
}

describe('captureVideoFirstFrame', () => {
  it('decodes from a data: URL, so the media element issues no request to abort', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const frame = captureVideoFirstFrame(mp4());

    const video = await decodingElement();
    // An object URL is read by the media element like a network resource,
    // and the read it drops after the first frames shows as an aborted request.
    expect(video.getAttribute('src')).toMatch(/^data:video\/mp4;base64,/);
    expect(createObjectURL).not.toHaveBeenCalled();

    video.dispatchEvent(new Event('loadeddata'));
    expect(video.currentTime).toBe(0.1);
    video.dispatchEvent(new Event('seeked'));

    const result = await frame;
    expect(result?.type).toBe('image/jpeg');
    expect(await result?.text()).toBe('frame');
    // The element lets go of the bytes once the frame is drawn.
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('gives up on a video it cannot decode', async () => {
    const frame = captureVideoFirstFrame(mp4());
    const video = await decodingElement();
    video.dispatchEvent(new Event('error'));
    await expect(frame).resolves.toBeUndefined();
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('gives up when the caller aborts', async () => {
    const controller = new AbortController();
    const frame = captureVideoFirstFrame(mp4(), controller.signal);
    const video = await decodingElement();
    controller.abort();
    await expect(frame).resolves.toBeUndefined();
    expect(video.hasAttribute('src')).toBe(false);
  });
});
