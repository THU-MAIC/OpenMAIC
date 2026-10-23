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
  const [status, setStatus] = useState<'connecting' | 'connected' | 'unavailable'>('connecting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!studyId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1_000;
    const connect = async () => {
      if (disposed || document.visibilityState === 'hidden') return;
      setStatus('connecting');
      controller = new AbortController();
      const current = controller;
      try {
        await readLearningStream(studyId, current.signal, (snapshot) => {
          backoff = 1_000;
          setStatus('connected');
          receiver.current(snapshot);
        });
      } catch (error) {
        if (disposed || current.signal.aborted) return;
        if (error instanceof LearningStreamError && [401, 403, 404].includes(error.status)) {
          setStatus('unavailable');
          return;
        }
      }
      if (disposed || current.signal.aborted) return;
      setStatus('connecting');
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    const visible = () => {
      if (timer) clearTimeout(timer);
      controller?.abort();
      if (document.visibilityState === 'visible') void connect();
    };
    document.addEventListener('visibilitychange', visible);
    void connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visible);
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [studyId, attempt]);
  return { status, reconnect: () => setAttempt((value) => value + 1) };
}
