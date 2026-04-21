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

export type PlayIntroSseResult = 'skipped' | 'completed' | 'error' | 'aborted';

/**
 * Calls POST /api/generate/intro-sse and plays the returned audio.
 * Protocol: script → audio_ready (complete base64 + format) → done
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
      if (!AudioContextCtor) throw new Error('Web Audio API is not available in this browser');
      playbackRef.current = new AudioContextCtor();

      const mg = playbackRef.current.createGain();
      mg.gain.value = isMuted?.() ? 0 : 1;
      mg.connect(playbackRef.current.destination);
      masterGainRef.current = mg;

      const tick = () => {
        const mgNode = masterGainRef.current;
        const ctxLive = playbackRef.current;
        if (mgNode && ctxLive && isMuted) {
          const target = isMuted() ? 0 : 1;
          if (mgNode.gain.value !== target) mgNode.gain.setValueAtTime(target, ctxLive.currentTime);
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
        stopMuteSync();
        try {
          const mg = masterGainRef.current;
          const ctx = playbackRef.current;
          if (mg && ctx) mg.gain.setValueAtTime(0, ctx.currentTime);
        } catch { /* ignore */ }
        void playbackRef.current?.close().catch(() => {});
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const response = await fetch('/api/generate/intro-sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId, name, description, language, voiceId }),
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
          if (line.startsWith('event: ')) currentEvent = line.slice(7);
          else if (line.startsWith('data: ')) currentData = line.slice(6);
        }
        if (!currentEvent || !currentData) continue;

        const data = JSON.parse(currentData) as Record<string, unknown>;

        if (currentEvent === 'script') {
          onScript?.(String(data.text ?? ''));
          onStatus?.('streaming');
        } else if (currentEvent === 'audio_ready') {
          const base64 = data.audio as string;
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

          const ctx = ensureCtx();
          if (ctx.state === 'suspended') await ctx.resume();

          const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          const dest = masterGainRef.current ?? ctx.destination;
          source.connect(dest);
          source.start(ctx.currentTime);

          // Wait for playback to finish
          await new Promise<void>((resolve) => {
            source.onended = () => resolve();
            // Safety timeout
            setTimeout(resolve, (audioBuffer.duration + 2) * 1000);
          });
        } else if (currentEvent === 'done') {
          onStatus?.('completed');
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
    stopMuteSync();
    masterGainRef.current = null;
    await playbackRef.current?.close().catch(() => {});
  }
}
