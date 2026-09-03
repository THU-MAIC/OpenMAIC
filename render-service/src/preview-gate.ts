export type PreviewRejectionReason =
  | 'preview_queue_full'
  | 'preview_per_user_limit'
  | 'capacity_busy';

/** Thrown when admission control rejects a preview (mapped to HTTP 429). */
export class PreviewRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: PreviewRejectionReason,
  ) {
    super(message);
  }
}

/** Independent admission control for synchronous single-page previews. */
export class PreviewGate {
  private inFlight = 0;
  private readonly activeByIdentity = new Map<string, number>();

  constructor(
    private readonly maxInFlight: number,
    private readonly maxPerUser: number,
  ) {}

  /**
   * Claim a slot before the request body is buffered. The returned release
   * function is idempotent so every route exit can safely call it once.
   */
  acquire(identity: string): () => void {
    if (this.inFlight >= this.maxInFlight) {
      throw new PreviewRejectedError(
        'The preview queue is full; try again shortly.',
        'preview_queue_full',
      );
    }

    const active = this.activeByIdentity.get(identity) ?? 0;
    if (this.maxPerUser > 0 && active >= this.maxPerUser) {
      throw new PreviewRejectedError(
        `Too many concurrent previews (limit ${this.maxPerUser}).`,
        'preview_per_user_limit',
      );
    }

    this.inFlight += 1;
    this.activeByIdentity.set(identity, active + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.inFlight = Math.max(0, this.inFlight - 1);
      const remaining = (this.activeByIdentity.get(identity) ?? 0) - 1;
      if (remaining <= 0) this.activeByIdentity.delete(identity);
      else this.activeByIdentity.set(identity, remaining);
    };
  }
}
