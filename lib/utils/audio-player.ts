/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations.
 * Resolves pre-generated TTS audio bytes pool-first through the shared read
 * path, with the Dexie `audioFiles` table as the legacy fallback.
 *
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

/** How long a legacy narration URL fetch may take before the media element
 * fallback takes over. Bounded like the converter's URL probes: one stalled
 * endpoint must not pin a playback line indefinitely. */
const LEGACY_URL_FETCH_TIMEOUT_MS = 15_000;

/** Bytes an audio id currently resolves to, pool first. Loaded lazily to keep
 * this module importable without the media graph. */
async function resolveBytes(audioId: string): Promise<Blob | null> {
  try {
    const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
    return await resolveAudioBlob(audioId);
  } catch {
    return null;
  }
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private requestToken: number = 0;
  /** The object URL backing the current audio element, if any. */
  private blobUrl: string | null = null;
  /**
   * The in-flight legacy narration fetch of the current play, if any. Aborted
   * when the play is superseded (a replacement play, stop, or destroy), so a
   * stale fetch is cancelled at the network layer instead of settling before
   * its supersession is noticed.
   */
  private fetchAbort: AbortController | null = null;

  /** Abort the in-flight legacy narration fetch, if one exists. */
  private abortLegacyFetch(): void {
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }
  }

  /**
   * Revoke an object URL this player created, forgetting it when it is still
   * the current source. Idempotent: natural end, rejected play, stop, and
   * replacement each call it once for their own URL.
   */
  private releaseBlobUrl(blobUrl: string | null | undefined): void {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    if (this.blobUrl === blobUrl) this.blobUrl = null;
  }

  private stopAudioElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
    // Stop or replacement before natural end must not leak the fetched
    // narration: the element is dropped here, so its URL is released with it.
    this.releaseBlobUrl(this.blobUrl);
  }

  /**
   * Play audio for a speech reference.
   *
   * The reference is resolved pool-first through the shared read path, so a
   * stable-id regeneration whose mirror write failed does not keep serving
   * superseded narration; the Dexie `audioFiles` table remains the fallback
   * for legacy and imported rows that were never pool-backed.
   *
   * Conversion to allocated ids is best-effort: a document whose conversion
   * was skipped (the lock-free load path) or deferred (a transient fetch
   * failure) still holds its legacy pair, and an `audioId` with no local
   * bytes is not silence while the URL beside it may still be live. That URL
   * is the fallback of last resort, fetched at playback time; a converted
   * document never carries one.
   *
   * @param audioId Audio asset reference (allocated asset id, or a legacy TTS-derived id)
   * @param legacyUrl The legacy `audioUrl` of an unconverted pair, if present
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, legacyUrl?: string): Promise<boolean> {
    const requestToken = ++this.requestToken;
    // A new play supersedes any in-flight legacy fetch of the previous one.
    this.abortLegacyFetch();
    try {
      let blob = await resolveBytes(audioId);
      if (requestToken !== this.requestToken) return false;

      let directUrl: string | undefined;
      if (!blob && legacyUrl) {
        const controller = new AbortController();
        this.fetchAbort = controller;
        const timeout = setTimeout(() => controller.abort(), LEGACY_URL_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(legacyUrl, { signal: controller.signal });
          const fetched = response.ok ? await response.blob() : null;
          // Zero-byte responses are not narration: fall back to the URL so a
          // later attempt can retry, and never play silence.
          if (fetched && fetched.size > 0) blob = fetched;
        } catch {
          blob = null;
        } finally {
          clearTimeout(timeout);
          if (this.fetchAbort === controller) this.fetchAbort = null;
        }
        if (requestToken !== this.requestToken) return false;
        if (!blob) {
          // A cross-origin legacy URL without CORS headers cannot be fetched,
          // but a media element is not CORS-bound: hand it the URL directly.
          // A superseded play never reaches here -- the token check above
          // already returned false -- so only ordinary fetch/CORS/timeout
          // failures fall back to the element.
          directUrl = legacyUrl;
        }
      }

      if (!blob && !directUrl) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Stop current playback
      this.stopAudioElement();
      if (requestToken !== this.requestToken) return false;

      // Create audio element
      this.audio = new Audio();

      // Set audio source
      const blobUrl = blob ? URL.createObjectURL(blob) : undefined;
      this.blobUrl = blobUrl ?? null;
      this.audio.src = blobUrl ?? (directUrl as string);
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;

      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;

      // Set ended callback
      this.audio.addEventListener('ended', () => {
        this.releaseBlobUrl(blobUrl);
        this.onEndedCallback?.();
      });

      // Play. If play() rejects (autoplay policy, decode error, interrupted
      // load) the 'ended' listener never fires, so revoke the blob URL here to
      // avoid leaking it for the lifetime of the document.
      try {
        await this.audio.play();
      } catch (playError) {
        this.releaseBlobUrl(blobUrl);
        throw playError;
      }
      if (requestToken !== this.requestToken) {
        this.releaseBlobUrl(blobUrl);
        return false;
      }
      // Re-apply after play() — some browsers reset during load
      this.audio.playbackRate = this.playbackRate;
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.requestToken += 1;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.requestToken += 1;
    // Cancel a still-fetching legacy narration instead of waiting for it to
    // settle: the play was superseded and its result is unwanted.
    this.abortLegacyFetch();
    this.stopAudioElement();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
