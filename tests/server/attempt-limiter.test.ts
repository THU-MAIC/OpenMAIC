import { describe, expect, test } from 'vitest';

import {
  AccessCodeAttemptLimiter,
  ATTEMPT_LIMIT_MAX_IDENTITY_LENGTH,
  SlidingWindowFailureLimiter,
  boundIdentityKey,
} from '@/lib/server/attempt-limiter';

describe('SlidingWindowFailureLimiter (trusted identities)', () => {
  test('reserves one attempt per consume and reports a positive retry-after at the budget', () => {
    let now = 0;
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.consume('a').limited).toBe(false);
    now = 1000;
    expect(limiter.consume('a').limited).toBe(false);
    now = 2000;
    expect(limiter.consume('a').limited).toBe(false);

    const status = limiter.consume('a');
    expect(status.limited).toBe(true);
    expect(Number.isInteger(status.retryAfterSeconds)).toBe(true);
    expect(status.retryAfterSeconds).toBe(58);
  });

  test('drops reservations once they fall outside the sliding window', () => {
    let now = 0;
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 2,
      windowMs: 1000,
      now: () => now,
    });

    limiter.consume('a');
    now = 500;
    limiter.consume('a');
    expect(limiter.consume('a').limited).toBe(true);

    // The first reservation leaves the window; only the second remains.
    now = 1001;
    expect(limiter.consume('a').limited).toBe(false);
  });

  test('recordSuccess releases the identity reservations', () => {
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      now: () => 0,
    });

    limiter.consume('a');
    limiter.consume('a');
    expect(limiter.consume('a').limited).toBe(true);

    limiter.recordSuccess('a');
    expect(limiter.consume('a').limited).toBe(false);
  });

  test('bounds the number of tracked identities by evicting the oldest', () => {
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      maxIdentities: 2,
      now: () => 0,
    });

    limiter.consume('a');
    limiter.consume('b');
    limiter.consume('c');

    // 'a' is the oldest and was evicted; 'c' is still tracked and limited.
    expect(limiter.consume('a').limited).toBe(false);
    expect(limiter.consume('c').limited).toBe(true);
  });

  test('stores only a small copied key for a 64,000-character identity', () => {
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 5,
      windowMs: 60_000,
      now: () => 0,
    });
    const longIdentity = 'x'.repeat(64_000);

    limiter.consume(longIdentity);

    const keys = limiter.getTrackedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].length).toBeLessThanOrEqual(ATTEMPT_LIMIT_MAX_IDENTITY_LENGTH);
    expect(boundIdentityKey(longIdentity)).toHaveLength(ATTEMPT_LIMIT_MAX_IDENTITY_LENGTH);
  });

  test('maps distinct identities to distinct buckets, including long ones', () => {
    const limiter = new SlidingWindowFailureLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      now: () => 0,
    });

    const longA = '1'.repeat(500);
    const longB = '2'.repeat(500);
    expect(boundIdentityKey(longA)).not.toBe(boundIdentityKey(longB));

    limiter.consume(longA);
    expect(limiter.consume(longA).limited).toBe(true);
    expect(limiter.consume(longB).limited).toBe(false);

    // Realistic forwarded IPs are distinct identities too.
    const ipv6A = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const ipv6B = '2001:0db8:85a3:0000:0000:8a2e:0370:7335';
    expect(boundIdentityKey(ipv6A)).not.toBe(boundIdentityKey(ipv6B));
  });
});

describe('AccessCodeAttemptLimiter facade', () => {
  test('always allows untrusted callers and stores no state', () => {
    const limiter = new AccessCodeAttemptLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      now: () => 0,
    });

    for (let i = 0; i < 50; i += 1) {
      expect(limiter.consume(`shared-${i}`, false)).toEqual({
        limited: false,
        retryAfterSeconds: 0,
      });
    }
    expect(limiter.getTrackedKeys()).toEqual([]);
  });

  test('routes trusted callers through the sliding window', () => {
    const limiter = new AccessCodeAttemptLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      now: () => 0,
    });

    expect(limiter.consume('a', true).limited).toBe(false);
    expect(limiter.consume('a', true).limited).toBe(false);
    expect(limiter.consume('a', true).limited).toBe(true);

    // A different trusted identity has its own window.
    expect(limiter.consume('b', true).limited).toBe(false);
  });

  test('recordSuccess clears a trusted identity but leaves untrusted callers alone', () => {
    const limiter = new AccessCodeAttemptLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      now: () => 0,
    });

    limiter.consume('x', true);
    limiter.consume('x', true);
    expect(limiter.consume('x', true).limited).toBe(true);
    limiter.recordSuccess('x', true);
    expect(limiter.consume('x', true).limited).toBe(false);

    // Untrusted callers never accumulate state, so recordSuccess is a no-op.
    limiter.recordSuccess('y', false);
    expect(limiter.getTrackedKeys()).toEqual(['x']);
  });
});
