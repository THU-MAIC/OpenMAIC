import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { rateLimitByUser, requireAuthOrTeacher } from '@/lib/server/api-guard';

const log = createLogger('ClientDiagnostics');
const OUTCOMES = new Set(['success', 'failure']);
const BUCKETS = new Set(['lt_50ms', 'lt_250ms', 'lt_1s', 'gte_1s']);
const FAILURE_CODES = new Set(['validation', 'indexeddb', 'quota', 'identity', 'unknown']);
const PARITY_OUTCOMES = new Set([
  'match',
  'missing_document',
  'mismatch',
  'read_failure',
  'identity',
]);
const PARITY_FAILURE_CODES = new Set(['indexeddb', 'identity', 'unknown']);

/** Best-effort observability for client-only document bridge outcomes. */
export async function POST(request: NextRequest) {
  const guard = await requireAuthOrTeacher(['admin', 'teacher', 'learner']);
  if (!guard.ok) return guard.response;
  const rate = rateLimitByUser(guard.user.id, 'client-diagnostics', 30, 60_000);
  if (!rate.ok) return rate.response;

  try {
    const body = await request.json();
    if (body?.event === 'document_parity') {
      if (
        !PARITY_OUTCOMES.has(body.outcome) ||
        !BUCKETS.has(body.durationBucket) ||
        typeof body.parityVersion !== 'string'
      ) {
        return NextResponse.json(
          { success: false, error: 'Invalid parity diagnostic payload' },
          { status: 400 },
        );
      }
      if (body.outcome !== 'match' && typeof body.courseId !== 'string') {
        return NextResponse.json(
          { success: false, error: 'Invalid parity course id' },
          { status: 400 },
        );
      }
      if (body.errorCode && !PARITY_FAILURE_CODES.has(body.errorCode)) {
        return NextResponse.json(
          { success: false, error: 'Invalid parity error code' },
          { status: 400 },
        );
      }
      log.info('document_parity', {
        userId: guard.user.id,
        outcome: body.outcome,
        durationBucket: body.durationBucket,
        parityVersion: body.parityVersion,
        ...(body.outcome !== 'match' ? { courseId: body.courseId } : {}),
        ...(body.errorCode ? { errorCode: body.errorCode } : {}),
      });
      return NextResponse.json({ success: true });
    }
    if (
      body?.event !== 'document_bridge' ||
      !OUTCOMES.has(body.outcome) ||
      !BUCKETS.has(body.durationBucket) ||
      typeof body.bridgeVersion !== 'string'
    ) {
      return NextResponse.json(
        { success: false, error: 'Invalid diagnostic payload' },
        { status: 400 },
      );
    }
    if (body.outcome === 'failure') {
      if (typeof body.courseId !== 'string' || !FAILURE_CODES.has(body.errorCode)) {
        return NextResponse.json(
          { success: false, error: 'Invalid failure diagnostic' },
          { status: 400 },
        );
      }
    }

    log.info('document_bridge', {
      userId: guard.user.id,
      outcome: body.outcome,
      durationBucket: body.durationBucket,
      bridgeVersion: body.bridgeVersion,
      ...(body.outcome === 'failure' ? { courseId: body.courseId, errorCode: body.errorCode } : {}),
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
}
