import { describe, expect, it } from 'vitest';
import { validateScene } from '@openmaic/dsl';
import { buildCompleteScene } from '@openmaic/generation';
import { slideOutline } from './scene-fixtures.js';

const content = {
  elements: [
    {
      id: 'text-1',
      type: 'text' as const,
      left: 0,
      top: 0,
      width: 400,
      height: 80,
      content: 'Dependency injection',
      rotate: 0,
      lineHeight: 1,
      fill: '#000000',
      vertical: false,
      defaultFontName: 'Arial',
      defaultColor: '#000000',
    },
  ],
};

describe('buildCompleteScene', () => {
  it('uses a random scene id by default', () => {
    const first = buildCompleteScene(slideOutline(), content, [], 'stage-1');
    const second = buildCompleteScene(slideOutline(), content, [], 'stage-1');
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });

  it('honors an injected id across retries/upserts', () => {
    const first = buildCompleteScene(slideOutline(), content, [], 'stage-1', {
      sceneId: 'stable-scene-id',
    });
    const retry = buildCompleteScene(slideOutline(), content, [], 'stage-1', {
      sceneId: 'stable-scene-id',
    });
    expect(first?.id).toBe('stable-scene-id');
    expect(retry?.id).toBe(first?.id);
    expect(first?.outlineId).toBe('slide-1');
    expect(validateScene(first)).toEqual({ valid: true });
  });
});
