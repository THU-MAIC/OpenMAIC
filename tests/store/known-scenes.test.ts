import { beforeEach, describe, expect, it } from 'vitest';

import {
  recordKnownScenes,
  resetKnownScenes,
  settleKnownScenes,
  unseenScenes,
} from '@/lib/store/known-scenes';

const STAGE = 'stage-known';
const scene = (id: string) => ({ id });

beforeEach(() => resetKnownScenes(STAGE));

describe('the scenes a tab knows of', () => {
  it('has no opinion on a course it never held: the save stays authoritative', () => {
    expect(unseenScenes(STAGE, [scene('a')], [])).toEqual([]);
  });

  it('calls unseen a stored scene it never held and the save does not list', () => {
    recordKnownScenes(STAGE, ['a']);

    expect(unseenScenes(STAGE, [scene('a'), scene('b'), scene('c')], [scene('c')])).toEqual([
      scene('b'),
    ]);
  });

  it('remembers a scene the store no longer holds, which is one being removed', () => {
    recordKnownScenes(STAGE, ['a', 'b']);
    recordKnownScenes(STAGE, ['a']);

    expect(unseenScenes(STAGE, [scene('b')], [scene('a')])).toEqual([]);
  });

  it('forgets a scene a save removed, unless the store holds it again', () => {
    recordKnownScenes(STAGE, ['a', 'b']);
    recordKnownScenes(STAGE, ['b']);

    settleKnownScenes(STAGE, [scene('a'), scene('b')]);

    expect(unseenScenes(STAGE, [scene('a'), scene('b')], [])).toEqual([scene('a')]);
  });
});
