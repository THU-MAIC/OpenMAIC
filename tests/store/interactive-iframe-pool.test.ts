import { beforeEach, describe, expect, test } from 'vitest';
import { IFRAME_POOL_CAP, useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';

function reset() {
  useInteractiveIframePool.getState().reset();
}

const pool = () => useInteractiveIframePool.getState();

beforeEach(reset);

describe('mount', () => {
  test('creates an entry with the given content', () => {
    pool().mount('s1', { srcDoc: '<p>1</p>' });
    const e = pool().entries['s1'];
    expect(e).toBeDefined();
    expect(e.srcDoc).toBe('<p>1</p>');
  });

  test('re-mounting with equal content keeps the entry (no reload)', () => {
    pool().mount('s1', { srcDoc: '<p>1</p>' });
    const first = pool().entries['s1'].srcDoc;
    // A remount recomputes an equal-but-new string; value equality must still
    // hit the keep-alive fast path so the host never re-sets srcDoc.
    pool().mount('s1', { srcDoc: ['<p>', '1', '</p>'].join('') });
    expect(pool().entries['s1'].srcDoc).toBe(first);
    expect(Object.keys(pool().entries)).toHaveLength(1);
  });

  test('re-mounting with changed content replaces it (intended reload)', () => {
    pool().mount('s1', { srcDoc: '<p>1</p>' });
    pool().mount('s1', { srcDoc: '<p>2</p>' });
    expect(pool().entries['s1'].srcDoc).toBe('<p>2</p>');
  });

  test('supports url-backed (src) entries', () => {
    pool().mount('s1', { src: 'https://x/widget' });
    expect(pool().entries['s1'].src).toBe('https://x/widget');
    expect(pool().entries['s1'].srcDoc).toBeUndefined();
  });
});

describe('visibility ownership + rect + active', () => {
  test('release keeps the entry alive but clears its owner', () => {
    pool().mount('s1', { srcDoc: 'x' });
    pool().claim('s1', 'ownerA');
    expect(pool().entries['s1'].owner).toBe('ownerA');
    pool().release('s1', 'ownerA');
    expect(pool().entries['s1']).toBeDefined(); // keep-alive
    expect(pool().entries['s1'].owner).toBeNull();
  });

  test('a stale release (wrong owner) does NOT clear a re-claimed entry', () => {
    // Models the mode cross-fade: a newer placeholder re-claims the scene, then
    // the outgoing placeholder's unmount cleanup fires with its old owner id.
    pool().mount('s1', { srcDoc: 'x' });
    pool().claim('s1', 'old');
    pool().claim('s1', 'new'); // newer placeholder takes over
    pool().release('s1', 'old'); // stale cleanup must not hide it
    expect(pool().entries['s1'].owner).toBe('new');
  });

  test('setRect updates the tracked rect', () => {
    pool().mount('s1', { srcDoc: 'x' });
    pool().setRect('s1', { left: 1, top: 2, width: 3, height: 4 });
    expect(pool().entries['s1'].rect).toEqual({ left: 1, top: 2, width: 3, height: 4 });
  });

  test('setActive records the active scene', () => {
    pool().mount('s1', { srcDoc: 'x' });
    pool().setActive('s1');
    expect(pool().activeSceneId).toBe('s1');
  });

  test('setRect / claim / release on an unknown scene are no-ops', () => {
    pool().setRect('ghost', { left: 0, top: 0, width: 0, height: 0 });
    pool().claim('ghost', 'o');
    pool().release('ghost', 'o');
    expect(pool().entries['ghost']).toBeUndefined();
  });
});

describe('LRU eviction', () => {
  test(`evicts the least-recently-mounted entry beyond CAP (${IFRAME_POOL_CAP})`, () => {
    for (let i = 0; i < IFRAME_POOL_CAP + 1; i++) {
      pool().mount(`s${i}`, { srcDoc: `x${i}` });
    }
    expect(Object.keys(pool().entries)).toHaveLength(IFRAME_POOL_CAP);
    expect(pool().entries['s0']).toBeUndefined(); // oldest evicted
    expect(pool().entries[`s${IFRAME_POOL_CAP}`]).toBeDefined(); // newest kept
  });

  test('never evicts the active scene even if it is the oldest', () => {
    pool().mount('s0', { srcDoc: 'x0' });
    pool().setActive('s0');
    for (let i = 1; i < IFRAME_POOL_CAP + 1; i++) {
      pool().mount(`s${i}`, { srcDoc: `x${i}` });
    }
    expect(pool().entries['s0']).toBeDefined(); // active survives
    expect(Object.keys(pool().entries)).toHaveLength(IFRAME_POOL_CAP);
  });

  test('re-mounting an existing entry refreshes its recency', () => {
    pool().mount('s0', { srcDoc: 'x0' });
    pool().mount('s1', { srcDoc: 'x1' });
    pool().mount('s2', { srcDoc: 'x2' });
    pool().mount('s0', { srcDoc: 'x0' }); // touch s0 -> s1 now oldest
    pool().mount('s3', { srcDoc: 'x3' });
    expect(pool().entries['s1']).toBeUndefined();
    expect(pool().entries['s0']).toBeDefined();
  });
});

describe('evict / reset', () => {
  test('evict removes an entry explicitly', () => {
    pool().mount('s1', { srcDoc: 'x' });
    pool().evict('s1');
    expect(pool().entries['s1']).toBeUndefined();
  });

  test('reset clears all entries and active scene', () => {
    pool().mount('s1', { srcDoc: 'x' });
    pool().setActive('s1');
    pool().reset();
    expect(Object.keys(pool().entries)).toHaveLength(0);
    expect(pool().activeSceneId).toBeNull();
  });
});
