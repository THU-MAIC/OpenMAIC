import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  groupMemberIds,
  isSelectionModifier,
  resolveClickSelection,
  uniqIds,
} from '../../../src/editing/core/selection';

const box = (o: Partial<PPTElement> = {}) =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 100,
    width: 100,
    height: 60,
    rotate: 0,
    ...o,
  }) as unknown as PPTElement;

const a = box({ id: 'a' });
const b = box({ id: 'b', left: 300 });
const c = box({ id: 'c', left: 500 });
const g1 = box({ id: 'g1', left: 50, groupId: 'G' });
const g2 = box({ id: 'g2', left: 200, groupId: 'G' });

describe('isSelectionModifier / uniqIds', () => {
  it('any of ctrl/shift/meta counts as a modifier', () => {
    expect(isSelectionModifier({ ctrlKey: true, shiftKey: false, metaKey: false })).toBe(true);
    expect(isSelectionModifier({ ctrlKey: false, shiftKey: true, metaKey: false })).toBe(true);
    expect(isSelectionModifier({ ctrlKey: false, shiftKey: false, metaKey: true })).toBe(true);
    expect(isSelectionModifier({ ctrlKey: false, shiftKey: false, metaKey: false })).toBe(false);
  });

  it('uniqIds dedups preserving first-seen order', () => {
    expect(uniqIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('groupMemberIds', () => {
  it('an ungrouped element is its own unit', () => {
    expect(groupMemberIds(a, [a, b, g1, g2])).toEqual(['a']);
  });

  it('a grouped element expands to every member of its group, in element order', () => {
    expect(groupMemberIds(g2, [a, g1, b, g2])).toEqual(['g1', 'g2']);
  });
});

describe('resolveClickSelection — modifier table (ungrouped)', () => {
  const elements = [a, b, c];

  it('not selected + plain: selects only the element and arms a drag', () => {
    const r = resolveClickSelection({
      element: b,
      elements,
      selection: { elementIds: ['a'], primaryId: 'a' },
      modifier: false,
    });
    expect(r.next).toEqual({ elementIds: ['b'], primaryId: 'b' });
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['b']);
  });

  it('not selected + modifier: ADDS the element (uniq), no drag', () => {
    const r = resolveClickSelection({
      element: b,
      elements,
      selection: { elementIds: ['a'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['a', 'b'], primaryId: 'b' });
    expect(r.armDrag).toBe(false);
  });

  it('selected + modifier: REMOVES the element, no drag', () => {
    const r = resolveClickSelection({
      element: b,
      elements,
      selection: { elementIds: ['a', 'b'], primaryId: 'b' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['a'], primaryId: 'a' });
    expect(r.armDrag).toBe(false);
  });

  it('selected + modifier on the LAST element is a guarded no-op (never empties)', () => {
    const r = resolveClickSelection({
      element: a,
      elements,
      selection: { elementIds: ['a'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toBeNull();
    expect(r.armDrag).toBe(false);
  });

  it('selected + plain: keeps the whole selection, re-points primary, arms a multi drag', () => {
    const r = resolveClickSelection({
      element: b,
      elements,
      selection: { elementIds: ['a', 'b'], primaryId: 'a' },
      modifier: false,
    });
    expect(r.next).toEqual({ elementIds: ['a', 'b'], primaryId: 'b' });
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['a', 'b']);
  });

  it('selected + plain on the current primary emits nothing (no redundant re-emit)', () => {
    const r = resolveClickSelection({
      element: a,
      elements,
      selection: { elementIds: ['a', 'b'], primaryId: 'a' },
      modifier: false,
    });
    expect(r.next).toBeNull();
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['a', 'b']);
  });
});

describe('resolveClickSelection — primary preservation on subtractive click', () => {
  const elements = [a, b, c];

  it('preserves the current primary when it SURVIVES the removal', () => {
    const r = resolveClickSelection({
      element: c,
      elements,
      selection: { elementIds: ['a', 'b', 'c'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['a', 'b'], primaryId: 'a' });
  });

  it('reassigns primary (last remaining) only when the primary itself was removed', () => {
    const r = resolveClickSelection({
      element: a,
      elements,
      selection: { elementIds: ['a', 'b', 'c'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['b', 'c'], primaryId: 'c' });
  });
});

describe('resolveClickSelection — group cohesion', () => {
  const elements = [a, g1, g2, b];

  it('plain-click on a grouped element selects ALL members (primary = clicked)', () => {
    const r = resolveClickSelection({
      element: g2,
      elements,
      selection: { elementIds: [] },
      modifier: false,
    });
    expect(r.next).toEqual({ elementIds: ['g1', 'g2'], primaryId: 'g2' });
    expect(r.armDrag).toBe(true);
    // The armed drag translates the whole group.
    expect(r.dragIds).toEqual(['g1', 'g2']);
  });

  it('modifier-add on a grouped element adds the whole group (uniq)', () => {
    const r = resolveClickSelection({
      element: g1,
      elements,
      selection: { elementIds: ['a'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['a', 'g1', 'g2'], primaryId: 'g1' });
    expect(r.armDrag).toBe(false);
  });

  it('modifier-remove on a grouped element removes the whole group', () => {
    const r = resolveClickSelection({
      element: g1,
      elements,
      selection: { elementIds: ['a', 'g1', 'g2'], primaryId: 'a' },
      modifier: true,
    });
    expect(r.next).toEqual({ elementIds: ['a'], primaryId: 'a' });
  });

  it('modifier-remove of a group that IS the whole selection is a guarded no-op', () => {
    const r = resolveClickSelection({
      element: g2,
      elements,
      selection: { elementIds: ['g1', 'g2'], primaryId: 'g1' },
      modifier: true,
    });
    expect(r.next).toBeNull();
  });

  it('plain-click on a partially selected group member normalizes to the whole group', () => {
    const r = resolveClickSelection({
      element: g1,
      elements,
      selection: { elementIds: ['g1'], primaryId: 'g1' },
      modifier: false,
    });
    expect(r.next).toEqual({ elementIds: ['g1', 'g2'], primaryId: 'g1' });
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['g1', 'g2']);
  });

  it('plain-click on a partial group plus an ungrouped member normalizes both selection and drag ids', () => {
    const r = resolveClickSelection({
      element: g1,
      elements,
      selection: { elementIds: ['g1', 'a'], primaryId: 'g1' },
      modifier: false,
    });
    expect(r.next).toEqual({ elementIds: ['g1', 'g2', 'a'], primaryId: 'g1' });
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['g1', 'g2', 'a']);
  });

  it('plain-click on an already cohesive primary group member remains a no-op emit', () => {
    const r = resolveClickSelection({
      element: g1,
      elements,
      selection: { elementIds: ['g1', 'g2'], primaryId: 'g1' },
      modifier: false,
    });
    expect(r.next).toBeNull();
    expect(r.armDrag).toBe(true);
    expect(r.dragIds).toEqual(['g1', 'g2']);
  });
});
