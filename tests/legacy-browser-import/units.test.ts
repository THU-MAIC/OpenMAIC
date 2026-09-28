/** The importer's pure parts: derived ids, failure classification, the ledger. */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/legacy-browser-import/digest';
import { classifyFailure } from '@/lib/legacy-browser-import/errors';
import { freshStageId, rewriteStageSegment } from '@/lib/legacy-browser-import/ids';
import {
  backoffMs,
  ensureLedger,
  LEDGER_KEY,
  ledgerIsSettled,
  loadLedger,
  recordHandoff,
  saveLedger,
} from '@/lib/legacy-browser-import/ledger';

import { MemoryStorage } from './harness';

describe('derived ids', () => {
  it('derives the same fresh id from the same salt and course, and different ones otherwise', () => {
    expect(freshStageId('course', 'salt-a')).toBe(freshStageId('course', 'salt-a'));
    expect(freshStageId('course', 'salt-a')).not.toBe(freshStageId('course', 'salt-b'));
    expect(freshStageId('course', 'salt-a')).not.toBe(freshStageId('course-2', 'salt-a'));
    expect(freshStageId('course', 'salt-a')).toMatch(/^course-i[0-9a-f]{16}$/);
    expect(freshStageId('course', 'salt-a')).toBe(
      `course-i${sha256Hex('salt-a\u0000course').slice(0, 16)}`,
    );
  });

  it('hashes with SHA-256 (standard test vectors)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    expect(sha256Hex('é中')).toBe(createHash('sha256').update('é中').digest('hex'));
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
    expect(failure(401, 'INVALID_CREDENTIAL').kind).toBe('unauthorized');
    expect(failure(401, 'INVALID_REQUEST').kind).toBe('unauthorized');
    expect(failure(403, 'OWNER_RETIRED').kind).toBe('retired');
    expect(failure(403, 'FORBIDDEN_LEARNER').kind).toBe('owner-changed');
    expect(failure(413, 'PAYLOAD_TOO_LARGE')).toMatchObject({
      kind: 'permanent',
      code: 'PAYLOAD_TOO_LARGE',
    });
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
    expect(classifyFailure(wrapped).kind).toBe('retired');
  });
});

describe('the ledger', () => {
  it('is one key per browser with a random salt, and survives a round trip', () => {
    const storage = new MemoryStorage();
    const ledger = ensureLedger(storage);
    expect(ledger.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(ensureLedger(storage).salt).toBe(ledger.salt);
    ledger.courses.c = { status: 'done', steps: { document: 'done' } };
    saveLedger(storage, ledger);
    expect([...storage.values.keys()]).toEqual([LEDGER_KEY]);
    expect(loadLedger(storage)).toEqual(ledger);
    expect(ensureLedger(new MemoryStorage()).salt).not.toBe(ledger.salt);
  });

  it('starts over from an unreadable or old-format ledger', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEDGER_KEY, '{not json');
    expect(loadLedger(storage)).toBeUndefined();
    storage.setItem(LEDGER_KEY, JSON.stringify({ version: 1, courses: {}, folders: {} }));
    expect(loadLedger(storage)).toBeUndefined();
  });

  it('merges what another tab stored instead of overwriting it', () => {
    const storage = new MemoryStorage();
    const tabA = ensureLedger(storage);
    const tabB = structuredClone(tabA);
    tabA.courses.c1 = {
      status: 'pending',
      steps: { document: 'done', media: 'done' },
      sessions: { s1: 's1' },
    };
    saveLedger(storage, tabA);
    tabB.courses.c2 = { status: 'done', steps: { document: 'done' } };
    tabB.courses.c1 = { status: 'pending', steps: {}, sessions: { s2: 's2' } };
    saveLedger(storage, tabB);
    const stored = loadLedger(storage)!;
    expect(Object.keys(stored.courses).sort()).toEqual(['c1', 'c2']);
    expect(stored.courses.c1!.steps).toEqual({ document: 'done', media: 'done' });
    expect(stored.courses.c1!.sessions).toEqual({ s1: 's1', s2: 's2' });
  });

  it('keeps the stored claiming owner and completion when a stale tab saves', () => {
    const storage = new MemoryStorage();
    const tabA = ensureLedger(storage);
    const tabB = structuredClone(tabA);
    tabA.ownerDigest = 'a'.repeat(64);
    tabA.completedAt = 5;
    saveLedger(storage, tabA);
    tabB.ownerDigest = 'b'.repeat(64);
    saveLedger(storage, tabB);
    expect(loadLedger(storage)).toMatchObject({ ownerDigest: 'a'.repeat(64), completedAt: 5 });

    // A confirmed handoff from exactly that owner does replace it.
    const tabC = structuredClone(loadLedger(storage)!);
    recordHandoff(tabC, tabC.ownerDigest!);
    tabC.ownerDigest = 'c'.repeat(64);
    saveLedger(storage, tabC);
    expect(loadLedger(storage)?.ownerDigest).toBe('c'.repeat(64));
  });

  it('is settled only when nothing is pending', () => {
    const ledger = ensureLedger(new MemoryStorage());
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
