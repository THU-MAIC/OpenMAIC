import type { LearningView } from './types';
import type { LearningWorkbench } from './workbench';

export interface LearningSnapshot {
  view: LearningView;
  workbench: LearningWorkbench | null;
}

/** Fetch keeps the sandbox's deliberate-client header; native EventSource cannot. */
export async function readLearningStream(
  studyId: string,
  signal: AbortSignal,
  receive: (snapshot: LearningSnapshot) => void,
): Promise<void> {
  const response = await fetch(`/api/pbl/v3/events?id=${encodeURIComponent(studyId)}`, {
    headers: { 'x-openmaic-sandbox': '1', accept: 'text/event-stream' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new LearningStreamError(response.status);
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
    throw new Error('Invalid learning event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        let event = '',
          data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (event === 'unavailable') throw new LearningStreamError(404);
        if (event === 'retry') throw new LearningStreamError(503);
        if (event === 'learning') {
          const snapshot = JSON.parse(data) as LearningSnapshot;
          if (snapshot.view.id !== studyId) throw new Error('Unexpected learning session.');
          if (!signal.aborted) receive(snapshot);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class LearningStreamError extends Error {
  constructor(readonly status: number) {
    super('Learning event stream is unavailable.');
  }
}
