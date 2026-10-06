import { describe, expect, it } from 'vitest';
import {
  applyNavigation,
  clampSceneIndex,
  navigationActionForKey,
  sceneHash,
  sceneIndexFromHash,
} from '@/lib/standalone-player/navigation';
import { orderManifestScenes } from '@/lib/export/standalone-html/order-scenes';
import { pblBriefing, safeClassroomUrl } from '@/lib/standalone-player/scenes/PblScene';
import { standaloneFixtureScenes } from '../fixtures/standalone-html-classroom';

describe('standalone player scene routing', () => {
  it('orders scenes by their order field, stable on ties', () => {
    const ordered = orderManifestScenes([
      { order: 2, title: 'c' },
      { order: 0, title: 'a' },
      { order: 1, title: 'b1' },
      { order: 1, title: 'b2' },
    ]);
    expect(ordered.map((scene) => scene.title)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('round-trips scene hashes and ignores unknown ones', () => {
    expect(sceneHash(0)).toBe('#scene-1');
    expect(sceneIndexFromHash(sceneHash(2), 4)).toBe(2);
    expect(sceneIndexFromHash('#scene-99', 4)).toBe(3);
    expect(sceneIndexFromHash('#scene-0', 4)).toBe(0);
    expect(sceneIndexFromHash('#intro', 4)).toBe(0);
    expect(sceneIndexFromHash('', 0)).toBe(0);
  });

  it('clamps navigation to the scene range', () => {
    expect(applyNavigation(0, 'previous', 3)).toBe(0);
    expect(applyNavigation(0, 'next', 3)).toBe(1);
    expect(applyNavigation(2, 'next', 3)).toBe(2);
    expect(clampSceneIndex(5, 0)).toBe(0);
  });

  it('navigates on Left/Right only, never while typing or with modifiers', () => {
    expect(navigationActionForKey({ key: 'ArrowRight' })).toBe('next');
    expect(navigationActionForKey({ key: 'ArrowLeft' })).toBe('previous');
    // Scrolling keys stay with long quiz and PBL scenes.
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
      expect(navigationActionForKey({ key })).toBeNull();
    }
    expect(navigationActionForKey({ key: 'a' })).toBeNull();
    expect(
      navigationActionForKey({ key: 'ArrowRight', target: { tagName: 'TEXTAREA' } }),
    ).toBeNull();
    expect(
      navigationActionForKey({ key: 'ArrowLeft', target: { isContentEditable: true } }),
    ).toBeNull();
    expect(navigationActionForKey({ key: 'ArrowRight', metaKey: true })).toBeNull();
  });
});

describe('standalone player PBL briefing', () => {
  it('reads the scenario and milestones of a current project', () => {
    const scene = standaloneFixtureScenes('stage').find((s) => s.type === 'pbl')!;
    if (scene.content.type !== 'pbl') throw new Error('expected pbl');
    const briefing = pblBriefing(scene.content, scene.title);
    expect(briefing.title).toBe('Design a school greenhouse');
    expect(briefing.learnerRole).toBe('Lead designer');
    expect(briefing.characters).toEqual([
      { name: 'Ms. Rivera', persona: 'Principal who cares about cost' },
    ]);
    expect(briefing.milestones.map((m) => m.title)).toEqual([
      'Research limiting factors',
      'Sketch the design',
    ]);
    expect(briefing.milestones[0].tasks[0].title).toBe('List the factors');
  });

  it('skips missing entries instead of failing', () => {
    const briefing = pblBriefing(
      {
        projectV2: {
          title: 'Broken',
          scenario: { setting: 'x', characters: [null, { name: 'Ana', persona: 'p' }] },
          milestones: [null, { title: 'M', microtasks: [null] }],
        } as never,
      },
      'fallback',
    );
    expect(briefing.characters).toEqual([{ name: 'Ana', persona: 'p' }]);
    expect(briefing.milestones).toEqual([{ title: 'M', description: undefined, tasks: [] }]);
    expect(pblBriefing({}, 'fallback').title).toBe('fallback');
  });

  it('only links to web addresses', () => {
    expect(safeClassroomUrl('https://maic.example/classroom/a')).toBe(
      'https://maic.example/classroom/a',
    );
    expect(safeClassroomUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeClassroomUrl(undefined)).toBeUndefined();
  });
});
