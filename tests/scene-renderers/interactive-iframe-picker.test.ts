// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { handleInteractivePickerMessage } from '@/components/scene-renderers/InteractiveIframeHost';
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
        { __maicInteractive: true, kind: 'element-picker-disarmed' },
        translate,
      ),
    ).toBe(true);
    expect(useCanvasStore.getState().pickTarget).toBeNull();
  });
});
