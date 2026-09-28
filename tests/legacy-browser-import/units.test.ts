/** The importer's pure parts: derived ids, failure classification, the ledger. */
import { describe, expect, it } from 'vitest';

import { classifyFailure } from '@/lib/legacy-browser-import/errors';
import { freshStageId, rewriteStageSegment } from '@/lib/legacy-browser-import/ids';
import {
  backoffMs,
  emptyLedger,
  ledgerIsSettled,
  ledgerKey,
  loadLedger,
  saveLedger,
} from '@/lib/legacy-browser-import/ledger';

import { MemoryStorage } from './harness';

describe('derived ids', () => {
  it('derives the same fresh id for the same owner and course, and different ones otherwise', () => {
    expect(freshStageId('course', 'anon:a')).toBe(freshStageId('course', 'anon:a'));
    expect(freshStageId('course', 'anon:a')).not.toBe(freshStageId('course', 'anon:b'));
    expect(freshStageId('course', 'anon:a')).not.toBe(freshStageId('course-2', 'anon:a'));
    expect(freshStageId('course', 'anon:a')).toMatch(/^course-i[0-9a-f]{12}$/);
  });

  it('carries the course segment of session ids, encoded and raw, and nothing else', () => {
    expect(rewriteStageSegment('chat:my%20course:anon%3Ax:chat-1', 'my course', 'new id')).toBe(
      'chat:new%20id:anon%3Ax:chat-1',
    );
    expect(rewriteStageSegment('pbl-my course-anon:x', 'my course', 'new id')).toBe(
      'pbl-new id-anon:x',
    );
    expect(rewriteStageSegment('chat:c1:anon%3Ax:c', 'c1', 'c1')).toBe('chat:c1:anon%3Ax:c');
    expect(rewriteStageSegment('random-id', 'c1', 'c2')).toBe('random-id');
  });
});

describe('failure classification', () => {
  const failure = (status: number, code?: string, extra: object = {}) =>
    classifyFailure(Object.assign(new Error('x'), { status, code, ...extra }));

  it('reads the persistence clients’ status and code', () => {
    expect(classifyFailure(new TypeError('Failed to fetch')).kind).toBe('transient');
    expect(failure(500).kind).toBe('transient');
    expect(failure(409, 'CONFLICT').kind).toBe('transient');
    expect(failure(429).kind).toBe('transient');
    expect(failure(503, 'OWNER_BUSY')).toMatchObject({ kind: 'busy', retryAfterMs: 2_000 });
    expect(failure(503, 'OWNER_BUSY', { retryAfterMs: 7_000 }).retryAfterMs).toBe(7_000);
    expect(failure(401, 'INVALID_CREDENTIAL').kind).toBe('owner');
    expect(failure(403, 'OWNER_RETIRED').kind).toBe('owner');
    expect(failure(403, 'FORBIDDEN').kind).toBe('forbidden');
    expect(failure(404, 'DOCUMENT_NOT_FOUND').kind).toBe('not-found');
    expect(failure(507, 'ASSET_QUOTA_EXCEEDED').kind).toBe('quota');
    expect(failure(400, 'VALIDATION_FAILED')).toMatchObject({
      kind: 'permanent',
      reason: '400 VALIDATION_FAILED',
    });
  });

  it('finds the status on a wrapped cause', () => {
    const wrapped = new Error('write-back failed', {
      cause: Object.assign(new Error('x'), { status: 403, code: 'OWNER_RETIRED' }),
    });
    expect(classifyFailure(wrapped).kind).toBe('owner');
  });
});

describe('the ledger', () => {
  it('is keyed by owner and survives a round trip', () => {
    const storage = new MemoryStorage();
    const ledger = emptyLedger('anon:a');
    ledger.courses.c = { status: 'done', steps: { document: 'done' } };
    saveLedger(storage, ledger);
    expect(storage.getItem(ledgerKey('anon:a'))).not.toBeNull();
    expect(loadLedger(storage, 'anon:a')).toEqual(ledger);
    expect(loadLedger(storage, 'anon:b')).toEqual(emptyLedger('anon:b'));
  });

  it('starts over from an unreadable or foreign ledger', () => {
    const storage = new MemoryStorage();
    storage.setItem(ledgerKey('anon:a'), '{not json');
    expect(loadLedger(storage, 'anon:a')).toEqual(emptyLedger('anon:a'));
    storage.setItem(ledgerKey('anon:a'), JSON.stringify({ ...emptyLedger('anon:b') }));
    expect(loadLedger(storage, 'anon:a')).toEqual(emptyLedger('anon:a'));
  });

  it('is settled only when nothing is pending', () => {
    const ledger = emptyLedger('anon:a');
    expect(ledgerIsSettled(ledger)).toBe(true);
    ledger.courses.c = { status: 'pending', steps: {} };
    expect(ledgerIsSettled(ledger)).toBe(false);
    ledger.courses.c.status = 'failed';
    ledger.folders.f = { status: 'pending' };
    expect(ledgerIsSettled(ledger)).toBe(false);
  });

  it('backs off from 30 s, doubling, up to six hours', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(100)).toBe(6 * 60 * 60 * 1000);
  });
});
