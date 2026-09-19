import { describe, expect, it } from 'vitest';
import { normalizeScenes, VideoTimelineCompileError } from '@/lib/video-export';
import { act, quiz, slide, speech, spotlight } from './helpers';

describe('normalizeScenes — ordering', () => {
  it('orders scenes by `order`, tie-broken by input index (stable)', () => {
    const scenes = [
      slide('c', [], { order: 2 }),
      slide('a', [], { order: 1 }),
      slide('b', [], { order: 1 }),
    ];
    const { scenes: out } = normalizeScenes(scenes);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to input index when `order` is absent, preserving input order', () => {
    const scenes = [
      { ...slide('x', []), order: undefined },
      { ...slide('y', []), order: undefined },
    ];
    const { scenes: out } = normalizeScenes(scenes as never);
    expect(out.map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('throws on an empty scene list', () => {
    expect(() => normalizeScenes([])).toThrow(VideoTimelineCompileError);
  });
});

describe('normalizeScenes — action validation', () => {
  it('drops an unknown action type with an unknown-action diagnostic', () => {
    const scenes = [slide('s', [act({ id: 'bad', type: 'teleport' }), speech('ok', 'hi')])];
    const { scenes: out, diagnostics } = normalizeScenes(scenes);
    expect(out[0].actions).toHaveLength(1);
    expect(out[0].actions?.[0].id).toBe('ok');
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'unknown-action', sceneId: 's', actionId: 'bad' }),
    ]);
  });

  it('drops an action missing a required field with an invalid-action diagnostic', () => {
    // spotlight without elementId
    const scenes = [slide('s', [act({ id: 'sp', type: 'spotlight' }), spotlight('good', 'e1')])];
    const { scenes: out, diagnostics } = normalizeScenes(scenes);
    expect(out[0].actions?.map((a) => a.id)).toEqual(['good']);
    expect(diagnostics[0]).toMatchObject({ code: 'invalid-action', actionId: 'sp' });
  });

  it('keeps an empty-text speech (a legal dwell beat)', () => {
    const { scenes: out, diagnostics } = normalizeScenes([slide('s', [speech('e', '')])]);
    expect(out[0].actions).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });

  it('does not mutate the input scenes', () => {
    const scenes = [slide('b', [], { order: 2 }), slide('a', [], { order: 1 })];
    normalizeScenes(scenes);
    expect(scenes.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('validates quiz scene actions too', () => {
    const { diagnostics } = normalizeScenes([quiz('q', [act({ id: 'z', type: 'nope' })])]);
    expect(diagnostics[0].code).toBe('unknown-action');
  });
});
