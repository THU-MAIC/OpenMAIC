/** How long a decode may take before the frame is given up on. */
const FIRST_FRAME_TIMEOUT_MS = 8000;

/**
 * Decode a video's opening frame to a JPEG, for a thumbnail that would
 * otherwise have to show the video itself. Resolves undefined when the video
 * cannot be decoded in time, or when `signal` aborts.
 *
 * The bytes are handed to the decoding element as a `data:` URL, not an object
 * URL. A media element reads an object URL like a network resource: it probes
 * and range-reads it, and drops the rest of the read once it has the frames it
 * wants, which the browser records as aborted requests. A `data:` URL is
 * decoded in memory and issues no request at all.
 */
export async function captureVideoFirstFrame(
  video: Blob,
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  const source = await readAsDataUrl(video);
  if (!source || signal?.aborted) return undefined;
  return new Promise((resolve) => {
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.preload = 'auto';
    let settled = false;
    const finish = (frame: Blob | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      element.removeAttribute('src');
      element.load();
      resolve(frame);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(onAbort, FIRST_FRAME_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    element.onloadeddata = () => {
      // Step off frame 0: some decoders hold a black pre-roll frame there.
      // `seeked` fires once the frame at the new position is painted.
      element.currentTime = Math.min(0.1, element.duration / 2 || 0);
    };
    element.onseeked = () => {
      const { videoWidth: width, videoHeight: height } = element;
      const canvas = document.createElement('canvas');
      const context = width > 0 && height > 0 ? canvas.getContext('2d') : null;
      if (!context) return finish(undefined);
      canvas.width = width;
      canvas.height = height;
      context.drawImage(element, 0, 0, width, height);
      canvas.toBlob((frame) => finish(frame ?? undefined), 'image/jpeg', 0.85);
    };
    element.onerror = () => finish(undefined);
    element.src = source;
  });
}

function readAsDataUrl(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
