import type { IncomingMessage } from 'node:http';

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ReadJsonErrors {
  invalid(message: string): Error;
  payloadTooLarge(message: string): Error;
}

export function assertMaxBodyBytes(maxBodyBytes: number): void {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error('@openmaic/storage: maxBodyBytes must be a positive safe integer');
  }
}

export async function readJsonObject<T>(
  req: IncomingMessage,
  maxBodyBytes: number,
  errors: ReadJsonErrors,
): Promise<T> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bodyBytes += buffer.byteLength;
    if (bodyBytes > maxBodyBytes) {
      throw errors.payloadTooLarge(
        `@openmaic/storage: request body exceeds maxBodyBytes (${maxBodyBytes})`,
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw errors.invalid('request body must be a JSON object');

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, bodyBytes).toString('utf8')) as unknown;
  } catch (error) {
    throw errors.invalid(error instanceof Error ? error.message : String(error));
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw errors.invalid('request body must be a JSON object');
  }
  return body as T;
}
