import { beforeEach, describe, expect, test } from 'vitest';
import {
  IFRAME_POOL_CAP,
  hashContent,
  useInteractiveIframePool,
} from '@/lib/store/interactive-iframe-pool';

function reset() {
  useInteractiveIframePool.setState({ entries: {}, activeSceneId: null, tick: 0 });
}

const pool = () => useInteractiveIframePool.getState();

beforeEach(reset);

describe('hashContent', () => {
  test('is stable for the same input and differs for changed input', () => {
    expect(hashContent('<h1>a</h1>')).toBe(hashContent('<h1>a</h1>'));
    expect(hashContent('<h1>a</h1>')).not.toBe(hashContent('<h1>b</h1>'));
  });
});

describe('mount', () => {
  test('creates an entry with the given content', () => {
    pool().mount('s1', { srcDoc: '<p>1</p>', hash: hashContent('<p>1</p>') });
    const e = pool().entries['s1'];
    expect(e).toBeDefined();
    expect(e.srcDoc).toBe('<p>1</p>');
    expect(e.hash).toBe(hashContent('<p>1</p>'));
  });

  test('re-mounting with the same hash does NOT replace srcDoc (no reload)', () => {
    const html = '<p>1</p>';
    pool().mount('s1', { srcDoc: html, hash: hashContent(html) });
    const first = pool().entries['s1'].srcDoc;
    pool().mount('s1', { srcDoc: html, hash: hashContent(html) });
    expect(pool().entries['s1'].srcDoc).toBe(first); // same reference -> iframe untouched
    expect(Object.keys(pool().entries)).toHaveLength(1);
  });

  test('re-mounting with a new hash replaces the content (intended reload)', () => {
    pool().mount('s1', { srcDoc: '<p>1</p>', hash: hashContent('<p>1</p>') });
    pool().mount('s1', { srcDoc: '<p>2</p>', hash: hashContent('<p>2</p>') });
    expect(pool().entries['s1'].srcDoc).toBe('<p>2</p>');
    expect(pool().entries['s1'].hash).toBe(hashContent('<p>2</p>'));
  });

  test('supports url-backed (src) entries', () => {
    pool().mount('s1', { src: 'https://x/widget', hash: hashContent('https://x/widget') });
    expect(pool().entries['s1'].src).toBe('https://x/widget');
    expect(pool().entries['s1'].srcDoc).toBeUndefined();
  });
});

describe('visibility + rect + active', () => {
  test('hide keeps the entry alive but not visible', () => {
    pool().mount('s1', { srcDoc: 'x', hash: 'h' });
    pool().show('s1');
    expect(pool().entries['s1'].visible).toBe(true);
    pool().hide('s1');
    expect(pool().entries['s1']).toBeDefined(); // keep-alive
    expect(pool().entries['s1'].visible).toBe(false);
  });

  test('setRect updates the tracked rect', () => {
    pool().mount('s1', { srcDoc: 'x', hash: 'h' });
    pool().setRect('s1', { left: 1, top: 2, width: 3, height: 4 });
    expect(pool().entries['s1'].rect).toEqual({ left: 1, top: 2, width: 3, height: 4 });
  });

  test('setActive records the active scene', () => {
    pool().mount('s1', { srcDoc: 'x', hash: 'h' });
    pool().setActive('s1');
    expect(pool().activeSceneId).toBe('s1');
  });

  test('setRect / show / hide on an unknown scene are no-ops', () => {
    pool().setRect('ghost', { left: 0, top: 0, width: 0, height: 0 });
    pool().show('ghost');
    pool().hide('ghost');
    expect(pool().entries['ghost']).toBeUndefined();
  });
});

describe('LRU eviction', () => {
  test(`evicts the least-recently-mounted entry beyond CAP (${IFRAME_POOL_CAP})`, () => {
    for (let i = 0; i < IFRAME_POOL_CAP + 1; i++) {
      pool().mount(`s${i}`, { srcDoc: `x${i}`, hash: `h${i}` });
    }
    expect(Object.keys(pool().entries)).toHaveLength(IFRAME_POOL_CAP);
    expect(pool().entries['s0']).toBeUndefined(); // oldest evicted
    expect(pool().entries[`s${IFRAME_POOL_CAP}`]).toBeDefined(); // newest kept
  });

  test('never evicts the active scene even if it is the oldest', () => {
    pool().mount('s0', { srcDoc: 'x0', hash: 'h0' });
    pool().setActive('s0');
    for (let i = 1; i < IFRAME_POOL_CAP + 1; i++) {
      pool().mount(`s${i}`, { srcDoc: `x${i}`, hash: `h${i}` });
    }
    expect(pool().entries['s0']).toBeDefined(); // active survives
    expect(Object.keys(pool().entries)).toHaveLength(IFRAME_POOL_CAP);
  });

  test('re-mounting an existing entry refreshes its recency', () => {
    pool().mount('s0', { srcDoc: 'x0', hash: 'h0' });
    pool().mount('s1', { srcDoc: 'x1', hash: 'h1' });
    pool().mount('s2', { srcDoc: 'x2', hash: 'h2' });
    pool().mount('s0', { srcDoc: 'x0', hash: 'h0' }); // touch s0 -> s1 now oldest
    pool().mount('s3', { srcDoc: 'x3', hash: 'h3' });
    expect(pool().entries['s1']).toBeUndefined();
    expect(pool().entries['s0']).toBeDefined();
  });
});

describe('evict', () => {
  test('removes an entry explicitly', () => {
    pool().mount('s1', { srcDoc: 'x', hash: 'h' });
    pool().evict('s1');
    expect(pool().entries['s1']).toBeUndefined();
  });
});
