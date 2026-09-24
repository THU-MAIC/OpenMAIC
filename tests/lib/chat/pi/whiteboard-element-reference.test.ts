import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { StatelessChatRequest, WhiteboardElementReference } from '@/lib/types/chat';
import type { Whiteboard } from '@/lib/types/stage';
import {
  ElementReferenceValidationError,
  resolveElementReference,
  validateWhiteboardReference,
} from '@/lib/chat/pi/element-reference';
import {
  getDisplayedWhiteboard,
  isWhiteboardReferenceAvailable,
} from '@/lib/whiteboard/element-reference';

const text: PPTElement = {
  id: 'fact',
  type: 'text',
  content: '<p>Buoyancy equals displaced liquid weight.</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000',
  left: 10,
  top: 20,
  width: 200,
  height: 60,
  rotate: 0,
};
const board: Whiteboard = {
  id: 'board',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [text],
};
const reference: WhiteboardElementReference = {
  kind: 'whiteboard_element',
  whiteboardId: 'board',
  elementId: 'fact',
};
function body(): StatelessChatRequest {
  return {
    storeState: {
      stage: { id: 'stage', whiteboard: [structuredClone(board)] },
      scenes: [],
      currentSceneId: 'unrelated-scene',
    },
    elementReference: { ...reference },
  } as unknown as StatelessChatRequest;
}

describe('whiteboard element evidence', () => {
  it('reads one element from the first displayed board, independently of Scene identity', () => {
    const result = resolveElementReference(body())!;
    expect(result.evidence).toMatchObject({
      kind: 'whiteboard_element',
      source: 'request_start_snapshot',
      whiteboardId: 'board',
      elementType: 'text',
      content: { text: 'Buoyancy equals displaced liquid weight.' },
    });
    expect(result.evidence).not.toHaveProperty('sceneId');
    expect(result.childEvidence).not.toContain('Selected slide');
    expect(result.directorSummary).toContain('Buoyancy equals displaced liquid weight.');
  });

  it.each([
    'missing-stage',
    'wrong-board',
    'missing-element',
    'duplicate-element',
    'second-board',
    'extra-content',
    'unsupported-type',
    'runtime-id',
  ])('rejects %s instead of guessing or accepting browser-supplied content', (scenario) => {
    const request = body();
    const stage = request.storeState.stage!;
    if (scenario === 'unsupported-type')
      Object.assign(stage.whiteboard![0].elements[0], { type: 'unsupported' });
    if (scenario === 'runtime-id')
      Object.assign(request.elementReference!, { whiteboardId: 'runtime-whiteboard:stage' });
    if (scenario === 'missing-stage') request.storeState.stage = null;
    if (scenario === 'wrong-board') stage.whiteboard![0].id = 'replacement';
    if (scenario === 'missing-element') stage.whiteboard![0].elements = [];
    if (scenario === 'duplicate-element') stage.whiteboard![0].elements.push(text);
    if (scenario === 'second-board')
      stage.whiteboard!.unshift({
        id: 'new-first',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [],
      });
    if (scenario === 'extra-content')
      Object.assign(request.elementReference!, { content: 'forged' });
    expect(() => resolveElementReference(request)).toThrow(ElementReferenceValidationError);
  });

  it('accepts exactly the three identity keys', () => {
    expect(validateWhiteboardReference(reference)).toEqual(reference);
    expect(resolveElementReference(body())!.evidence).not.toHaveProperty('lastSeq');
  });

  it.each(['stageId', 'source', 'content'])('rejects extra identity key %s', (key) => {
    expect(() => validateWhiteboardReference({ ...reference, [key]: 'extra' })).toThrow(
      ElementReferenceValidationError,
    );
  });

  it.each(['whiteboardId', 'elementId'])('rejects missing or invalid %s', (key) => {
    for (const value of [undefined, '', ' padded ', 123]) {
      expect(() => validateWhiteboardReference({ ...reference, [key]: value })).toThrow(
        ElementReferenceValidationError,
      );
    }
  });

  it('bounds element text and preserves media metadata limitations', () => {
    const request = body();
    request.storeState.stage!.whiteboard![0].elements = [{ ...text, content: 'x'.repeat(20000) }];
    expect(resolveElementReference(request)!.evidence.truncatedFields).toContain('content.text');
    request.storeState.stage!.whiteboard![0].elements = [
      {
        ...text,
        type: 'image',
        src: 'data:image/png;base64,SECRET_PIXELS',
        fixedRatio: true,
      } as PPTElement,
    ];
    const result = resolveElementReference(request)!;
    expect(result.evidence).toMatchObject({ content: { source: { kind: 'embedded' } } });
    expect(result.childEvidence).not.toContain('SECRET_PIXELS');
    expect(result.childEvidence).toContain('metadata only');
  });

  it('shares display authority and stale-identity checks, including authoritative empty boards', () => {
    const stage = body().storeState.stage;
    expect(isWhiteboardReferenceAvailable(reference, stage, null)).toBe(true);
    const emptyRuntime = { stageId: 'stage', lastSeq: 2, whiteboard: null };
    expect(getDisplayedWhiteboard(stage, emptyRuntime)).toEqual({
      source: 'runtime_store',
      whiteboard: null,
    });
    expect(isWhiteboardReferenceAvailable(reference, stage, emptyRuntime)).toBe(false);
    expect(
      isWhiteboardReferenceAvailable(reference, stage, { ...emptyRuntime, whiteboard: board }),
    ).toBe(false);
    expect(
      isWhiteboardReferenceAvailable(reference, stage, { ...emptyRuntime, stageId: 'other' }),
    ).toBe(true);
    expect(
      isWhiteboardReferenceAvailable({ ...reference, whiteboardId: 'other' }, stage, null),
    ).toBe(false);
  });
});
