import type { LearningView } from './types';
import type { LearningWorkbench } from './workbench';

export interface LearningSnapshot {
  view: LearningView;
  workbench: LearningWorkbench | null;
}

/** Subscription recovery only; this never limits or cancels Agent execution. */
export const LEARNING_STREAM_IDLE_MS = 90_000;

/** Fetch keeps the sandbox's deliberate-client header; native EventSource cannot. */
export async function readLearningStream(
  studyId: string,
  signal: AbortSignal,
  receive: (snapshot: LearningSnapshot) => void,
): Promise<void> {
  if (signal.aborted) return;
  const connection = new AbortController();
  const cancel = () => connection.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  const confirm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => connection.abort(new LearningStreamError(408)),
      LEARNING_STREAM_IDLE_MS,
    );
  };
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(connection.signal.reason);
    connection.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = async () => {
    const response = await fetch(`/api/pbl/v3/events?id=${encodeURIComponent(studyId)}`, {
      headers: { 'x-openmaic-sandbox': '1', accept: 'text/event-stream' },
      cache: 'no-store',
      signal: connection.signal,
    });
    if (connection.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) throw new LearningStreamError(response.status);
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
      throw new Error('Invalid learning event stream.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let receivedSnapshot = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (connection.signal.aborted || done) return;
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
          if (connection.signal.aborted) return;
          confirm();
          receivedSnapshot = true;
          receive(snapshot);
        } else if (event === 'observed') {
          if (JSON.parse(data).id !== studyId) throw new Error('Unexpected learning session.');
          // Confirmation of an unchanged projection cannot replace the initial snapshot.
          if (receivedSnapshot) confirm();
        }
      }
      // A large snapshot can take longer than the idle window to transfer.
      // Count its incoming data, but never transport-only comments such as ': ping'.
      if (
        value?.byteLength &&
        pending.startsWith('event: learning\n') &&
        pending.includes('\ndata:')
      )
        confirm();
    }
  };
  confirm();
  try {
    // Also settles if a transport implementation ignores cancellation.
    await Promise.race([read(), aborted]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel);
    connection.signal.removeEventListener('abort', rejectAborted);
    connection.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export class LearningStreamError extends Error {
  constructor(readonly status: number) {
    super('Learning event stream is unavailable.');
  }
}
