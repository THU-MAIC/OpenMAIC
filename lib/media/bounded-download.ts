/**
 * Byte limits for reading response bodies into memory.
 *
 * The module lives in `lib/media` because it serves both worlds: the media
 * adapters (which run on the browser and the server, and must not import
 * `@/lib/server`) and server-only callers such as the agent-runtime image and
 * video tools. `lib/server/bounded-download.ts` re-exports it, so existing
 * server imports keep working; there is one mechanism to bound and harden.
 */

export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_BATCH_BYTES = 100 * 1024 * 1024;

/**
 * The ceiling for a provider-returned media download inside the adapters.
 * Aligned with `MAX_GENERATED_VIDEO_BYTES` in the agent runtime, so a clip the
 * persist path accepts is never refused one step earlier at the download.
 */
export const MAX_PROVIDER_MEDIA_BYTES = 200 * 1024 * 1024;

export class DownloadSizeLimitError extends Error {
  constructor(
    readonly scope: 'response' | 'aggregate',
    readonly maxBytes: number,
    readonly label?: string,
  ) {
    super(
      (label ? `${label}: ` : '') +
        (scope === 'response'
          ? `Download exceeded the ${maxBytes}-byte response limit`
          : `Downloads exceeded the ${maxBytes}-byte aggregate limit`),
    );
    this.name = 'DownloadSizeLimitError';
  }
}

export class DownloadByteBudget {
  private consumedBytes = 0;

  constructor(readonly maxBytes: number) {}

  get remainingBytes(): number {
    return this.maxBytes - this.consumedBytes;
  }

  consume(bytes: number): boolean {
    if (bytes > this.remainingBytes) return false;
    this.consumedBytes += bytes;
    return true;
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  await body?.cancel().catch(() => {});
}

/**
 * Read a response body without ever buffering beyond the configured byte
 * limits. A declared `content-length` over the ceiling rejects before a byte
 * is buffered; otherwise the body is counted as it streams and cut off
 * mid-stream, with the stream cancelled so the connection is not held by a
 * body nobody will read. `label`, when given, names the download in the
 * error so an operator can tell which one refused.
 */
export async function readResponseBodyWithLimit(
  response: Response,
  options: {
    maxBytes: number;
    aggregateBudget?: DownloadByteBudget;
    label?: string;
  },
): Promise<Buffer> {
  const { maxBytes, aggregateBudget, label } = options;
  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelBody(response.body);
    throw new DownloadSizeLimitError('response', maxBytes, label);
  }
  if (
    aggregateBudget &&
    Number.isFinite(declaredLength) &&
    declaredLength > aggregateBudget.remainingBytes
  ) {
    await cancelBody(response.body);
    throw new DownloadSizeLimitError('aggregate', aggregateBudget.maxBytes, label);
  }

  const body = response.body;
  if (!body) throw new Error('Download response has no body');

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DownloadSizeLimitError('response', maxBytes, label);
      }
      if (aggregateBudget && !aggregateBudget.consume(value.byteLength)) {
        await reader.cancel().catch(() => {});
        throw new DownloadSizeLimitError('aggregate', aggregateBudget.maxBytes, label);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}
