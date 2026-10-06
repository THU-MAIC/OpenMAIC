import { describe, expect, it } from 'vitest';
import {
  applySceneDeepLink,
  classroomPageUrl,
  classroomSceneUrl,
} from '@/lib/classroom/scene-deep-link';

function fakeStore(stageId: string | null, sceneIds: string[]) {
  const state = {
    stage: stageId ? { id: stageId } : null,
    scenes: sceneIds.map((id) => ({ id })),
    currentSceneId: sceneIds[0] ?? null,
  };
  return {
    state,
    getState: () => state,
    setState: (partial: { currentSceneId: string }) => Object.assign(state, partial),
  };
}

describe('scene deep links', () => {
  it('builds classroom and scene URLs', () => {
    expect(classroomPageUrl('https://host.example/', 'abc')).toBe(
      'https://host.example/classroom/abc',
    );
    expect(classroomSceneUrl('https://host.example/classroom/abc', 'scene 2')).toBe(
      'https://host.example/classroom/abc?scene=scene+2',
    );
    expect(classroomSceneUrl('https://host.example/classroom/abc?scene=old', 'new')).toBe(
      'https://host.example/classroom/abc?scene=new',
    );
  });

  it('opens the named scene of the loaded classroom', () => {
    const store = fakeStore('abc', ['s1', 's2', 's3']);
    expect(applySceneDeepLink('?scene=s3', 'abc', store)).toBe('s3');
    expect(store.state.currentSceneId).toBe('s3');
  });

  it('ignores unknown scene ids, other classrooms and a missing parameter', () => {
    const store = fakeStore('abc', ['s1', 's2']);
    expect(applySceneDeepLink('?scene=nope', 'abc', store)).toBeNull();
    expect(applySceneDeepLink('?scene=s2', 'other', store)).toBeNull();
    expect(applySceneDeepLink('', 'abc', store)).toBeNull();
    expect(applySceneDeepLink('?foo=s2', 'abc', store)).toBeNull();
    expect(store.state.currentSceneId).toBe('s1');
  });
});
