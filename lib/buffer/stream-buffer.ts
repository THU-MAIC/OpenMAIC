import type { DirectorState } from '@/lib/types/chat';

/**
 * StreamBuffer — unified presentation pacing layer.
 *
 * Sits between data sources (SSE stream / PlaybackEngine) and React state.
 * Events are pushed into an ordered queue; a fixed-rate tick loop reveals
 * text character-by-character and fires typed callbacks so both the Chat
 * area and the Roundtable bubble consume identically-paced content.
 *
 * Key invariants:
 *   - ONE source of pacing (this tick loop) — no double typewriter.
 *   - pause() is O(1) instant — tick returns immediately.
 *   - Actions fire only when the tick cursor reaches them (after preceding text).
 *   - Roundtable sees only the current speech segment (resets on action / agent switch).
 */

// ─── Buffer Item Types ───────────────────────────────────────────────

export interface AgentStartItem {
  kind: 'agent_start';
  messageId: string;
  agentId: string;
  agentName: string;
  avatar?: string;
  color?: string;
}

export interface AgentEndItem {
  kind: 'agent_end';
  messageId: string;
  agentId: string;
}

export interface TextItem {
  kind: 'text';
  messageId: string;
  agentId: string;
  /** Unique ID for this text part — distinguishes multiple text items within one message (e.g. lecture). */
  partId: string;
  /** Growable — SSE deltas append here. */
  text: string;
  /** When true, no more text will be appended. Tick can advance past once fully revealed. */
  sealed: boolean;
}

export interface ActionItem {
  kind: 'action';
  messageId: string;
  actionId: string;
  actionName: string;
  params: Record<string, unknown>;
  agentId: string;
}

export interface ThinkingItem {
  kind: 'thinking';
  stage: string;
  agentId?: string;
}

export interface CueUserItem {
  kind: 'cue_user';
  fromAgentId?: string;
  prompt?: string;
}

export interface DoneItem {
  kind: 'done';
  totalActions: number;
  totalAgents: number;
  agentHadContent?: boolean;
  directorState?: DirectorState;
}

export interface ErrorItem {
  kind: 'error';
  message: string;
}

export type BufferItem =
  | AgentStartItem
  | AgentEndItem
  | TextItem
  | ActionItem
  | ThinkingItem
  | CueUserItem
  | DoneItem
  | ErrorItem;

// ─── Callbacks ───────────────────────────────────────────────────────

export interface StreamBufferCallbacks {
  onAgentStart(data: AgentStartItem): void;
  onAgentEnd(data: AgentEndItem): void;
  /**
   * Fired each tick while a text item is being revealed.
   * @param messageId  — which message to update
   * @param partId     — unique ID for this text part (stable across ticks)
   * @param revealedText — text visible so far (slice of full text)
   * @param isComplete — true when this text item is fully revealed AND sealed
   */
  onTextReveal(messageId: string, partId: string, revealedText: string, isComplete: boolean): void;
  /** Fired when tick reaches an action item. Callers should execute the effect + add badge. */
  onActionReady(messageId: string, data: ActionItem): void;
  /**
   * Unified speech feed for the Roundtable bubble.
   * Reports only the CURRENT segment text (resets on action / agent switch).
   * Called with (null, null) when buffer completes or is disposed.
   */
  onLiveSpeech(text: string | null, agentId: string | null): void;
  /**
   * Speech progress ratio for the Roundtable bubble auto-scroll.
   * Fired each tick during text reveal: ratio = charCursor / totalTextLength.
   * Called with null when buffer completes or is disposed.
   */
  onSpeechProgress(ratio: number | null): void;
  onThinking(data: { stage: string; agentId?: string } | null): void;
  onCueUser(fromAgentId?: string, prompt?: string): void;
  onDone(data: {
    totalActions: number;
    totalAgents: number;
    agentHadContent?: boolean;
    directorState?: DirectorState;
  }): void;
  onError(message: string): void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /**
   * When provided, called after a text item is fully revealed and sealed.
   * If it returns true, the tick loop will NOT advance to the next item —
   * the bubble stays on the current text (e.g. waiting for TTS playback to finish).
   */
  shouldHoldAfterReveal?: () => boolean;
}

// ─── Options ─────────────────────────────────────────────────────────

export interface StreamBufferOptions {
  /** Milliseconds between ticks. Default: 30 */
  tickMs?: number;
  /** Characters revealed per tick. Default: 1  (≈33 chars/s) */
  charsPerTick?: number;
  /**
   * Fixed delay (ms) after a text segment is fully revealed before advancing
   * to the next item. Gives the reader a breathing pause after each speech
   * block. Default: 0 (no delay).
   */
  postTextDelayMs?: number;
  /**
   * Delay (ms) after firing an action callback before advancing to the next
   * item. Gives action animations time to play out. Default: 0.
   */
  actionDelayMs?: number;
}

// ─── StreamBuffer Class ──────────────────────────────────────────────

export class StreamBuffer {
  // Queue
  private items: BufferItem[] = [];
  private readIndex = 0;
  private charCursor = 0;

  // Roundtable segment tracking
  private currentSegmentText = '';
  private currentAgentId: string | null = null;

  // Control
  private _paused = false;
  private _disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Dwell / delay counters (in ticks)
  private _dwellTicksRemaining = 0;
  /** True when a text item's post-delay has elapsed and we're waiting for TTS to finish. */
  private _holdingForTTS = false;

  // Config
  private readonly tickMs: number;
  private readonly charsPerTick: number;
  private readonly postTextDelayTicks: number;
  private readonly actionDelayTicks: number;
  private readonly cb: StreamBufferCallbacks;
  private partCounter = 0;
  private _drainResolve: (() => void) | null = null;
  private _drainReject: ((err: Error) => void) | null = null;

  constructor(callbacks: StreamBufferCallbacks, options?: StreamBufferOptions) {
    this.cb = callbacks;
    this.tickMs = options?.tickMs ?? 30;
    this.charsPerTick = options?.charsPerTick ?? 1;
    this.postTextDelayTicks = Math.ceil((options?.postTextDelayMs ?? 0) / this.tickMs);
    this.actionDelayTicks = Math.ceil((options?.actionDelayMs ?? 0) / this.tickMs);
  }

  // ─── Push Methods ────────────────────────────────────────────────

  pushAgentStart(data: Omit<AgentStartItem, 'kind'>): void {
    if (this._disposed) return;
    this.sealLastText();
    this.items.push({ kind: 'agent_start', ...data });
  }

  pushAgentEnd(data: Omit<AgentEndItem, 'kind'>): void {
    if (this._disposed) return;
    this.sealLastText();
    this.items.push({ kind: 'agent_end', ...data });
  }

  /**
   * Append text for a message.
   * If the last queue item is an unsealed text item for the same messageId,
   * the delta is appended in-place. Otherwise a new text item is created.
   */
  pushText(messageId: string, delta: string, agentId?: string): void {
    if (this._disposed) return;
    const last = this.items[this.items.length - 1];
    if (last && last.kind === 'text' && last.messageId === messageId && !last.sealed) {
      last.text += delta;
    } else {
      this.items.push({
        kind: 'text',
        messageId,
        agentId: agentId ?? this.currentAgentId ?? '',
        partId: `p${this.partCounter++}`,
        text: delta,
        sealed: false,
      });
    }
  }

  /** Mark the current (last) text item as complete — no more appends expected. */
  sealText(messageId: string): void {
    if (this._disposed) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === 'text' && item.messageId === messageId && !item.sealed) {
        item.sealed = true;
        break;
      }
    }
  }

  pushAction(data: Omit<ActionItem, 'kind'>): void {
    if (this._disposed) return;
    this.sealLastText();
    this.items.push({ kind: 'action', ...data });
  }

  pushThinking(data: { stage: string; agentId?: string }): void {
    if (this._disposed) return;
    this.items.push({ kind: 'thinking', ...data });
  }

  pushCueUser(data: { fromAgentId?: string; prompt?: string }): void {
    if (this._disposed) return;
    this.items.push({ kind: 'cue_user', ...data });
  }

  pushDone(data: {
    totalActions: number;
    totalAgents: number;
    agentHadContent?: boolean;
    directorState?: DirectorState;
  }): void {
    if (this._disposed) return;
    this.sealLastText();
    this.items.push({ kind: 'done', ...data });
  }

  pushError(message: string): void {
    if (this._disposed) return;
    this.items.push({ kind: 'error', message });
  }

  // ─── Control ─────────────────────────────────────────────────────

  /** Start the tick loop. Idempotent — calling twice is safe. */
  start(): void {
    if (this._disposed || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Instantly pause — tick becomes a no-op. */
  pause(): void {
    this._paused = true;
  }

  /** Resume from exactly where we left off. */
  resume(): void {
    this._paused = false;
  }

  /**
   * Returns a Promise that resolves when the buffer has processed all items
   * including the final `done` item. Rejects if the buffer is disposed/shutdown
   * before draining completes.
   *
   * NOTE: This will block indefinitely while the buffer is paused, by design.
   * Buffer-level pause (see `livePausedRef` in use-chat-sessions) freezes ALL
   * forward progress — the tick loop is a no-op while `_paused` is true, so
   * no items are processed and drain never fires until resumed.
   */
  waitUntilDrained(): Promise<void> {
    if (this._disposed) {
      return Promise.reject(new Error('Buffer already disposed'));
    }
    return new Promise<void>((resolve, reject) => {
      this._drainResolve = resolve;
      this._drainReject = reject;
    });
  }

  get paused(): boolean {
    return this._paused;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Flush: instantly reveal everything remaining.
   * Used when restoring persisted sessions or force-completing.
   */
  flush(): void {
    if (this._disposed) return;
    while (this.readIndex < this.items.length) {
      const item = this.items[this.readIndex];
      switch (item.kind) {
        case 'text':
          this.cb.onTextReveal(item.messageId, item.partId, item.text, true);
          this.currentSegmentText = item.text;
          this.cb.onLiveSpeech(this.currentSegmentText, this.currentAgentId);
          this.cb.onSpeechProgress(1);
          break;
        case 'action':
          this.currentSegmentText = '';
          this.cb.onActionReady(item.messageId, item);
          this.cb.onLiveSpeech(null, this.currentAgentId);
          break;
        case 'agent_start':
          this.currentAgentId = item.agentId;
          this.currentSegmentText = '';
          this.cb.onThinking(null); // Agent selected — clear thinking indicator
          this.cb.onAgentStart(item);
          this.cb.onLiveSpeech(null, item.agentId);
          break;
        case 'agent_end':
          this.cb.onAgentEnd(item);
          break;
        case 'thinking':
          this.cb.onThinking(item);
          break;
        case 'cue_user':
          this.cb.onCueUser(item.fromAgentId, item.prompt);
          break;
        case 'done':
          this.cb.onLiveSpeech(null, null);
          this.cb.onSpeechProgress(null);
          this.cb.onThinking(null);
          this.cb.onDone(item);
          // Resolve drain promise
          this._drainResolve?.();
          this._drainResolve = null;
          this._drainReject = null;
          break;
        case 'error':
          this.cb.onError(item.message);
          break;
      }
      this.readIndex++;
      this.charCursor = 0;
    }
  }

  /** Stop tick loop, release resources. No more callbacks after this. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Reject waiting drain promise
    this._drainReject?.(new Error('Buffer disposed'));
    this._drainResolve = null;
    this._drainReject = null;
    // Final cleanup signal
    this.cb.onLiveSpeech(null, null);
    this.cb.onSpeechProgress(null);
  }

  /**
   * Stop the tick timer and mark disposed WITHOUT firing final onLiveSpeech.
   * Used when replacing a buffer (e.g. resume after soft-pause) to avoid
   * the dispose callback clearing roundtable state via a stale microtask.
   */
  shutdown(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Reject waiting drain promise
    this._drainReject?.(new Error('Buffer shutdown'));
    this._drainResolve = null;
    this._drainReject = null;
  }

  // ─── Internals ───────────────────────────────────────────────────

  /** Seal the last text item in the queue (if any). */
  private sealLastText(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === 'text' && !item.sealed) {
        item.sealed = true;
        // Ordering invariant: sealLastText() is called BEFORE pushAgentEnd/pushAgentStart,
        // so this.currentAgentId still refers to the agent whose text is being sealed.
        this.cb.onSegmentSealed?.(item.messageId, item.partId, item.text, this.currentAgentId);
        break;
      }
      // Stop searching once we hit a non-text item
      if (item.kind !== 'text') break;
    }
  }

  private tick(): void {
    if (this._paused || this._disposed) return;

    // Honour dwell / action-delay countdown before advancing
    if (this._dwellTicksRemaining > 0) {
      this._dwellTicksRemaining--;
      if (this._dwellTicksRemaining === 0 && this._holdingForTTS) {
        // Post-text delay just finished — fall through to the TTS hold check below
      } else {
        return;
      }
    }

    // TTS hold: after post-text delay, keep the bubble on screen while audio plays
    if (this._holdingForTTS) {
      if (this.cb.shouldHoldAfterReveal?.()) {
        return; // TTS still playing — stay on current item
      }
      this._holdingForTTS = false;
      // TTS done — continue to process next item
      this.advanceNonText();
      return;
    }

    const item = this.items[this.readIndex];
    if (!item) return; // Queue empty or caught up — wait

    switch (item.kind) {
      case 'text': {
        // Advance character cursor
        this.charCursor = Math.min(this.charCursor + this.charsPerTick, item.text.length);
        const revealed = item.text.slice(0, this.charCursor);
        const fullyRevealed = this.charCursor >= item.text.length;
        const isComplete = fullyRevealed && item.sealed;

        // Update chat area
        this.cb.onTextReveal(item.messageId, item.partId, revealed, isComplete);

        // Update roundtable (current segment only).
        // Use this.currentAgentId (set when tick processes agent_start) rather than
        // item.agentId — push-time race means item.agentId can carry a stale value
        // from the previous agent when SSE pushes outpace the tick loop.
        this.currentSegmentText = revealed;
        this.cb.onLiveSpeech(this.currentSegmentText, this.currentAgentId);
        this.cb.onSpeechProgress(item.text.length > 0 ? this.charCursor / item.text.length : 1);

        // Advance to next item if fully revealed and sealed
        if (isComplete) {
          this.readIndex++;
          this.charCursor = 0;

          // Fixed pause after text finishes — gives the reader a breathing gap
          // before the next action or agent turn fires.
          if (this.postTextDelayTicks > 0) {
            this._dwellTicksRemaining = this.postTextDelayTicks;
            // If TTS hold callback exists, mark that we need to check it after delay
            if (this.cb.shouldHoldAfterReveal) {
              this._holdingForTTS = true;
            }
            return; // next tick will count down, then advanceNonText
          }

          // No post-text delay — check TTS hold immediately
          if (this.cb.shouldHoldAfterReveal?.()) {
            this._holdingForTTS = true;
            return; // TTS still playing — hold here
          }

          // Process any immediately-advanceable items in the same tick
          // (e.g. action badges right after text)
          this.advanceNonText();
        }
        // If fullyRevealed but !sealed: wait for more SSE deltas
        break;
      }

      // Non-text items are processed immediately
      case 'agent_start':
        this.currentAgentId = item.agentId;
        this.currentSegmentText = '';
        this.cb.onThinking(null); // Agent selected — clear thinking indicator
        this.cb.onAgentStart(item);
        this.cb.onLiveSpeech(null, item.agentId);
        this.readIndex++;
        this.charCursor = 0;
        this.advanceNonText();
        break;

      case 'agent_end':
        this.cb.onAgentEnd(item);
        this.readIndex++;
        this.charCursor = 0;
        this.advanceNonText();
        break;

      case 'action':
        this.currentSegmentText = '';
        this.cb.onActionReady(item.messageId, item);
        this.cb.onLiveSpeech(null, this.currentAgentId);
        this.readIndex++;
        this.charCursor = 0;
        // Delay after action so animations have time to play out
        if (this.actionDelayTicks > 0) {
          this._dwellTicksRemaining = this.actionDelayTicks;
          return;
        }
        this.advanceNonText();
        break;

      case 'thinking':
        this.cb.onThinking(item);
        this.readIndex++;
        this.charCursor = 0;
        this.advanceNonText();
        break;

      case 'cue_user':
        this.cb.onCueUser(item.fromAgentId, item.prompt);
        this.readIndex++;
        this.charCursor = 0;
        this.advanceNonText();
        break;

      case 'done':
        this.cb.onLiveSpeech(null, null);
        this.cb.onSpeechProgress(null);
        this.cb.onThinking(null);
        this.cb.onDone(item);
        this.readIndex++;
        this.charCursor = 0;
        // Stop the timer — nothing more to process
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        // Resolve drain promise
        this._drainResolve?.();
        this._drainResolve = null;
        this._drainReject = null;
        break;

      case 'error':
        this.cb.onError(item.message);
        this.readIndex++;
        this.charCursor = 0;
        this.advanceNonText();
        break;
    }
  }

  /**
   * After processing a non-text item, keep advancing through consecutive
   * non-text items in the same tick. Stop when we hit a text item or
   * the end of the queue — the next tick will handle the text item
   * (so we don't skip the character-by-character reveal).
   *
   * Also stops when an action triggers a delay so its animation can play.
   */
  private advanceNonText(): void {
    while (this.readIndex < this.items.length) {
      const next = this.items[this.readIndex];
      if (next.kind === 'text') break; // Let the next tick handle text

      switch (next.kind) {
        case 'agent_start':
          this.currentAgentId = next.agentId;
          this.currentSegmentText = '';
          this.cb.onThinking(null); // Agent selected — clear thinking indicator
          this.cb.onAgentStart(next);
          this.cb.onLiveSpeech(null, next.agentId);
          break;
        case 'agent_end':
          this.cb.onAgentEnd(next);
          break;
        case 'action':
          this.currentSegmentText = '';
          this.cb.onActionReady(next.messageId, next);
          this.cb.onLiveSpeech(null, this.currentAgentId);
          this.readIndex++;
          this.charCursor = 0;
          // Pause after action to let animation play
          if (this.actionDelayTicks > 0) {
            this._dwellTicksRemaining = this.actionDelayTicks;
            return; // resume on next tick after countdown
          }
          continue; // no delay — keep advancing
        case 'thinking':
          this.cb.onThinking(next);
          break;
        case 'cue_user':
          this.cb.onCueUser(next.fromAgentId, next.prompt);
          break;
        case 'done':
          this.cb.onLiveSpeech(null, null);
          this.cb.onSpeechProgress(null);
          this.cb.onThinking(null);
          this.cb.onDone(next);
          this.readIndex++;
          this.charCursor = 0;
          if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
          }
          // Resolve drain promise
          this._drainResolve?.();
          this._drainResolve = null;
          this._drainReject = null;
          return; // done — stop advancing
        case 'error':
          this.cb.onError(next.message);
          break;
      }
      this.readIndex++;
      this.charCursor = 0;
    }
  }
}
