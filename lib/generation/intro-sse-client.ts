import { createLogger } from '@/lib/logger';

const log = createLogger('IntroSseClient');

export type IntroSseStatus = 'generating' | 'streaming' | 'completed' | 'error';

export type PlayIntroSseOptions = {
  stageId: string;
  name: string;
  description?: string;
  language?: string;
  voiceId: string;
  signal?: AbortSignal;
  onScript?: (text: string) => void;
  onStatus?: (status: IntroSseStatus) => void;
  /** If true, do not read or write `intro_played_${stageId}` in sessionStorage */
  skipSessionPlayedGuard?: boolean;
  /** Current mute state when scheduling chunks (e.g. from React ref) */
  isMuted?: () => boolean;
};

function schedulePcmChunk(
  ctx: AudioContext,
  base64: string,
  nextStartTimeRef: { current: number },
  pcmCarryRef: { current: Uint8Array | null },
  destination: AudioNode,
) {
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }

  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const carry = pcmCarryRef.current;
  let merged: Uint8Array;
  if (carry?.length) {
    merged = new Uint8Array(carry.length + bytes.length);
    merged.set(carry, 0);
    merged.set(bytes, carry.length);
    pcmCarryRef.current = null;
  } else {
    merged = bytes;
  }

  const sampleByteLen = merged.length & ~1;
  if (merged.length % 2 === 1) {
    pcmCarryRef.current = merged.subarray(merged.length - 1);
  }
  if (sampleByteLen === 0) return;

  const int16 = new Int16Array(merged.buffer, merged.byteOffset, sampleByteLen / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const gainNode = ctx.createGain();
  gainNode.gain.value = 1;
  gainNode.connect(destination);
  source.connect(gainNode);

  const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
  source.start(startAt);
  nextStartTimeRef.current = startAt + audioBuffer.duration;
}

export type PlayIntroSseResult = 'skipped' | 'completed' | 'error' | 'aborted';

/**
 * Calls POST /api/generate/intro-sse and plays PCM chunks until `done` or error.
 */
export async function playIntroSseStream(options: PlayIntroSseOptions): Promise<PlayIntroSseResult> {
  const {
    stageId,
    name,
    description,
    language = 'zh-CN',
    voiceId,
    signal,
    onScript,
    onStatus,
    skipSessionPlayedGuard,
    isMuted,
  } = options;

  if (!skipSessionPlayedGuard) {
    const hasPlayed = sessionStorage.getItem(`intro_played_${stageId}`);
    if (hasPlayed === 'true') {
      onStatus?.('completed');
      return 'skipped';
    }
    sessionStorage.setItem(`intro_played_${stageId}`, 'true');
  }

  const pcmCarryRef = { current: null as Uint8Array | null };
  const nextStartTimeRef = { current: 0 };
  /** Ref avoids `let` control-flow narrowing issues inside nested loops (TS inferred `never`). */
  const playbackRef = { current: null as AudioContext | null };
  const masterGainRef = { current: null as GainNode | null };
  let muteRafId = 0;
  let abortHandler: (() => void) | null = null;

  const stopMuteSync = () => {
    if (muteRafId !== 0) {
      cancelAnimationFrame(muteRafId);
      muteRafId = 0;
    }
  };

  const ensureCtx = (): AudioContext => {
    if (!playbackRef.current) {
      const WebkitWindow = window as unknown as { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = window.AudioContext ?? WebkitWindow.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('Web Audio API (AudioContext) is not available in this browser');
      }
      playbackRef.current = new AudioContextCtor();
      nextStartTimeRef.current = playbackRef.current.currentTime;

      const mg = playbackRef.current.createGain();
      mg.gain.value = isMuted?.() ? 0 : 1;
      mg.connect(playbackRef.current.destination);
      masterGainRef.current = mg;

      const tick = () => {
        const mgNode = masterGainRef.current;
        const ctxLive = playbackRef.current;
        if (mgNode && ctxLive && isMuted) {
          const target = isMuted() ? 0 : 1;
          if (mgNode.gain.value !== target) {
            mgNode.gain.setValueAtTime(target, ctxLive.currentTime);
          }
        }
        muteRafId = requestAnimationFrame(tick);
      };
      muteRafId = requestAnimationFrame(tick);
    }
    return playbackRef.current;
  };

  onStatus?.('generating');

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    if (signal) {
      abortHandler = () => {
        // Make abort feel instant: cut gain and close the AudioContext immediately.
        stopMuteSync();
        try {
          const mg = masterGainRef.current;
          const ctx = playbackRef.current;
          if (mg && ctx) mg.gain.setValueAtTime(0, ctx.currentTime);
        } catch {
          // ignore
        }
        const ctx = playbackRef.current;
        if (ctx) {
          // Don't await here; the caller is already aborting and may navigate away.
          void ctx.close().catch(() => {});
        }
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const response = await fetch('/api/generate/intro-sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stageId,
        name,
        description,
        language,
        voiceId,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(errText || `Intro SSE failed (${response.status})`);
    }
    if (!response.body) throw new Error('No response body');

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const lines = part.split('\n');
        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          }
        }

        if (!currentEvent || !currentData) continue;

        const data = JSON.parse(currentData) as Record<string, unknown>;

        if (currentEvent === 'script') {
          onScript?.(String(data.text ?? ''));
          onStatus?.('streaming');
        } else if (currentEvent === 'audio') {
          const chunk = data.chunk as string;
          const ctx = ensureCtx();
          const dest = masterGainRef.current;
          if (!dest) continue;
          schedulePcmChunk(ctx, chunk, nextStartTimeRef, pcmCarryRef, dest);
        } else if (currentEvent === 'done') {
          onStatus?.('completed');
          const ctx = playbackRef.current;
          const waitSec = ctx ? Math.max(0, nextStartTimeRef.current - ctx.currentTime) : 0;
          // Wait for all scheduled buffers — do not cap aggressively or playback is cut off mid-intro.
          const waitMs = Math.min(180_000, Math.ceil(waitSec * 1000) + 500);
          await new Promise((r) => setTimeout(r, waitMs));
          return 'completed';
        } else if (currentEvent === 'error') {
          onStatus?.('error');
          log.error('Intro SSE error event:', data.message);
          return 'error';
        }
      }
    }
    return 'completed';
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return 'aborted';
    }
    log.error('Intro SSE stream failed:', err);
    onStatus?.('error');
    return 'error';
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
    reader?.cancel().catch(() => {});
    pcmCarryRef.current = null;
    stopMuteSync();
    masterGainRef.current = null;
    await playbackRef.current?.close().catch(() => {});
  }
}
