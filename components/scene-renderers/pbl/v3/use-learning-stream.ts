'use client';
import { useEffect, useRef, useState } from 'react';
import {
  readLearningStream,
  LearningStreamError,
  type LearningSnapshot,
} from '@/lib/pbl/v3/event-stream';

export function useLearningStream(
  studyId: string | undefined,
  receive: (snapshot: LearningSnapshot) => void,
) {
  const receiver = useRef(receive);
  useEffect(() => {
    receiver.current = receive;
  }, [receive]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'retrying' | 'unavailable'>(
    'connecting',
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!studyId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1_000;
    let failures = 0;
    let unavailable = false;
    const connect = async () => {
      if (disposed || unavailable || document.visibilityState === 'hidden') return;
      setStatus(failures >= 3 ? 'retrying' : 'connecting');
      controller = new AbortController();
      const current = controller;
      try {
        await readLearningStream(studyId, current.signal, (snapshot) => {
          if (disposed || current.signal.aborted) return;
          failures = 0;
          backoff = 1_000;
          setStatus('connected');
          receiver.current(snapshot);
        });
      } catch (error) {
        if (disposed || current.signal.aborted) return;
        if (error instanceof LearningStreamError && [401, 403, 404].includes(error.status)) {
          unavailable = true;
          setStatus('unavailable');
          return;
        }
      }
      if (disposed || current.signal.aborted) return;
      failures++;
      setStatus(failures >= 3 ? 'retrying' : 'connecting');
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    const visible = () => {
      if (timer) clearTimeout(timer);
      controller?.abort();
      if (document.visibilityState === 'visible') void connect();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    void connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [studyId, attempt]);
  return { status, reconnect: () => setAttempt((value) => value + 1) };
}
