/**
 * The request preview, end to end over pure functions: real stream frames →
 * the session fold → `requestTrack` (the one adapter) → `scheduleRequestPreview`
 * at a clock. Every rule is a table of (frames, now) → view.
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialSessionState,
  foldEvent,
  type SessionStatus,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import { requestTrack } from '@/lib/workbench/request-activity';
import {
  DEFAULT_REQUEST_SCHEDULE,
  rosterRevealMs,
  scheduleRequestPreview,
  sceneOfTool,
  type RequestScheduleOptions,
} from '@/lib/workbench/request-schedule';

const OPTS: RequestScheduleOptions = { holdMs: 2000, maxLagMs: 3000 };
const PLAN = 'Plan:\n1. Hook\n2. Explore\n3. Quiz';

type Frame = Omit<WorkbenchEvent, 'id' | 'attempt'>;
const ev = (ts: number, type: string, data: unknown = {}): Frame => ({ ts, type, data });
const start = (ts: number, prompt = 'make a course') => ev(ts, 'session_start', { prompt });
const toolStart = (ts: number, callId: string, toolName: string, args: unknown = {}) =>
  ev(ts, 'tool_execution_start', { toolCallId: callId, toolName, args });
const toolEnd = (ts: number, callId: string, isError = false) =>
  ev(ts, 'tool_execution_end', { toolCallId: callId, isError, result: { content: [] } });
const quick = (ts: number, callId: string, toolName: string, args: unknown = {}) => [
  toolStart(ts, callId, toolName, args),
  toolEnd(ts + 3, callId),
];
const skill = (ts: number, callId: string, name: string) =>
  quick(ts, callId, 'read', { path: `/skills/agent-runtime/${name}/SKILL.md` });
const reply = (ts: number, text: string) => [
  ev(ts, 'message_start', { message: { role: 'assistant', content: [] } }),
  ev(ts, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
];
const ask = (ts: number, question: string) => [
  toolStart(ts, `ask-${ts}`, 'ask_user', { question }),
  ev(ts + 1, 'user_question', { question, options: [{ id: 'a', label: 'A' }] }),
  toolEnd(ts + 2, `ask-${ts}`),
  ev(ts + 3, 'agent_end'),
  ev(ts + 4, 'session_end', { status: 'succeeded' }),
];
const answer = (ts: number, text: string) => [
  ev(ts, 'user_message', { text, delivery: 'queued' }),
  ev(ts + 100, 'session_resumed', { reason: 'follow_up' }),
];
const checkpoint = (ts: number, order: number, sceneId: string) =>
  ev(ts, 'checkpoint', { tool: 'generate_scene', stageId: 'stage-1', order, sceneId });
const end = (ts: number, status: SessionStatus = 'succeeded') => [
  ev(ts, 'agent_end'),
  ev(ts, 'session_end', { status }),
];

function fold(frames: readonly Frame[]): WorkbenchFold {
  return frames.reduce<WorkbenchFold>(
    (state, frame, index) => foldEvent(state, { ...frame, id: index + 1, attempt: 1 }),
    createInitialSessionState(),
  );
}
function view(frames: readonly Frame[], now: number, status?: SessionStatus) {
  const state = fold(frames);
  const track = requestTrack(state.chat, status ?? state.status, false);
  if (!track) throw new Error('no request track');
  return scheduleRequestPreview(track, now, OPTS);
}
const scene = (frames: readonly Frame[], now: number, status?: SessionStatus) =>
  view(frames, now, status).scene;

describe('every action maps onto five scenes', () => {
  it('maps tools to scenes; unknown and short tools are understanding', () => {
    expect(sceneOfTool('read')).toBe('understanding');
    expect(sceneOfTool('read_material')).toBe('understanding');
    expect(sceneOfTool('list_scenes')).toBe('understanding');
    expect(sceneOfTool('some_new_tool')).toBe('understanding');
    expect(sceneOfTool('web_search')).toBe('researching');
    expect(sceneOfTool('fetch_url')).toBe('researching');
    expect(sceneOfTool('create_stage')).toBe('assembling');
    expect(sceneOfTool('set_roster')).toBe('assembling');
    expect(sceneOfTool('list_voices')).toBe('assembling');
    expect(sceneOfTool('generate_scene')).toBe('generating');
    expect(sceneOfTool('generate_tts')).toBe('generating');
    expect(sceneOfTool('generate_actions')).toBe('generating');
    expect(sceneOfTool('generate_image')).toBe('generating');
    expect(sceneOfTool('generate_video')).toBe('generating');
  });
});

describe('scenes follow the stream', () => {
  it('stays quiet while the request only talks', () => {
    const frames = [start(0, 'why does light bend?'), ...reply(500, 'Because…')];
    expect(view(frames, 1000).mode).toBe('quiet');
    expect(view([...frames, ...end(900)], 5000).mode).toBe('quiet');
  });

  it('a skill read shows understanding; it never earns a scene of its own', () => {
    const frames = [start(0), ...skill(1000, 'k', 'stage-design')];
    expect(view(frames, 1000)).toMatchObject({ mode: 'scene', scene: 'understanding' });
  });

  it('holds a scene at least 2 s, then moves on', () => {
    const frames = [
      start(0),
      ...skill(500, 'k', 'stage-design'),
      toolStart(1000, 's', 'web_search'),
    ];
    expect(scene(frames, 1999)).toBe('understanding');
    expect(view(frames, 1000).nextChangeAt).toBe(2000);
    expect(scene(frames, 2000)).toBe('researching');
  });

  it('thinking and quick reads between steps fold into the scene on screen', () => {
    const frames = [
      start(0),
      ...quick(2500, 'cs', 'create_stage', { title: 'Light' }),
      ...quick(2510, 'v', 'list_voices'),
      ...reply(3000, 'Now the roster.'),
      ...skill(4000, 'k', 'lecture-style'),
      ...quick(6000, 'r', 'set_roster'),
    ];
    for (const now of [2500, 3500, 4500, 7000]) expect(scene(frames, now)).toBe('assembling');
  });

  it('is not linear: a search after assembling goes back to researching', () => {
    const frames = [
      start(0),
      ...quick(2500, 'cs', 'create_stage'),
      toolStart(5000, 's', 'web_search', { query: 'refraction index of water' }),
    ];
    expect(scene(frames, 4000)).toBe('assembling');
    expect(scene(frames, 5000)).toBe('researching');
    expect(view(frames, 5000).searches).toHaveLength(1);
  });

  it('shows changes that land together in order, unless far behind', () => {
    const frames = [
      start(0),
      toolStart(500, 's', 'web_search', { query: 'q' }),
      toolEnd(2500, 's'),
      toolStart(600, 'g', 'generate_scene', { order: 1, title: 'Intro' }),
    ];
    expect(scene(frames, 2000)).toBe('researching');
    expect(scene(frames, 4000)).toBe('generating');
    // A screen that fell behind skips to the newest.
    const late = [
      start(0),
      toolStart(1900, 's', 'web_search'),
      toolStart(1950, 'cs', 'create_stage'),
    ];
    late.push(toolStart(1990, 'g', 'generate_scene', { order: 1 }));
    expect(scene(late, 2000)).toBe('researching');
    expect(scene(late, 4000)).toBe('assembling');
  });

  it('a millisecond step with something after it is a passing moment, not a scene', () => {
    const frames = [
      start(0),
      ...quick(500, 'cs', 'create_stage'),
      toolStart(600, 'g', 'generate_scene', { order: 1, title: 'Intro' }),
    ];
    expect(scene(frames, 2000)).toBe('generating');
  });
});

describe('questions', () => {
  it('a written plan without a question is no scene of its own', () => {
    const frames = [start(0), ...skill(500, 'k', 'stage-design'), ...reply(3000, PLAN)];
    expect(view(frames, 3000)).toMatchObject({ scene: 'understanding', question: null });
  });

  it('every question shows at once, with what the agent wrote before it as-is', () => {
    const frames = [
      start(0),
      ...skill(500, 'k', 'stage-design'),
      ...reply(1000, PLAN),
      ...ask(1200, 'Go ahead?'),
    ];
    const asked = view(frames, 1201);
    expect(asked).toMatchObject({ mode: 'scene', scene: 'asking' });
    expect(asked.question?.planText).toBe(PLAN);
    expect(asked.question?.node.text).toBe('Go ahead?');
    // It does not fold when the run ends on the question.
    expect(view(frames, 60_000).mode).toBe('scene');
    // A clarifying question is presented the same way.
    const plain = [
      start(0),
      ...skill(500, 'k', 'stage-design'),
      ...ask(3000, 'What should I make?'),
    ];
    expect(view(plain, 3001)).toMatchObject({ scene: 'asking' });
    expect(view(plain, 3001).question?.planText).toBeNull();
  });

  it('an answer hands the request back to the agent: understanding until it builds', () => {
    const frames = [
      start(0),
      ...reply(1000, PLAN),
      ...ask(1200, 'Go ahead?'),
      ...answer(9000, 'Yes'),
      ...reply(10_000, 'Starting.'),
      ...quick(12_000, 'cs', 'create_stage'),
    ];
    expect(view(frames, 10_500, 'running')).toMatchObject({
      scene: 'understanding',
      question: null,
    });
    expect(scene(frames, 12_000, 'running')).toBe('assembling');
  });
});

describe('page media', () => {
  it('a long image generation after the roster moves to generating once the cast has flipped', () => {
    const frames = [
      start(0),
      ...quick(500, 'cs', 'create_stage'),
      toolStart(1000, 'r', 'set_roster'),
      ev(1010, 'tool_execution_end', {
        toolCallId: 'r',
        isError: false,
        result: { content: [], details: { roster: [{ id: 't', name: 'T', role: 'teacher' }] } },
      }),
      toolStart(1100, 'img', 'generate_image', { prompt: 'a bent straw' }),
    ];
    expect(scene(frames, 2000)).toBe('assembling');
    expect(scene(frames, 40_000)).toBe('generating');
  });
});

describe('interleaved quick and long steps', () => {
  it('does not flip back and forth for millisecond calls between long ones (real run)', () => {
    // The order a real run produced: course, a failed instant image, skills,
    // voices and a 29 s image together, the roster, then another long image.
    const frames = [
      start(0),
      ...quick(1000, 'cs', 'create_stage'),
      ...quick(1001, 'i0', 'generate_image'),
      ...skill(3000, 'k', 'stage-design'),
      ...quick(5700, 'v', 'list_voices'),
      toolStart(5700, 'i1', 'generate_image'),
      toolEnd(34_800, 'i1'),
    ];
    const seen: string[] = [];
    for (let now = 0; now <= 34_000; now += 100) {
      const current = scene(frames, now);
      if (seen[seen.length - 1] !== current) seen.push(current);
    }
    expect(seen).toEqual(['understanding', 'generating']);
  });
});

describe('the roster reveal', () => {
  const roster = [
    { id: 't', name: 'Ms Chen', role: 'teacher', avatar: '/avatars/teacher.png', color: '#3b82f6' },
    { id: 's1', name: 'Lin', role: 'student', avatar: '/avatars/a.png', color: '#10b981' },
    { id: 's2', name: 'Bo', role: 'student', avatar: '/avatars/b.png', color: 'not-a-colour' },
  ];
  const frames = [
    start(0),
    ...quick(500, 'cs', 'create_stage', { title: 'Light' }),
    toolStart(3000, 'r', 'set_roster'),
    ev(3020, 'tool_execution_end', {
      toolCallId: 'r',
      isError: false,
      result: { content: [], details: { roster } },
    }),
    toolStart(3500, 'g', 'generate_scene', { order: 1, title: 'Intro' }),
  ];

  it('carries the cast from set_roster’s result, once it has returned', () => {
    expect(view(frames, 2900).roster).toBeNull();
    const cast = view(frames, 3100).roster;
    expect(cast?.map((agent) => agent.name)).toEqual(['Ms Chen', 'Lin', 'Bo']);
    expect(cast?.[2].color).toBe('#8b5cf6');
  });

  it('a screen that fell behind still stops at the cast', () => {
    const burst = [
      start(0),
      toolStart(100, 's', 'web_search'),
      ...quick(300, 'cs', 'create_stage'),
      toolStart(350, 'r', 'set_roster'),
      ev(400, 'tool_execution_end', {
        toolCallId: 'r',
        isError: false,
        result: { content: [], details: { roster } },
      }),
      toolStart(500, 'g', 'generate_scene', { order: 1 }),
    ];
    const state = fold(burst);
    const track = requestTrack(state.chat, 'running', false)!;
    const behind = { holdMs: 2000, maxLagMs: 0 };
    expect(scheduleRequestPreview(track, 2000, behind).scene).toBe('assembling');
  });

  it('holds assembling until every card has flipped, then generates', () => {
    const revealDone = 3020 + rosterRevealMs(3);
    expect(scene(frames, revealDone - 1)).toBe('assembling');
    expect(scene(frames, revealDone)).toBe('generating');
    expect(rosterRevealMs(3)).toBe(2000);
  });
});

describe('generating, fold and hand-over', () => {
  const frames = [
    start(0),
    ...quick(500, 'cs', 'create_stage'),
    toolStart(3000, 'g1', 'generate_scene', { order: 1, title: 'Intro' }),
  ];

  it('captions the page being written from its real arguments', () => {
    const v = view(frames, 40_000);
    expect(v.scene).toBe('generating');
    expect(v.page?.order).toBe(1);
    expect(v.page?.step.node.toolArgs?.title).toBe('Intro');
    expect(v.speaking).toBe(false);
  });

  it('narration is the same scene with the actions visual', () => {
    const speech = [
      ...frames,
      toolEnd(50_000, 'g1'),
      toolStart(50_100, 't1', 'generate_tts', { order: 1 }),
    ];
    expect(view(speech, 50_200)).toMatchObject({ scene: 'generating', speaking: true });
  });

  it('hands over at the first persisted page', () => {
    const done = [...frames, checkpoint(80_000, 1, 's1'), toolEnd(80_100, 'g1')];
    expect(view(done, 80_100).mode).toBe('classroom');
  });

  it('folds a request that ended without a page once its scene was held', () => {
    const ended = [
      start(0),
      toolStart(100, 's', 'web_search'),
      toolEnd(1500, 's'),
      ...reply(1600, 'x'),
      ...end(1700),
    ];
    expect(view(ended, 2500).mode).toBe('scene');
    expect(view(ended, 4100).mode).toBe('collapsed');
  });

  it('uses the intended defaults', () => {
    expect(DEFAULT_REQUEST_SCHEDULE).toEqual({ holdMs: 2000, maxLagMs: 3000 });
  });
});
