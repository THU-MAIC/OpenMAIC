import type {
  BridgeDurationBucket,
  BridgeFailureCode,
  BridgeOutcome,
  DocumentParityFailureCode,
  DocumentParityOutcome,
} from './types';

export function durationBucket(durationMs: number): BridgeDurationBucket {
  if (durationMs < 50) return 'lt_50ms';
  if (durationMs < 250) return 'lt_250ms';
  if (durationMs < 1_000) return 'lt_1s';
  return 'gte_1s';
}

/**
 * Diagnostics are best-effort by design. Their failure must never affect the
 * course or its bridge state.
 */
export function reportBridgeDiagnostic(payload: {
  outcome: BridgeOutcome;
  durationMs: number;
  bridgeVersion: string;
  courseId?: string;
  errorCode?: BridgeFailureCode;
}): void {
  if (typeof window === 'undefined') return;
  const body = {
    event: 'document_bridge',
    outcome: payload.outcome,
    durationBucket: durationBucket(payload.durationMs),
    bridgeVersion: payload.bridgeVersion,
    // Success events deliberately omit courseId. Failed events include it so
    // operators can help a user with a specific broken local document.
    ...(payload.outcome === 'failure' && payload.courseId ? { courseId: payload.courseId } : {}),
    ...(payload.outcome === 'failure' && payload.errorCode ? { errorCode: payload.errorCode } : {}),
  };

  void fetch('/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // Deliberately ignored: observability is never on the user data path.
  });
}

export function reportDocumentParityDiagnostic(payload: {
  outcome: DocumentParityOutcome;
  durationMs: number;
  parityVersion: string;
  courseId?: string;
  errorCode?: DocumentParityFailureCode;
}): void {
  if (typeof window === 'undefined') return;
  void fetch('/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'document_parity',
      outcome: payload.outcome,
      durationBucket: durationBucket(payload.durationMs),
      parityVersion: payload.parityVersion,
      ...(payload.outcome !== 'match' && payload.courseId ? { courseId: payload.courseId } : {}),
      ...(payload.errorCode ? { errorCode: payload.errorCode } : {}),
    }),
    keepalive: true,
  }).catch(() => {});
}
