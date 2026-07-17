import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { buildChildPrompt, buildDirectorPrompt } from '@/lib/chat/pi/prompts';

const agents: AgentConfig[] = [
  {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona: 'Lead teacher.',
    avatar: '',
    color: '#3366ff',
    allowedActions: [],
    priority: 10,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    isDefault: true,
  },
  {
    id: 'assistant-1',
    name: 'AI assistant',
    role: 'assistant',
    persona: 'Teaching assistant.',
    avatar: '',
    color: '#33aa66',
    allowedActions: [],
    priority: 5,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    isDefault: true,
  },
];

function makeBody(overrides: Partial<StatelessChatRequest> = {}): StatelessChatRequest {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: '我知道了' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'City Cooling' },
      scenes: [],
      currentSceneId: null,
      whiteboardOpen: false,
    },
    config: {
      agentIds: agents.map((agent) => agent.id),
      agentConfigs: agents,
      sessionType: 'qa',
    },
    apiKey: '',
    ...overrides,
  } as StatelessChatRequest;
}

describe('Pi director prompt closure routing', () => {
  it('teaches close_session as the terminal alternative to cue_user', () => {
    const prompt = buildDirectorPrompt(makeBody(), agents, 4);

    expect(prompt).toContain('Terminal Tool Policy');
    expect(prompt).toContain('Use exactly one terminal tool per loop');
    expect(prompt).toContain('`cue_user` and `close_session` are mutually exclusive');
    expect(prompt).toContain('If you call `close_session`, do not call `cue_user` afterward');
    expect(prompt).toContain('close_session.endReason');
  });

  it('requires a visible teacher closing line before close_session', () => {
    const prompt = buildDirectorPrompt(makeBody(), agents, 4);

    expect(prompt).toContain('Before you call `close_session`');
    expect(prompt).toContain('short, visible closing line');
    expect(prompt).toContain('有问题的话你还可以继续问');
    expect(prompt).toContain('Never make `close_session` the first tool');
  });

  it('routes satisfied acknowledgments and back-to-lesson intent to close_session', () => {
    const prompt = buildDirectorPrompt(makeBody(), agents, 4);

    expect(prompt).toContain('low-intent finishers as closure');
    expect(prompt).toContain('我知道了');
    expect(prompt).toContain('明白了');
    expect(prompt).toContain('可以继续下课');
    expect(prompt).toContain('back_to_lesson');
    expect(prompt).toContain('A bare acknowledgment with no new request is closure');
  });

  it('keeps concept and mechanism questions teacher-led before student reactions', () => {
    const prompt = buildDirectorPrompt(makeBody(), agents, 4);

    expect(prompt).toContain('call the teacher first when available');
    expect(prompt).toContain('Use the assistant fallback only under rule 6');
    expect(prompt).toContain('concept/mechanism/process questions');
    expect(prompt).toContain('first substantive answer should come from the teacher by default');
    expect(prompt).toContain('or a teaching assistant when the teacher is unavailable');
    expect(prompt).toContain(
      'Students may react after the teacher/assistant has made the core point',
    );
    expect(prompt).toContain('do not let a student take the first substantive explanation');
  });

  it('teaches teacher wrap-up as the only turn allowed after normal turn budget', () => {
    const prompt = buildDirectorPrompt(makeBody(), agents, 4);

    expect(prompt).toContain('normal classroom agent turns');
    expect(prompt).toContain('turnKind: "wrap_up"');
    expect(prompt).toContain('do not call more students or assistants');
    expect(prompt).toContain('final teacher summary');
  });
});

describe('Pi child prompt structured output', () => {
  it('requires JSON array output and lists available actions without tool-call wording', () => {
    const prompt = buildChildPrompt(makeBody(), agents[0], [], [], ['spotlight', 'wb_open']);

    expect(prompt).toContain('Return ONLY a valid JSON array');
    expect(prompt).toContain('{"type":"text","content":"natural classroom speech"}');
    expect(prompt).toContain('{"type":"action","name":"action_name","params":{}}');
    expect(prompt).toContain('- spotlight:');
    expect(prompt).toContain('- wb_open:');
    expect(prompt).toContain('If you emit a whiteboard action');
    expect(prompt).toContain('MUST also include a text item explaining the key point');
    expect(prompt).not.toContain('Use at most one action tool');
    expect(prompt).not.toContain('call one of your available action tools');
  });

  it('advertises only the executable Pi classroom action surface for this turn', () => {
    const prompt = buildChildPrompt(
      makeBody(),
      agents[0],
      [],
      [],
      [
        'spotlight',
        'laser',
        'play_video',
        'wb_open',
        'wb_draw_text',
        'wb_draw_shape',
        'wb_draw_chart',
        'wb_draw_latex',
        'wb_draw_table',
        'wb_draw_line',
        'wb_draw_code',
        'wb_edit_code',
        'wb_clear',
        'wb_delete',
        'wb_close',
      ],
    );

    expect(prompt).toContain('- spotlight:');
    expect(prompt).toContain('- laser:');
    expect(prompt).toContain('- play_video:');
    expect(prompt).toContain('- wb_open:');
    expect(prompt).toContain('- wb_draw_text:');
    expect(prompt).toContain('- wb_draw_shape:');
    expect(prompt).toContain('- wb_draw_chart:');
    expect(prompt).toContain('- wb_draw_latex:');
    expect(prompt).toContain('- wb_draw_table:');
    expect(prompt).toContain('- wb_draw_line:');
    expect(prompt).toContain('- wb_draw_code:');
    expect(prompt).toContain('- wb_edit_code:');
    expect(prompt).toContain('- wb_clear:');
    expect(prompt).toContain('- wb_delete:');
    expect(prompt).toContain('- wb_close:');
    expect(prompt).not.toContain('- widget_highlight:');
    expect(prompt).not.toContain('- widget_setState:');
    expect(prompt).not.toContain('- discussion:');
  });

  it('renders first-request session context alongside the current slide and persisted board', () => {
    const body = makeBody({
      piSessionBoundary: {
        isFirstRequestInLiveSession: true,
        previousEndSource: 'manual_stop',
        sameSceneAsPrevious: false,
      },
      storeState: {
        stage: {
          id: 'stage-1',
          name: 'City Cooling',
          whiteboard: [
            {
              id: 'whiteboard-1',
              elements: [
                {
                  id: 'old-note',
                  type: 'text',
                  content: 'previous topic diagram',
                  left: 80,
                  top: 120,
                  width: 300,
                  height: 80,
                } as never,
              ],
            },
          ],
        },
        scenes: [
          {
            id: 'scene-2',
            title: 'New slide',
            type: 'slide',
            content: { type: 'slide', canvas: { elements: [] } as never },
          },
        ],
        currentSceneId: 'scene-2',
        whiteboardOpen: true,
      } as never,
    });

    const prompt = buildChildPrompt(body, agents[0], [], [], ['wb_draw_text', 'wb_clear']);

    expect(prompt).toContain('# Live Session Context');
    expect(prompt).toContain('first request of a newly created UI live session');
    expect(prompt).toContain('previous live session ended via: manual_stop');
    expect(prompt).toContain('current scene differs from the previous live session');
    expect(prompt).toContain('NOT automatically a semantic topic boundary');
    expect(prompt).toContain('Current scene: "New slide"');
    expect(prompt).toContain('[id:old-note]');
    expect(prompt).toContain('previous topic diagram');
  });

  it('only teaches semantic clearing when wb_clear is executable', () => {
    const boundaryBody = makeBody({
      piSessionBoundary: { isFirstRequestInLiveSession: true },
    });
    const withClear = buildChildPrompt(
      boundaryBody,
      agents[0],
      [],
      [],
      ['wb_draw_text', 'wb_clear'],
    );
    const withoutClear = buildChildPrompt(boundaryBody, agents[0], [], [], ['wb_draw_text']);

    expect(withClear).toContain('Preserve the current whiteboard');
    expect(withClear).toContain('Use wb_clear only when the new topic is semantically unrelated');
    expect(withClear).toContain('Do not clear merely because the user manually stopped earlier');
    expect(withoutClear).not.toContain('Use wb_clear only when');
    expect(withoutClear).not.toContain('Do not clear merely because');
  });

  it('teaches smart whiteboard layout, trigger rules, and visual type choices', () => {
    const prompt = buildChildPrompt(
      makeBody(),
      agents[0],
      [],
      [],
      [
        'spotlight',
        'laser',
        'wb_open',
        'wb_draw_text',
        'wb_draw_shape',
        'wb_draw_chart',
        'wb_draw_latex',
        'wb_draw_table',
        'wb_draw_line',
        'wb_draw_code',
      ],
    );

    expect(prompt).toContain('Smart Visual Teaching');
    expect(prompt).toContain('Whiteboard canvas: use a 1000 x 563 coordinate system');
    expect(prompt).toContain('x=40..960');
    expect(prompt).toContain('y=40..523');
    expect(prompt).toContain('left concept, right mechanism, bottom summary');
    expect(prompt).toContain('at least 24px between elements');
    expect(prompt).toContain('Do not wait for the user to explicitly say "draw a diagram"');
    expect(prompt).toContain(
      'mechanism, cause/effect, process, comparison, or derivation questions',
    );
    expect(prompt).toContain('when the visual adds teaching value');
    expect(prompt).toContain('Drawing is not the goal; better understanding is the goal');
    expect(prompt).toContain('If the visual would not add information beyond one clear sentence');
    expect(prompt).toContain('simple factual Q&A');
    expect(prompt).toContain('short definitions');
    expect(prompt).toContain('without gratuitous drawing');
    expect(prompt).toContain('mechanism/causal -> wb_draw_shape + wb_draw_line');
    expect(prompt).toContain('comparison -> wb_draw_table or two-column shapes');
    expect(prompt).toContain('derivation -> wb_draw_latex');
    expect(prompt).toContain('code explanation -> wb_draw_code');
    expect(prompt).toContain('trend/data -> wb_draw_chart');
  });

  it('includes few-shot choices for draw, no-draw, slide-priority, comparison, and derivation cases', () => {
    const prompt = buildChildPrompt(
      makeBody(),
      agents[0],
      [],
      [],
      ['spotlight', 'laser', 'wb_open', 'wb_draw_shape', 'wb_draw_table', 'wb_draw_latex'],
    );

    expect(prompt).toContain('Why does a zipper close when the slider moves?');
    expect(prompt).toContain('teeth interlock');
    expect(prompt).toContain('How does a package move from checkout to delivery?');
    expect(prompt).toContain('process steps with arrows');
    expect(prompt).toContain('What color do you get by mixing red and white?');
    expect(prompt).toContain('no whiteboard');
    expect(prompt).toContain('Define a peninsula in one sentence');
    expect(prompt).toContain('Slide already adequately covers the relevant diagram');
    expect(prompt).toContain('uses spotlight or laser');
    expect(prompt).toContain('do not open the whiteboard or redraw the same thing');
    expect(prompt).toContain('Slide only has a related keyword');
    expect(prompt).toContain('draw a concise whiteboard sketch instead');
    expect(prompt).toContain('Compare renting and buying a textbook');
    expect(prompt).toContain('Derive rectangle perimeter from length and width');
  });

  it('makes slide-priority an override over opening or redrawing on the whiteboard', () => {
    const prompt = buildChildPrompt(
      makeBody(),
      agents[0],
      [],
      [],
      ['spotlight', 'laser', 'wb_open', 'wb_draw_shape', 'wb_draw_table', 'wb_draw_latex'],
    );

    expect(prompt).toContain('Slide priority override');
    expect(prompt).toContain('already adequately answers or covers');
    expect(prompt).toContain('instead of opening or redrawing on the whiteboard');
    expect(prompt).toContain(
      'This override applies even when the user asks a mechanism/process/comparison/derivation question',
    );
    expect(prompt).toContain('If the slide is only partially related');
    expect(prompt).toContain('does not answer the requested mechanism');
    expect(prompt).toContain('add a concise whiteboard sketch instead');
    expect(prompt).toContain('diagram, term, formula, table, summary, or process step');
  });

  it('keeps spotlight and laser guidance teacher-only', () => {
    const prompt = buildChildPrompt(
      makeBody(),
      agents[1],
      [],
      [],
      ['wb_open', 'wb_draw_text', 'wb_draw_shape', 'wb_draw_line'],
    );

    expect(prompt).toContain('Smart Visual Teaching');
    expect(prompt).toContain('If you cannot use spotlight/laser');
    expect(prompt).toContain('use only your available actions');
    expect(prompt).not.toContain('Slide priority:');
    expect(prompt).not.toContain('Spotlight/laser are teacher-only visual actions');
  });

  it('keeps student participation short, low-authority, and learning-value oriented', () => {
    const studentAgent: AgentConfig = {
      id: 'student-1',
      name: 'Student',
      role: 'student',
      persona: 'Curious student.',
      avatar: '',
      color: '#ff9933',
      allowedActions: [],
      priority: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      isDefault: true,
    };
    const prompt = buildChildPrompt(makeBody(), studentAgent, [], [], []);

    expect(prompt).toContain('STUDENT');
    expect(prompt).toContain('add student-side learning value');
    expect(prompt).toContain('common misconception');
    expect(prompt).toContain('natural follow-up');
    expect(prompt).toContain('one concrete example');
    expect(prompt).toContain('You are NOT a teacher');
    expect(prompt).toContain('Do not take the first substantive explanation');
    expect(prompt).toContain('summarize the whole lesson');
    expect(prompt).toContain('student-to-student self-chat');
    expect(prompt).toContain('around 40 Chinese characters');
    expect(prompt).toContain('If your response is as long as the teacher response, it is wrong');
  });
});

describe('buildChildPrompt whiteboard code is bounded end-to-end', () => {
  function bodyWithLargeSnapshotCode(snapshotLineCount: number): StatelessChatRequest {
    const snapshotLines = Array.from({ length: snapshotLineCount }, (_, i) => ({
      id: `SNAP${i}`,
      content: `snap_line_${i} = ${i}`,
    }));
    return makeBody({
      storeState: {
        stage: {
          id: 'stage-1',
          name: 'Code lesson',
          whiteboard: [
            {
              id: 'whiteboard-1',
              elements: [
                {
                  id: 'old-code',
                  type: 'code',
                  language: 'python',
                  fileName: 'legacy.py',
                  lines: snapshotLines,
                },
              ],
            },
          ],
        },
        scenes: [],
        currentSceneId: null,
        whiteboardOpen: true,
      },
    } as unknown as Partial<StatelessChatRequest>);
  }

  const thisRoundLedger = [
    {
      actionName: 'wb_draw_code',
      agentId: 'default-1',
      agentName: 'AI teacher',
      params: {
        elementId: 'new-code',
        language: 'python',
        code: 'fresh = 1\nfresh = 2',
        lineIds: ['N1', 'N2'],
        x: 10,
        y: 20,
      },
    },
  ];

  it('caps the full child prompt and keeps this-round code editable', () => {
    const body = bodyWithLargeSnapshotCode(5000);

    const prompt = buildChildPrompt(body, agents[0], [], thisRoundLedger as never, [
      'wb_draw_code',
      'wb_edit_code',
    ]);

    // Both prompt paths that render the board (buildStateContext and
    // buildVirtualWhiteboardContext) are bounded, so a 5000-line stale block
    // cannot blow up the child prompt.
    expect(prompt).not.toContain('snap_line_4999 = 4999');
    expect(prompt).toContain('more line(s) omitted');

    // This round's newly drawn block is still fully editable: its element id and
    // line ids survive the shared budget despite the large stale block.
    expect(prompt).toContain('(id: new-code)');
    expect(prompt).toContain('N1: fresh = 1');
    expect(prompt).toContain('N2: fresh = 2');
  });

  it('grows only by the omitted-count width when the snapshot grows 10x', () => {
    const build = (lineCount: number) =>
      buildChildPrompt(
        bodyWithLargeSnapshotCode(lineCount),
        agents[0],
        [],
        thisRoundLedger as never,
        ['wb_draw_code', 'wb_edit_code'],
      );

    const small = build(5000);
    const large = build(50000);

    // A 10x larger snapshot must not multiply the prompt: the only thing that
    // may grow is the omitted-count number itself (e.g. "4998" -> "49998"),
    // which differs by a handful of characters across both bounded render
    // paths. Anything larger means an unbounded dump slipped through.
    expect(large.length - small.length).toBeLessThan(20);
    // Loose absolute cap regardless of the 50k-line source.
    expect(large.length).toBeLessThan(12000);
  });

  it('keeps a newer persisted code block editable across requests with no ledger', () => {
    // A fresh Pi request has no current-turn ledger, so the board is rendered
    // only from the persisted snapshot via buildStateContext. Persisted
    // elements are stored in creation order: a large OLD block sits before a
    // newer small one. The newer block must still expose its element id, line
    // ids, and content so a later agent can edit it this request, while the
    // old block is squeezed to the omitted tail.
    const oldLines = Array.from({ length: 5000 }, (_, i) => ({
      id: `OLD${i}`,
      content: `old_line_${i} = ${i}`,
    }));
    const body = makeBody({
      storeState: {
        stage: {
          id: 'stage-1',
          name: 'Code lesson',
          whiteboard: [
            {
              id: 'whiteboard-1',
              elements: [
                {
                  id: 'old-code',
                  type: 'code',
                  language: 'python',
                  fileName: 'legacy.py',
                  lines: oldLines,
                },
                {
                  id: 'new-code',
                  type: 'code',
                  language: 'python',
                  fileName: 'fresh.py',
                  lines: [
                    { id: 'N1', content: 'fresh = 1' },
                    { id: 'N2', content: 'fresh = 2' },
                  ],
                },
              ],
            },
          ],
        },
        scenes: [],
        currentSceneId: null,
        whiteboardOpen: true,
      },
    } as unknown as Partial<StatelessChatRequest>);

    // No ledger: buildVirtualWhiteboardContext is skipped, so only the
    // persisted-snapshot path (buildStateContext) renders the board.
    const prompt = buildChildPrompt(body, agents[0], [], [] as never, [
      'wb_draw_code',
      'wb_edit_code',
    ]);

    expect(prompt).toContain('[id:new-code]');
    expect(prompt).toContain('N1: fresh = 1');
    expect(prompt).toContain('N2: fresh = 2');
    expect(prompt).toContain('[id:old-code]');
    expect(prompt).toContain('more line(s) omitted');
    expect(prompt).not.toContain('old_line_4999 = 4999');
    expect(prompt.length).toBeLessThan(12000);
  });
});
