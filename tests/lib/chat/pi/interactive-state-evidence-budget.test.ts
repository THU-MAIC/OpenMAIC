import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ElementReferenceValidationError,
  INTERACTIVE_PACKET_LIMIT,
  codePointLength,
  resolveSlideElementReference,
  type ResolvedInteractiveComponentReference,
} from '@/lib/chat/pi/element-reference';
import { attachInteractiveState } from '@/lib/chat/pi/interactive-state-evidence';
import { exceedsDepth, OBSERVATION_MAX_DEPTH } from '@/lib/interactive/observation';

/** Mirrors the module's own budget: the static packet bound plus the note frame. */
const NOTE_FRAME_BUDGET = 8_000;
const COMBINED_EVIDENCE_LIMIT = INTERACTIVE_PACKET_LIMIT + NOTE_FRAME_BUDGET;

const html =
  '<main id="experiment"><input id="density" value="1000">' +
  '<script type="application/json" data-maic-observation>{}</script></main>';

function makeBody(report: unknown) {
  const now = Date.now();
  return {
    storeState: {
      currentSceneId: 'scene-1',
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Activity',
          order: 0,
          type: 'interactive',
          content: { type: 'interactive', widgetType: 'simulation', html },
        },
      ],
    },
    interactiveState: {
      sourceHtmlHash: createHash('sha256').update(html).digest('hex'),
      snapshot: {
        source: 'browser-reported',
        identity: { sceneId: 'scene-1', scopeId: 'experiment', documentId: 'doc-1' },
        requestedAt: now,
        receivedAt: now,
        status: 'available',
        observation: report,
      },
    },
  };
}

/** A component reference sitting exactly on the upstream static bound. */
function maximalReference(): ResolvedInteractiveComponentReference {
  const directorSummary = 'Selected Interactive component reference: ' + 'd'.repeat(2_000);
  const childEvidence = 'c'.repeat(INTERACTIVE_PACKET_LIMIT);
  return {
    reference: { kind: 'interactive_component', sceneId: 'scene-1', selector: '#density' },
    evidence: { selector: '#density', component: {}, truncatedFields: [], omittedItems: [] },
    directorSummary,
    childEvidence,
  } as unknown as ResolvedInteractiveComponentReference;
}

function slideBody(graph: unknown, cells = 1) {
  const body = makeBody(graph);
  return {
    ...body,
    elementReference: { kind: 'slide_element', sceneId: 'slide-1', elementId: 'table-1' },
    storeState: {
      ...body.storeState,
      scenes: [
        ...body.storeState.scenes,
        {
          id: 'slide-1',
          type: 'slide',
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'table-1',
                  type: 'table',
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 100,
                  colWidths: [1],
                  cellMinHeight: 20,
                  data: Array.from({ length: cells }, (_, i) => [
                    {
                      id: `cell-${i}`,
                      text: 'x'.repeat(256),
                      colspan: 1,
                      rowspan: 1,
                    },
                  ]),
                },
              ],
            },
          },
        },
      ],
    },
  };
}

const smallState = { summary: 'The liquid density is 1000.', state: { density: 1000 } };

/** Legal content: `<` is allowed anywhere in the report, and escaping expands it sixfold. */
const oversizedState = {
  summary: 'A report whose free-form state escapes into a much larger prompt body.',
  state: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`object-${i}`, '<'.repeat(540)])),
  rendered: Object.fromEntries(
    Array.from({ length: 18 }, (_, i) => [`object-${i}`, '<'.repeat(540)]),
  ),
};

describe('interactive state evidence output budget', () => {
  const flag = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[flag];
    process.env[flag] = 'true';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it.each([[{ density: 1400 }], 'density is 1400', 1400, false, null].map((value) => [value]))(
    'passes JSON report %j to model evidence unchanged',
    (report) => {
      const { stateNote } = attachInteractiveState(makeBody(report) as never, undefined);
      const serialized = stateNote!
        .split('<page_reported_state>\n')[1]
        .split('\n</page_reported_state>')[0];
      expect(JSON.parse(serialized)).toMatchObject({ status: 'available', observation: report });
    },
  );

  it('rejects an absent JSON report with a validation error', () => {
    expect(() => attachInteractiveState(makeBody(undefined) as never, undefined)).toThrow(
      ElementReferenceValidationError,
    );
  });

  it('keeps the fixed note frame inside the room reserved for it', () => {
    // With no packet at all the note carries only its frame and a short body.
    // If a future prompt edit outgrows this, the degradation below stops
    // converging, so the budget has to fail here rather than silently.
    const { stateNote } = attachInteractiveState(
      { storeState: makeBody(smallState).storeState, interactiveState: undefined } as never,
      undefined,
    );
    expect(stateNote).toBeDefined();
    expect(codePointLength(stateNote as string)).toBeLessThanOrEqual(NOTE_FRAME_BUDGET);
  });

  it.each([
    ['an ordinary packet', smallState],
    ['a packet that escapes past the budget', oversizedState],
  ])('holds every exit inside the budget for %s', (_name, report) => {
    const referencedResult = attachInteractiveState(makeBody(report) as never, maximalReference());
    const attached = referencedResult.elementReference as ResolvedInteractiveComponentReference;
    expect(codePointLength(attached.childEvidence)).toBeLessThanOrEqual(COMBINED_EVIDENCE_LIMIT);
    expect(codePointLength(attached.directorSummary)).toBeLessThanOrEqual(COMBINED_EVIDENCE_LIMIT);

    const unreferencedResult = attachInteractiveState(makeBody(report) as never, undefined);
    expect(codePointLength(unreferencedResult.stateNote as string)).toBeLessThanOrEqual(
      COMBINED_EVIDENCE_LIMIT,
    );
  });

  it('rejects a deeply nested report as a validation error, not a stack overflow', () => {
    // Free-form JSON means a report can be legal, small, and still defeat every
    // later walk over it — measuring its own bytes included. Without a depth
    // bound the Host raises RangeError, which the route surfaces as a server
    // error instead of a rejected packet.
    let deep: unknown = 1;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const body = makeBody({ summary: 'deep', state: deep });
    let thrown: unknown;
    try {
      attachInteractiveState(body as never, undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElementReferenceValidationError);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it('spends the depth budget on the report, not on the packet it travels in', () => {
    // The browser measures the report itself. Measuring the packet against the
    // same number here would charge the report for `snapshot` and `observation`
    // and reject, at 63 and 64 levels, a report the page was told it could send.
    const report = (levels: number) => {
      let nested: unknown = 1;
      for (let i = 1; i < levels; i++) nested = [nested];
      return { summary: `${levels} deep`, state: nested };
    };
    const attach = (levels: number) => {
      try {
        attachInteractiveState(makeBody(report(levels)) as never, undefined);
        return 'accepted';
      } catch {
        return 'rejected';
      }
    };
    for (const levels of [62, 63, OBSERVATION_MAX_DEPTH]) {
      expect(exceedsDepth(report(levels))).toBe(false);
      expect(attach(levels)).toBe('accepted');
    }
    expect(exceedsDepth(report(OBSERVATION_MAX_DEPTH + 1))).toBe(true);
    expect(attach(OBSERVATION_MAX_DEPTH + 1)).toBe('rejected');
  });

  it('degrades structurally instead of truncating the packet', () => {
    const { stateNote } = attachInteractiveState(makeBody(oversizedState) as never, undefined);
    const note = stateNote as string;
    const body = note.slice(
      note.indexOf('<page_reported_state>') + '<page_reported_state>\n'.length,
      note.indexOf('</page_reported_state>') - 1,
    );
    // Still valid JSON, not a cut fragment, and it carries no partial state.
    expect(JSON.parse(body)).toEqual({ status: 'unavailable', reason: 'too-large' });
    expect(note).not.toContain('object-0');
  });

  it.each([smallState, oversizedState])(
    'budgets slide state without changing slide identity',
    (report) => {
      const body = slideBody(report);
      const reference = resolveSlideElementReference(body as never)!;
      const result = attachInteractiveState(body as never, reference);
      expect(result.elementReference).toBe(reference);
      expect(result.stateNote).toContain('not properties of the referenced slide element');
      expect(result.stateNote).toContain('come from different Scenes');
      for (const evidence of [reference.childEvidence, reference.directorSummary]) {
        expect(codePointLength(evidence + '\n\n' + result.stateNote)).toBeLessThanOrEqual(
          COMBINED_EVIDENCE_LIMIT,
        );
      }
      expect(result.stateNote).toContain(
        report === smallState ? '"status":"available"' : '"reason":"too-large"',
      );
    },
  );

  it('counts slide evidence when deciding whether otherwise valid state fits', () => {
    const body = slideBody(smallState, 60);
    const report = {
      summary: 'A report that fits alone but not beside large slide evidence.',
      state: Object.fromEntries(
        Array.from({ length: 18 }, (_, i) => [`object-${i}`, 'v'.repeat(700)]),
      ),
    };
    body.interactiveState = makeBody(report).interactiveState;
    const standalone = attachInteractiveState(body as never, undefined).stateNote!;
    const reference = resolveSlideElementReference(body as never)!;
    expect(codePointLength(standalone)).toBeLessThan(COMBINED_EVIDENCE_LIMIT);
    expect(codePointLength(reference.childEvidence + '\n\n' + standalone)).toBeGreaterThan(
      COMBINED_EVIDENCE_LIMIT,
    );
    const result = attachInteractiveState(body as never, reference);
    expect(result.elementReference).toBe(reference);
    expect(result.stateNote).toContain('"reason":"too-large"');
    expect(
      codePointLength(reference.childEvidence + '\n\n' + result.stateNote),
    ).toBeLessThanOrEqual(COMBINED_EVIDENCE_LIMIT);
  });

  it('preserves existing large slide evidence and bounds the added unavailable frame', () => {
    const body = slideBody(smallState, 200);
    const reference = resolveSlideElementReference(body as never)!;
    expect(codePointLength(reference.childEvidence)).toBeGreaterThan(COMBINED_EVIDENCE_LIMIT);
    const result = attachInteractiveState(body as never, reference);
    expect(result.elementReference).toBe(reference);
    expect(result.stateNote).toContain('"reason":"too-large"');
    expect(codePointLength('\n\n' + result.stateNote)).toBeLessThanOrEqual(NOTE_FRAME_BUDGET);
  });
});
