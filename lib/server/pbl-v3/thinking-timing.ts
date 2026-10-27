export interface ThinkingTiming {
  startedAt: number;
  endedAt?: number;
}

/** Persist tiny timing anchors with each replaceable snapshot, before throttling. */
export function createThinkingTimingTracker() {
  let timings: Record<number, ThinkingTiming> = {};
  return (type: string, data: unknown, now: number): unknown => {
    if (type === 'message_start') timings = {};
    if (!['message_start', 'message_update', 'message_end'].includes(type)) return data;
    const value = data as {
      message?: { role?: string; content?: { type?: string; text?: string; thinking?: string }[] };
    } | null;
    if (value?.message?.role !== 'assistant' || !Array.isArray(value.message.content)) return data;
    for (const [index, block] of value.message.content.entries()) {
      if (block?.type === 'thinking' && block.thinking) timings[index] ??= { startedAt: now };
      if (block?.type === 'text' && block.text) {
        for (const [prior, timing] of Object.entries(timings))
          if (Number(prior) < index) timing.endedAt ??= now;
      }
    }
    if (type === 'message_end') for (const timing of Object.values(timings)) timing.endedAt ??= now;
    return {
      ...value,
      pblThinkingTimings: Object.fromEntries(
        Object.entries(timings).map(([index, timing]) => [index, { ...timing }]),
      ),
    };
  };
}
