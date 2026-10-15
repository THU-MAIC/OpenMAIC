/** OpenAI-compatible transport into AIOJ's existing server-owned speech provider/cache. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import { isServerConfiguredProvider, resolveTTSModel } from '@/lib/server/provider-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 150;

const MAX_INPUT_CHARS = 2000;
const PARENT_TTS_ENDPOINT = 'http://127.0.0.1:18888/internal/classroom-tts';
const PARENT_TTS_ORIGIN = 'http://127.0.0.1:18888';
const MAX_BODY_BYTES = 16384;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_QUEUE = 8;
const DEADLINE_MS = 150000;
let active = false;
type Waiter = {
  enter: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
};
const waiting: Waiter[] = [];

class SpeechError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failure(status: number, code: string, message: string) {
  return Response.json(
    { error: { message, type: 'speech_error', code } },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    next.signal.removeEventListener('abort', next.abort);
    next.enter();
  } else active = false;
}

async function acquireSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (active) {
    if (waiting.length >= MAX_QUEUE)
      throw new SpeechError(429, 'tts_busy', 'Speech service is busy.');
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        enter: resolve,
        reject,
        signal,
        abort: () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(new SpeechError(504, 'tts_timeout', 'Speech request timed out.'));
        },
      };
      waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  } else active = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      releaseSlot();
    }
  };
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const buffers: Buffer[] = [];
  let total = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        cancel();
        throw new SpeechError(
          413,
          'tts_payload_too_large',
          'Speech payload exceeds the size limit.',
        );
      }
      buffers.push(Buffer.from(value));
    }
    return Buffer.concat(buffers, total);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function mp3Bytes(buffer: Buffer, keepId3: boolean): Buffer {
  if (buffer.length < 1024)
    throw new SpeechError(502, 'tts_invalid_audio', 'Speech service returned invalid audio.');
  let offset = 0;
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    if (
      buffer.length < 10 ||
      ![2, 3, 4].includes(buffer[3]) ||
      buffer.subarray(6, 10).some((byte) => byte > 127)
    ) {
      throw new SpeechError(502, 'tts_invalid_audio', 'Speech service returned invalid audio.');
    }
    const tagSize = buffer[6] * 2097152 + buffer[7] * 16384 + buffer[8] * 128 + buffer[9];
    offset = 10 + tagSize + (buffer[3] === 4 && buffer[5] & 0x10 ? 10 : 0);
  }
  // Validate an MPEG audio frame after any ID3v2 metadata; never return a JSON/HTML error as audio.
  if (
    buffer.length < offset + 4 ||
    buffer[offset] !== 255 ||
    (buffer[offset + 1] & 0xe0) !== 0xe0 ||
    ((buffer[offset + 1] >> 3) & 3) === 1 ||
    ((buffer[offset + 1] >> 1) & 3) === 0 ||
    buffer[offset + 2] >> 4 === 15 ||
    ((buffer[offset + 2] >> 2) & 3) === 3
  ) {
    throw new SpeechError(502, 'tts_invalid_audio', 'Speech service returned invalid audio.');
  }
  const end =
    buffer.length >= 128 &&
    buffer.subarray(buffer.length - 128, buffer.length - 125).toString('ascii') === 'TAG'
      ? buffer.length - 128
      : buffer.length;
  return buffer.subarray(keepId3 ? 0 : offset, end);
}

export async function POST(request: Request) {
  const secret = process.env.CODEMATE_OPENMAIC_TTS_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const supplied = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? '';
  if (
    !secret ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(supplied) ||
    !timingSafeEqual(
      createHash('sha256').update(supplied).digest(),
      createHash('sha256').update(secret).digest(),
    )
  )
    return failure(401, 'unauthorized', 'A valid speech credential is required.');

  // Resolve wire compatibility from server config; values never choose the parent supplier.
  let model: string | undefined;
  const defaultVoice = DEFAULT_TTS_VOICES['openai-tts'];
  const voices = new Set(
    [defaultVoice, process.env.NOIZ_VOICE_ID].filter((value): value is string => !!value),
  );
  try {
    if (!isServerConfiguredProvider('tts', 'openai-tts')) throw new Error();
    model = resolveTTSModel('openai-tts', undefined, defaultVoice);
    if (!model) throw new Error();
  } catch {
    return failure(503, 'tts_unconfigured', 'Speech service is unavailable.');
  }

  const controller = new AbortController();
  const deadline = Date.now() + DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let release: (() => void) | undefined;
  try {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return failure(400, 'invalid_request', 'A JSON speech request is required.');
    }
    const raw = await readBounded(request.body, MAX_BODY_BYTES, signal);
    let body: {
      input?: unknown;
      response_format?: unknown;
      model?: unknown;
      voice?: unknown;
      speed?: unknown;
    };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return failure(400, 'invalid_request', 'Invalid JSON speech request.');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.input !== 'string' ||
      !body.input.trim() ||
      Array.from(body.input).length > MAX_INPUT_CHARS
    ) {
      return failure(
        400,
        'invalid_input',
        `Speech input must contain 1 to ${MAX_INPUT_CHARS} characters.`,
      );
    }
    if (
      Object.keys(body).some(
        (key) => !['input', 'response_format', 'model', 'voice', 'speed'].includes(key),
      ) ||
      (body.model !== undefined && body.model !== model) ||
      (body.voice !== undefined && (typeof body.voice !== 'string' || !voices.has(body.voice))) ||
      (body.speed !== undefined &&
        (typeof body.speed !== 'number' ||
          !Number.isFinite(body.speed) ||
          body.speed < 0.25 ||
          body.speed > 4))
    ) {
      return failure(
        400,
        'invalid_request',
        'Only the server-managed speech contract is supported.',
      );
    }
    if (body.response_format !== undefined && body.response_format !== 'mp3') {
      return failure(400, 'unsupported_format', 'Only mp3 speech output is supported.');
    }
    release = await acquireSlot(signal);
    signal.throwIfAborted();
    // No cookies/user session and no client provider/URL/voice overrides cross this boundary.
    const upstream = await fetch(PARENT_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aioj-classroom-tts-token': secret,
        'x-aioj-tts-deadline': String(deadline),
        Origin: PARENT_TTS_ORIGIN,
        Referer: PARENT_TTS_ORIGIN + '/',
      },
      body: JSON.stringify({ text: body.input, markdown: false }),
      signal,
      redirect: 'error',
    });
    if (
      !upstream.ok ||
      !/^audio\/(mpeg|mp3)(?:;|$)/i.test(upstream.headers.get('content-type') ?? '')
    ) {
      void upstream.body?.cancel().catch(() => {});
      throw new SpeechError(
        upstream.status === 429 ? 429 : upstream.status === 504 ? 504 : 502,
        'tts_upstream_failed',
        'Speech service could not generate audio.',
      );
    }
    const bytes = await readBounded(upstream.body, MAX_AUDIO_BYTES, signal);
    const audio = mp3Bytes(bytes, true);
    const total = audio.length;

    signal.throwIfAborted();
    return new Response(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(total),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      return failure(504, 'tts_timeout', 'Speech request timed out.');
    }
    if (error instanceof SpeechError) return failure(error.status, error.code, error.message);
    return failure(502, 'tts_upstream_failed', 'Speech service could not generate audio.');
  } finally {
    clearTimeout(timer);
    release?.();
  }
}
