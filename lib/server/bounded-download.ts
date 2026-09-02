export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_BATCH_BYTES = 100 * 1024 * 1024;

export class DownloadSizeLimitError extends Error {
  constructor(
    readonly scope: 'response' | 'aggregate',
    readonly maxBytes: number,
  ) {
    super(
      scope === 'response'
        ? `Download exceeded the ${maxBytes}-byte response limit`
        : `Downloads exceeded the ${maxBytes}-byte aggregate limit`,
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

/** Read a response body without ever buffering beyond the configured byte limits. */
export async function readResponseBodyWithLimit(
  response: Response,
  options: {
    maxBytes: number;
    aggregateBudget?: DownloadByteBudget;
  },
): Promise<Buffer> {
  const { maxBytes, aggregateBudget } = options;
  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelBody(response.body);
    throw new DownloadSizeLimitError('response', maxBytes);
  }
  if (
    aggregateBudget &&
    Number.isFinite(declaredLength) &&
    declaredLength > aggregateBudget.remainingBytes
  ) {
    await cancelBody(response.body);
    throw new DownloadSizeLimitError('aggregate', aggregateBudget.maxBytes);
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
        throw new DownloadSizeLimitError('response', maxBytes);
      }
      if (aggregateBudget && !aggregateBudget.consume(value.byteLength)) {
        await reader.cancel().catch(() => {});
        throw new DownloadSizeLimitError('aggregate', aggregateBudget.maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  );
}
