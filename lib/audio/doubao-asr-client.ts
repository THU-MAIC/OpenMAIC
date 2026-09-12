/**
 * Doubao (Volcano Ark) ASR WebSocket client — zero-dependency.
 *
 * Implements Volcano's full-duplex V3 binary protocol over a hand-rolled
 * RFC6455 WebSocket (the handshake must carry Volcano auth headers, which
 * browser-style WebSocket constructors cannot send, hence the raw TLS socket).
 * Protocol mirrors the official 大模型流式语音识别 sample: ordinary audio
 * frames carry a positive sequence number, while the final audio frame uses
 * the no-sequence last-package flag; JSON payloads are gzip-compressed.
 *
 * Endpoint / auth pairing (mirrors doubao-tts):
 *  - Ark Agent Plan single key (no colon)  → X-Api-Key + resource id
 *    `volc.seedasr.sauc.duration` on wss://…/api/v3/plan/sauc/bigmodel_nostream
 *  - Speech-console `appId:accessKey` pair → X-Api-App-Key + X-Api-Access-Key
 *    + resource id `volc.bigasr.sauc.duration` on the non-plan endpoint
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const MSG_FULL_CLIENT_REQUEST = 0b0001;
const MSG_AUDIO_ONLY = 0b0010;
const MSG_SERVER_ERROR_RESPONSE = 0b1111;
const FLAGS_POS_SEQUENCE = 0b0001;
const FLAGS_LAST_PACKAGE = 0b0010;
const SERIALIZATION_JSON = 0b0001;
const SERIALIZATION_NONE = 0b0000;
const COMPRESSION_GZIP = 0b0001;
const COMPRESSION_NONE = 0b0000;

const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const AUDIO_SEGMENT_BYTES = 6400; // 200ms of 16kHz mono 16-bit PCM

function asrFrame(
  messageType: number,
  flags: number,
  seq: number | undefined,
  payload: Buffer | null,
): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (messageType << 4) | flags,
    payload === null
      ? (SERIALIZATION_NONE << 4) | COMPRESSION_NONE
      : (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP,
    0x00,
  ]);
  const seqBuf =
    flags & FLAGS_POS_SEQUENCE
      ? (() => {
          const value = Buffer.alloc(4);
          value.writeInt32BE(seq ?? 0);
          return value;
        })()
      : Buffer.alloc(0);
  const sizeBuf = Buffer.alloc(4);
  const body = payload === null ? Buffer.alloc(0) : gzipSync(payload);
  sizeBuf.writeUInt32BE(body.length);
  return Buffer.concat([header, seqBuf, sizeBuf, body]);
}

function audioFrame(seq: number, segment: Buffer, isLast: boolean): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    // The nostream protocol marks the final audio packet with flag 0b0010;
    // unlike ordinary packets it has no sequence extension. Sending a
    // negative sequence (flag 0b0011) is accepted by some gateways but can
    // cause the plan endpoint to reset the connection for short recordings.
    (MSG_AUDIO_ONLY << 4) | (isLast ? FLAGS_LAST_PACKAGE : FLAGS_POS_SEQUENCE),
    // Audio frames are raw bytes with gzip compression. Marking these as JSON
    // makes the gateway attempt to parse PCM and results in reserved-bit or
    // body-size protocol errors.
    (SERIALIZATION_NONE << 4) | COMPRESSION_GZIP,
    0x00,
  ]);
  const seqBuf = isLast
    ? Buffer.alloc(0)
    : (() => {
        const value = Buffer.alloc(4);
        value.writeInt32BE(seq);
        return value;
      })();
  const gz = gzipSync(segment);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(gz.length);
  return Buffer.concat([header, seqBuf, sizeBuf, gz]);
}

/** Decode a PCM WAV and normalize it to the format expected by Seed-ASR. */
function preparePcm16kMono(wav: Buffer): Buffer {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('doubao-asr: input must be a RIFF/WAVE file');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkLength = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(wav.length, chunkStart + chunkLength);
    if (chunkId === 'fmt ' && chunkEnd - chunkStart >= 16) {
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRate = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataStart = chunkStart;
      dataLength = chunkEnd - chunkStart;
      break;
    }
    offset = chunkStart + chunkLength + (chunkLength & 1);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 1) {
    throw new Error(
      `doubao-asr: unsupported WAV format (format=${audioFormat}, channels=${channels}, rate=${sampleRate}, bits=${bitsPerSample})`,
    );
  }
  if (dataStart < 0 || dataLength === 0) return Buffer.alloc(0);

  const frameBytes = channels * 2;
  const frameCount = Math.floor(dataLength / frameBytes);
  if (frameCount === 0) return Buffer.alloc(0);
  const mono = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let mixed = 0;
    const frameOffset = dataStart + frame * frameBytes;
    for (let channel = 0; channel < channels; channel++) {
      mixed += wav.readInt16LE(frameOffset + channel * 2) / 32768;
    }
    mono[frame] = mixed / channels;
  }

  const outputFrames = Math.max(1, Math.round((frameCount * 16000) / sampleRate));
  const output = Buffer.alloc(outputFrames * 2);
  for (let i = 0; i < outputFrames; i++) {
    const sourcePosition = (i * sampleRate) / 16000;
    const left = Math.min(frameCount - 1, Math.floor(sourcePosition));
    const right = Math.min(frameCount - 1, left + 1);
    const fraction = sourcePosition - left;
    const sample = mono[left] + (mono[right] - mono[left]) * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    output.writeInt16LE(
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767),
      i * 2,
    );
  }
  return output;
}

function maskFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  const lenByte = payload.length >= 65536 ? 127 : payload.length >= 126 ? 126 : payload.length;
  const header = Buffer.from([0x80 | opcode, 0x80 | lenByte]);
  const ext =
    lenByte === 127
      ? (() => {
          const b = Buffer.allocUnsafe(8);
          b.writeBigUInt64BE(BigInt(payload.length));
          return b;
        })()
      : lenByte === 126
        ? (() => {
            const b = Buffer.allocUnsafe(2);
            b.writeUInt16BE(payload.length);
            return b;
          })()
        : Buffer.alloc(0);
  const frame = Buffer.concat([header, ext, mask, masked]);
  return frame;
}

interface DoubaoASRSocketOptions {
  url: string;
  apiKey: string;
  wav: Buffer;
  language?: string;
  timeoutMs?: number;
}

/**
 * Transcribe a complete WAV buffer via Volcano's plan ASR WebSocket.
 * Resolves with the recognized text; throws on auth/protocol/service errors.
 */
export async function transcribeWithDoubaoASR(options: DoubaoASRSocketOptions): Promise<string> {
  const { url, apiKey, wav, language, timeoutMs = 30000 } = options;
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`doubao-asr: unsupported URL protocol "${parsed.protocol}"`);
  }
  const secure = parsed.protocol === 'wss:';
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;

  const colonIdx = apiKey.indexOf(':');
  const isPlanKey = colonIdx < 0;
  const reqid = randomUUID();
  const authHeaders: Record<string, string> = isPlanKey
    ? {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
        'X-Api-Request-Id': reqid,
        'X-Api-Connect-Id': reqid,
        'X-Api-Sequence': '-1',
      }
    : {
        'X-Api-App-Key': apiKey.slice(0, colonIdx),
        'X-Api-Access-Key': apiKey.slice(colonIdx + 1),
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
        'X-Api-Request-Id': reqid,
        'X-Api-Connect-Id': reqid,
        'X-Api-Sequence': '-1',
      };

  const socket = await new Promise<Socket>((resolve, reject) => {
    const sock = secure
      ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname }, () =>
          resolve(sock),
        )
      : netConnect({ host: parsed.hostname, port }, () => resolve(sock));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('doubao-asr: connection timed out'));
    });
    sock.on('error', (err) => reject(err));
  }).catch((err) => {
    throw err instanceof Error ? err : new Error('doubao-asr: connection failed');
  });

  return await new Promise<string>((resolve, reject) => {
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let lastText = '';
    let failure: Error | undefined;

    let settled = false;
    function finish(result: string | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already down */
      }
      if (typeof result === 'string') resolve(result);
      else reject(result);
    }

    const timer = setTimeout(() => {
      finish(
        failure ??
          (lastText !== ''
            ? lastText
            : new Error('doubao-asr: transcription timed out (no result from service)')),
      );
    }, timeoutMs);

    function handleServerMessage(msg: Buffer) {
      const headerSize = (msg[0] & 0x0f) * 4;
      const messageType = msg[1] >> 4;
      const flags = msg[1] & 0x0f;
      const serialization = (msg[2] >> 4) & 0x0f;
      const compression = msg[2] & 0x0f;
      // Official parse order: header → optional seq (flags bit0) → optional
      // event (bit2) → size (full response) or code+size (error response) →
      // decompress → JSON parse.
      let payloadOffset = headerSize;
      if (flags & FLAGS_POS_SEQUENCE) payloadOffset += 4;
      const isLastPkg = (flags & 0x02) !== 0;
      if (messageType === MSG_SERVER_ERROR_RESPONSE) {
        const code = msg.length >= payloadOffset + 4 ? msg.readInt32BE(payloadOffset) : 0;
        let detail = '';
        try {
          let p = msg.subarray(payloadOffset + 4);
          const size = p.readUInt32BE(0);
          p = p.subarray(4, 4 + size);
          if (compression === COMPRESSION_GZIP) p = gunzipSync(p);
          detail = p.toString('utf-8');
        } catch {
          /* keep raw */
        }
        finish(new Error(`doubao-asr: service error ${code} ${detail}`.trim()));
        return;
      }
      try {
        // Full server response carries a 4-byte payload size BEFORE the body.
        const payload = msg.subarray(payloadOffset);
        const size = payload.length >= 4 ? payload.readUInt32BE(0) : 0;
        let body = payload.subarray(4, size ? 4 + size : payload.length);
        if (size && body.length < size) return;
        if (compression === COMPRESSION_GZIP) body = gunzipSync(body);
        if (serialization === SERIALIZATION_JSON) {
          const json = JSON.parse(body.toString('utf-8')) as {
            result?: { text?: string };
            error?: { code?: number; message?: string };
          };
          if (json.error) {
            failure = new Error(`doubao-asr: ${json.error.message ?? 'service error'}`);
            finish(failure);
            return;
          }
          if (
            json.result &&
            typeof json.result.text === 'string' &&
            json.result.text.trim() !== ''
          ) {
            lastText = json.result.text;
          }
          if (isLastPkg) {
            // is_last_package — final result (or empty final acknowledgment).
            finish(lastText);
            return;
          }
        }
      } catch {}
    }

    function handleWsFrame(opcode: number, payload: Buffer) {
      if (opcode === OP_PING) {
        socket.write(maskFrame(OP_PONG, Buffer.alloc(0)));
        return;
      }
      if (opcode === OP_CLOSE) {
        let detail = '';
        if (payload.length >= 2) {
          const code = payload.readUInt16BE(0);
          const reason = payload.subarray(2).toString('utf-8');
          detail = ` (code=${code}${reason ? ' reason=' + reason : ''})`;
        }
        finish(
          lastText !== ''
            ? lastText
            : (failure ?? new Error('doubao-asr: connection closed by server' + detail)),
        );
        return;
      }
      if (opcode !== OP_BINARY) return;
      handleServerMessage(payload);
    }

    function pump() {
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < offset + 2) return;
          len = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (buffer.length < offset + 8) return;
          const big = buffer.readBigUInt64BE(offset);
          if (big > BigInt(16 * 1024 * 1024)) {
            finish(new Error('doubao-asr: oversized server frame'));
            return;
          }
          len = Number(big);
          offset += 8;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + len) return;
        const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
        buffer = Buffer.from(buffer.subarray(offset + maskLen + len));
        handleWsFrame(opcode, payload);
      }
    }

    socket.setTimeout(timeoutMs, () =>
      finish(failure ?? new Error('doubao-asr: transcription timed out')),
    );
    socket.on('error', (err: Error) => finish(failure ?? err));
    socket.on('close', () => {
      if (!settled)
        finish(
          lastText !== ''
            ? lastText
            : (failure ?? new Error('doubao-asr: socket closed before result')),
        );
    });

    // RFC6455 handshake — Volcano requires the auth headers in the upgrade request.
    const wsKey = Buffer.from(randomUUID() + randomUUID())
      .toString('base64')
      .slice(0, 24);
    const handshake =
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
      `Host: ${parsed.host}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n` +
      Object.entries(authHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('') +
      'User-Agent: openmaic-asr/1.0\r\n\r\n';
    socket.write(handshake);
    socket.on('data', (chunk: Buffer) => {
      if (!handshakeDone) {
        buffer = Buffer.concat([buffer, chunk]);
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const head = buffer.subarray(0, headEnd).toString('utf-8');
        const statusLine = head.split('\r\n')[0];
        const status = Number(statusLine.split(' ')[1] ?? 0);
        handshakeDone = true;
        buffer = Buffer.from(buffer.subarray(headEnd + 4));
        if (status !== 101) {
          finish(
            new Error(
              `doubao-asr: handshake failed (HTTP ${status}) — check ASR_DOUBAO_API_KEY / BASE_URL pairing`,
            ),
          );
          return;
        }
        try {
          sendVolcanoRequest();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        pump();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });

    function sendVolcanoRequest() {
      let seq = 1;
      const pcm = preparePcm16kMono(wav);
      const request = {
        user: { uid: 'openmaic' },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1,
          ...(parsed.pathname.toLowerCase().includes('bigmodel_nostream') && language
            ? { language }
            : {}),
        },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true },
      };
      socket.write(
        maskFrame(
          OP_BINARY,
          asrFrame(
            MSG_FULL_CLIENT_REQUEST,
            0,
            undefined,
            Buffer.from(JSON.stringify(request), 'utf-8'),
          ),
        ),
      );
      seq += 1;
      // Pace segments out — the streaming endpoint ingests audio in real time
      // and a same-tick burst can be dropped entirely (observed: duration=0).
      const offsets: number[] = [];
      for (let offset = 0; offset < pcm.length; offset += AUDIO_SEGMENT_BYTES) {
        offsets.push(offset);
      }
      if (offsets.length === 0) offsets.push(0);
      let index = 0;
      const sendNextSegment = () => {
        if (settled) return;
        const offset = offsets[index];
        const isLast = index === offsets.length - 1;
        const segment = pcm.subarray(offset, Math.min(offset + AUDIO_SEGMENT_BYTES, pcm.length));
        socket.write(maskFrame(OP_BINARY, audioFrame(seq, segment, isLast)));
        if (!isLast) {
          seq += 1;
          index += 1;
          // Match the 200 ms segment duration so the streaming service has
          // time to ingest each packet instead of dropping a same-tick burst.
          setTimeout(sendNextSegment, 200);
        }
      };
      sendNextSegment();
    }
  });
}
