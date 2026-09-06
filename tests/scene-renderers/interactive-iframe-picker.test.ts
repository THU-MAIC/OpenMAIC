// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleInteractivePickerMessage,
  handlePlaybackInteractivePickerMessage,
  resolveInteractivePickerMode,
} from '@/components/scene-renderers/InteractiveIframeHost';
import { useCanvasStore } from '@/lib/store/canvas';
import { useElementRefsStore } from '@/lib/store/element-refs';
import {
  ELEMENT_REF_SELECTOR_MAX,
  ELEMENT_SNAPSHOT_MAX,
  INTERACTIVE_OUTERHTML_MAX,
} from '@/lib/workbench/element-refs';

const translate = (key: string) => key;
const picked = {
  __maicInteractive: true,
  kind: 'element-picked',
  mode: 'editor',
  selector: '#cta',
  outerHTML: '<button id="cta">Start</button>',
  text: 'Start',
};

afterEach(() => {
  useCanvasStore.getState().resetCanvasState();
  useElementRefsStore.setState({
    ownerSessionId: null,
    refs: [],
    hovered: null,
    nextGeneration: 1,
  });
});

describe('InteractiveIframeHost picker messages', () => {
  it('gives playback stable-ID mode deterministic precedence over editor picking', () => {
    expect(resolveInteractivePickerMode(false, false)).toBeNull();
    expect(resolveInteractivePickerMode(true, false)).toBe('editor');
    expect(resolveInteractivePickerMode(false, true)).toBe('playback-stable-id');
    expect(resolveInteractivePickerMode(true, true)).toBe('playback-stable-id');
  });

  it('routes only one stable playback identity without writing iframe content to editor state', () => {
    const picks: unknown[] = [];
    const cancels: unknown[] = [];
    const playbackPick = {
      ...picked,
      mode: 'playback-stable-id',
      outerHTML: '<script>untrusted()</script>',
      text: 'untrusted live text',
    };

    expect(
      handlePlaybackInteractivePickerMessage(
        'scene-web',
        true,
        playbackPick,
        (pick) => picks.push(pick),
        () => cancels.push(true),
      ),
    ).toBe(true);
    expect(picks).toEqual([{ sceneId: 'scene-web', selector: '#cta' }]);
    expect(useElementRefsStore.getState().refs).toEqual([]);

    for (const selector of ['main > button', '#bad:id', `#a${'b'.repeat(127)}`]) {
      expect(
        handlePlaybackInteractivePickerMessage(
          'scene-web',
          true,
          { ...playbackPick, selector },
          (pick) => picks.push(pick),
          () => cancels.push(true),
        ),
      ).toBe(false);
    }
    expect(picks).toHaveLength(1);

    expect(
      handlePlaybackInteractivePickerMessage(
        'scene-web',
        true,
        {
          __maicInteractive: true,
          kind: 'element-picker-disarmed',
          mode: 'playback-stable-id',
        },
        (pick) => picks.push(pick),
        () => cancels.push(true),
      ),
    ).toBe(true);
    expect(cancels).toEqual([true]);
  });

  it('keeps editor and playback protocol modes isolated', () => {
    const picks: unknown[] = [];
    const cancels: unknown[] = [];
    expect(
      handlePlaybackInteractivePickerMessage(
        'scene-web',
        true,
        picked,
        (pick) => picks.push(pick),
        () => cancels.push(true),
      ),
    ).toBe(false);
    expect(
      handleInteractivePickerMessage(
        'scene-web',
        { ...picked, mode: 'playback-stable-id' },
        translate,
      ),
    ).toBe(false);
    expect(picks).toEqual([]);
    expect(cancels).toEqual([]);
  });

  it('ignores a forged pick while this iframe is not armed', () => {
    useElementRefsStore.getState().attachOwner('session-a');
    expect(handleInteractivePickerMessage('scene-web', picked, translate)).toBe(false);
    expect(useElementRefsStore.getState().refs).toEqual([]);
  });

  it('validates, bounds, and toggles a picked GenUI element while armed', () => {
    useElementRefsStore.getState().attachOwner('session-a');
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-web',
      ownerSessionId: 'session-a',
    });
    const longPick = {
      ...picked,
      selector: `#${'s'.repeat(ELEMENT_REF_SELECTOR_MAX + 20)}`,
      outerHTML: `<div>${'h'.repeat(INTERACTIVE_OUTERHTML_MAX + 20)}</div>`,
      text: 't'.repeat(ELEMENT_SNAPSHOT_MAX + 20),
    };

    expect(handleInteractivePickerMessage('scene-web', longPick, translate)).toBe(true);
    const [ref] = useElementRefsStore.getState().refs;
    expect(ref).toMatchObject({ kind: 'interactive-element', stageId: 'stage-1' });
    if (ref?.kind !== 'interactive-element') throw new Error('missing interactive ref');
    expect(ref.selector).toHaveLength(ELEMENT_REF_SELECTOR_MAX);
    expect(ref.outerHTML).toHaveLength(INTERACTIVE_OUTERHTML_MAX);
    expect(ref.text).toHaveLength(ELEMENT_SNAPSHOT_MAX);

    expect(handleInteractivePickerMessage('scene-web', longPick, translate)).toBe(true);
    expect(useElementRefsStore.getState().refs).toEqual([]);
  });

  it('drops malformed fields and clears only the matching armed target on Escape', () => {
    useElementRefsStore.getState().attachOwner('session-a');
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-web',
      ownerSessionId: 'session-a',
    });
    expect(handleInteractivePickerMessage('scene-web', { ...picked, selector: 7 }, translate)).toBe(
      false,
    );
    expect(useElementRefsStore.getState().refs).toEqual([]);

    expect(
      handleInteractivePickerMessage(
        'scene-web',
        { __maicInteractive: true, kind: 'element-picker-disarmed', mode: 'editor' },
        translate,
      ),
    ).toBe(true);
    expect(useCanvasStore.getState().pickTarget).toBeNull();
  });
});
