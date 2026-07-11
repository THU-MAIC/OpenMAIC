import { describe, expect, test } from 'vitest';
import {
  validateScene,
  sceneHasIssues,
  validateOutline,
  outlinesHaveBlockingIssues,
  countBlockingOutlines,
} from '@/lib/edit/content-validation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const scene = (actions: Action[]): Scene =>
  ({
    id: 's',
    stageId: 'stage',
    type: 'slide',
    title: 'T',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  }) as unknown as Scene;

const speech = (id: string, text: string): Action => ({ id, type: 'speech', text }) as Action;
const spotlight = (id: string, elementId: string): Action =>
  ({ id, type: 'spotlight', elementId }) as Action;
const discussion = (id: string, topic: string): Action =>
  ({ id, type: 'discussion', topic }) as unknown as Action;

const outline = (over: Partial<SceneOutline>): SceneOutline =>
  ({
    id: 'o',
    order: 1,
    type: 'slide',
    title: 'X',
    description: '',
    keyPoints: [],
    ...over,
  }) as SceneOutline;

describe('validateScene', () => {
  test('a fully-filled scene has no issues', () => {
    expect(validateScene(scene([speech('a', 'hi'), spotlight('b', 'el_1')]))).toEqual([]);
    expect(sceneHasIssues(scene([speech('a', 'hi')]))).toBe(false);
  });

  test('empty action list → emptyActions', () => {
    expect(validateScene(scene([]))).toEqual([{ kind: 'emptyActions' }]);
    expect(sceneHasIssues(scene([]))).toBe(true);
  });

  test('blank / whitespace-only speech text → emptySpeech with the action id', () => {
    expect(validateScene(scene([speech('a', '')]))).toEqual([
      { kind: 'emptySpeech', actionId: 'a' },
    ]);
    expect(validateScene(scene([speech('a', '   ')]))).toEqual([
      { kind: 'emptySpeech', actionId: 'a' },
    ]);
  });

  test('element-bound cue with no elementId → unboundCue', () => {
    expect(validateScene(scene([speech('a', 'hi'), spotlight('b', '')]))).toEqual([
      { kind: 'unboundCue', actionId: 'b' },
    ]);
  });

  test('discussion with blank topic → emptyDiscussion', () => {
    expect(validateScene(scene([speech('a', 'hi'), discussion('d', '  ')]))).toEqual([
      { kind: 'emptyDiscussion', actionId: 'd' },
    ]);
  });

  test('reports one issue per offending action, in order', () => {
    expect(validateScene(scene([speech('a', ''), spotlight('b', '')]))).toEqual([
      { kind: 'emptySpeech', actionId: 'a' },
      { kind: 'unboundCue', actionId: 'b' },
    ]);
  });
});

describe('validateOutline / blocking helpers', () => {
  test('blank title → emptyTitle; filled title → no issue', () => {
    expect(validateOutline(outline({ title: '' }))).toEqual([{ kind: 'emptyTitle' }]);
    expect(validateOutline(outline({ title: '   ' }))).toEqual([{ kind: 'emptyTitle' }]);
    expect(validateOutline(outline({ title: 'Intro' }))).toEqual([]);
  });

  test('outlinesHaveBlockingIssues / countBlockingOutlines count blank titles', () => {
    const os = [outline({ title: 'A' }), outline({ title: '' }), outline({ title: ' ' })];
    expect(outlinesHaveBlockingIssues(os)).toBe(true);
    expect(countBlockingOutlines(os)).toBe(2);
    expect(outlinesHaveBlockingIssues([outline({ title: 'A' })])).toBe(false);
    expect(countBlockingOutlines([outline({ title: 'A' })])).toBe(0);
  });
});
