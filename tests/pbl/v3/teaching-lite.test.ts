import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { stageKey } from '@/lib/server/pbl-v3/runtime';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { teachingRunnerConfig, withTeachingTurnBoundary } from '@/lib/server/pbl-v3/runner-tools';
import { indexProjectFiles, validateProjectPackage } from '@/lib/server/pbl-v3/project-package';
import {
  teachingVisitFacts,
  selectTeachingProtocol,
  usesHostTeaching,
} from '@/lib/server/pbl-v3/teaching-lite';
import type { Study, RoleBinding } from '@/lib/server/pbl-v3/store';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
  get: vi.fn(),
  roles: vi.fn(),
  binding: vi.fn(),
  lease: vi.fn(),
  notify: vi.fn(),
  getSession: vi.fn(),
  exclusive: vi.fn(async (_id: unknown, work: () => unknown) => work()),
  userMessages: [] as { seq: number; text: string; pblOpening?: boolean }[],
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.provider,
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  notifyDurableAgentEvent: mocks.notify,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    listUserMessages: async () => mocks.userMessages,
    assertActiveLease: mocks.lease,
    getSession: mocks.getSession,
  }),
}));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: {
    open: async () => ({
      pool: { query: mocks.query },
      get: mocks.get,
      roles: mocks.roles,
      binding: mocks.binding,
      hasSeenOnboarding: async () => true,
      waitForExclusive: mocks.exclusive,
    }),
  },
}));

const FLOW_TOOLS = [
  'read_next_skill',
  'request_skill_review',
  'complete_stage',
  'request_learner_help',
  'respond_to_learner',
];
const OPENING =
  'System stage entry: open the current learning step using its teaching protocol. This is not learner feedback. Introduce the project when entering its first step, and wait for the learner.';

function examplePackage() {
  // Add a milestone opening to the bundled example.
  const folder = 'examples/pbl/future-self-lite';
  const files = Object.fromEntries(
    readdirSync(folder, { recursive: true, encoding: 'utf8' })
      .filter((path) => statSync(join(folder, path)).isFile())
      .map((path) => [path, readFileSync(join(folder, path), 'utf8')]),
  );
  files['skills/OPENING.md'] =
    '# Greeting preview\n\nTrace an input through a formatter. You may then choose a greeting style.\n';
  const descriptor = JSON.parse(files['project.json']!);
  const teaching = descriptor.teaching[0];
  teaching.entrypoint = 'skills/OPENING.md';
  teaching.sections = [
    { name: 'A-intro.md', path: 'skills/A-intro.md' },
    { name: 'B-together.md', path: 'skills/A-plan.md' },
  ];
  files['project.json'] = JSON.stringify(descriptor);
  const { id, version } = descriptor;
  return { files, ...validateProjectPackage(indexProjectFiles(id, version, files)) };
}

let row: Study, binding: RoleBinding;
const request = {
  sessionId: 'role-session',
  ownerId: 'owner',
  workerId: 'worker',
  attempt: 1,
  signal: new AbortController().signal,
};

beforeEach(() => {
  Object.assign(globalThis, { IDBKeyRange });
  const { project } = examplePackage();
  const teachingStage = project.definition.milestones[0]!.stages[0]!;
  binding = {
    session_id: 'role-session',
    study_id: 'study',
    role: 'discussion',
    stage_key: `${project.definition.milestones[0]!.id}:0`,
    feedback_seq: 1,
  } as RoleBinding;
  row = {
    id: 'study',
    owner_id: 'owner',
    stage_id: 'classroom',
    project_id: project.ref.id,
    project_version: project.ref.version,
    project,
    revision: 0,
    state: {
      ...startOrchestration(project.definition).state,
      hostTeachingStage: binding.stage_key,
    },
    environment_id: null,
    evaluation: null,
  } as Study;
  expect(teachingStage.kind).toBe('mentor_say');
  expect(binding.stage_key).toBe(stageKey(row));
  mocks.get.mockReset().mockResolvedValue(row);
  mocks.roles.mockReset().mockResolvedValue([binding]);
  mocks.binding.mockReset().mockResolvedValue(binding);
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.provider.mockReset().mockResolvedValue({
    pool: { query: mocks.query },
    runtimeStore: new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    }),
  });
  mocks.lease.mockReset().mockResolvedValue(undefined);
  mocks.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('host-driven teaching', () => {
  it('pins opt-in only at entry with a nonempty milestone opening', async () => {
    const { project } = examplePackage();
    const initial = startOrchestration(project.definition);
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'false');
    const old = selectTeachingProtocol(project, initial);
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'true');
    expect(usesHostTeaching(old.state)).toBe(false);
    const active = selectTeachingProtocol(project, initial);
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'false');
    expect(usesHostTeaching(active.state)).toBe(true);
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'true');
    const course = project.coursePackage!;
    course.descriptor.teaching[0]!.entrypoint = 'skills/SKILL.md';
    expect(usesHostTeaching(selectTeachingProtocol(project, initial).state)).toBe(false);
    delete row.state.hostTeachingStage;
    mocks.userMessages = [{ seq: 1, text: OPENING, pblOpening: true }];
    const config = await teachingRunnerConfig(request);
    expect(config.allowedToolNames.has('request_skill_review')).toBe(true);
    expect(config.needsTurnReceipt()).toBe(true);
  });

  it.each(['failed', 'cancelled', 'silent'])(
    'keeps an unsuccessful or silent opening locked (%s)',
    (status) => {
      const events = [
        { type: 'pbl_stage_entered', data: { step: 'teaching', milestoneId: 'm', stageIndex: 0 } },
        { type: 'user_message', data: { pblOpening: true } },
        { type: 'session_start', attempt: 1, data: {} },
        {
          type: 'message_end',
          attempt: 1,
          data: {
            message: {
              role: 'assistant',
              content:
                status === 'silent'
                  ? [{ type: 'toolCall', name: 'draw' }]
                  : [{ type: 'text', text: 'partial' }],
            },
          },
        },
        {
          type: 'session_end',
          attempt: 1,
          data: { status: status === 'silent' ? 'succeeded' : status },
        },
      ];
      expect(teachingVisitFacts(events, { stageKey: 'm:0' }).openingDelivered).toBe(false);
    },
  );
  it.each([false, true])(
    'sends the visible layout, tools and exit at the provider boundary (board: %s)',
    async (board) => {
      vi.stubEnv('OPENMAIC_PBL_V3_WHITEBOARD', String(board));
      const wire = new MockLanguageModelV3({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ]),
        }),
      });
      const model = {
        id: 'example',
        api: 'openai-completions',
        contextWindow: 128000,
      } as Parameters<StreamFn>[0];
      for (const followUp of [false, true]) {
        binding.feedback_seq = followUp ? 2 : 1;
        mocks.userMessages = [
          { seq: 1, text: OPENING, pblOpening: true },
          ...(followUp ? [{ seq: 2, text: 'Show me an example.' }] : []),
        ];
        const entryEvents = [
          {
            type: 'pbl_stage_entered',
            data: { step: 'teaching', milestoneId: row.state.position.milestoneId, stageIndex: 0 },
          },
          { type: 'user_message', data: { pblOpening: true } },
          { type: 'session_start', attempt: 1, data: {} },
          {
            type: 'message_end',
            attempt: 1,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Here is the opening.' }],
              },
            },
          },
          { type: 'session_end', attempt: 1, data: { status: 'succeeded' } },
        ];
        mocks.query.mockImplementation(async (...args: unknown[]) => ({
          rows: (String(args[0]).includes('SELECT type, attempt') && followUp
            ? entryEvents
            : []) as never[],
        }));
        const config = await teachingRunnerConfig(request);
        const send = withTeachingTurnBoundary(
          createCallLlmStreamFn({ languageModel: wire }),
          config.isTurnComplete,
          config.historyWindow,
          config.liveContext,
        );
        const messages: Parameters<StreamFn>[1]['messages'] = [
          { role: 'user', content: OPENING, timestamp: 1 },
        ];
        if (followUp)
          messages.push(
            {
              role: 'assistant',
              api: 'openai-completions',
              provider: 'example',
              model: 'example',
              timestamp: 2,
              stopReason: 'stop',
              content: [{ type: 'text', text: 'A function returns its greeting to the caller.' }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
            { role: 'user', content: 'Show me an example.', timestamp: 3 },
          );
        const reply = await send(model, {
          systemPrompt: config.systemPrompt,
          tools: config.tools,
          messages,
        });
        await reply.result();
        const sent = wire.doStreamCalls.at(-1)!;
        const text = JSON.stringify(sent);
        if (followUp) expect(sent.prompt.map((m) => m.role)).toContain('assistant');
        for (const tool of FLOW_TOOLS) expect(text).not.toContain(tool);
        const system = sent.prompt[0];
        expect(system.role).toBe('system');
        if (system.role !== 'system') throw Error('Missing system prompt');
        expect(system.content).toContain(
          board
            ? 'beside the tutor avatar'
            : 'the task bar at the bottom of the Learning Assistant pane',
        );
        if (board)
          expect(system.content).not.toContain('at the bottom of the Learning Assistant pane');
        const tail = sent.prompt.at(-1);
        if (tail?.role !== 'user' || tail.content[0].type !== 'text')
          throw Error('Missing host state');
        expect(tail.content[0].text).toContain('<openmaic-host-state>');
        const current = JSON.parse(
          tail.content[0].text.split('static product guide still applies): ')[1].split('\n')[0],
        ).productContext.current;
        expect(current.learnerActions.includes('next')).toBe(followUp);
      }
    },
  );
  it('registers no progress-registration tools and speaks ordinary prose', async () => {
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'true');
    mocks.userMessages = [{ seq: 1, text: OPENING, pblOpening: true }];
    const config = await teachingRunnerConfig(request);
    const names = config.tools.map((tool) => tool.name);
    for (const flow of FLOW_TOOLS) expect(names).not.toContain(flow);
    expect(names).toContain('set_response_language');
    expect(config.needsTurnReceipt()).toBe(false);
  });

  it('sends only the opening on the opening turn, without section material', async () => {
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'true');
    mocks.userMessages = [{ seq: 1, text: OPENING, pblOpening: true }];
    const config = await teachingRunnerConfig(request);
    const { project } = examplePackage();
    const opening = project.coursePackage!.bundle.files['skills/OPENING.md']!;
    const section = project.coursePackage!.bundle.files['skills/A-plan.md']!;
    // The opening and the sections are serialized into one JSON block, so compare
    // single-line phrases rather than multi-line excerpts.
    expect(config.systemPrompt).toContain('Trace an input through a formatter');
    expect(config.systemPrompt).not.toContain('Review the plan');
    expect(opening).toContain('choose a greeting style');
    expect(section).toContain('Review the plan');
    for (const flow of FLOW_TOOLS) expect(config.systemPrompt).not.toContain(flow);
  });

  it('offers the sections as reference material once the learner keeps talking', async () => {
    vi.stubEnv('OPENMAIC_PBL_V3_TEACHING_LITE', 'true');
    mocks.userMessages = [
      { seq: 1, text: OPENING, pblOpening: true },
      { seq: 2, text: 'Why would I separate the two functions?' },
    ];
    const config = await teachingRunnerConfig(request);
    const { project } = examplePackage();
    const section = project.coursePackage!.bundle.files['skills/A-plan.md']!;
    expect(section).toContain('Review the plan');
    expect(config.systemPrompt).toContain('Review the plan');
  });

  it('keeps the departure once the opening landed, even if a later turn failed', () => {
    const events: Parameters<typeof teachingVisitFacts>[0] = [
      {
        type: 'pbl_stage_entered',
        data: {
          step: 'teaching',
          milestoneId: binding.stage_key.split(':')[0],
          stageIndex: 0,
        },
      },
      { type: 'user_message', data: { pblOpening: true } },
      { type: 'session_start', attempt: 1, data: {} },
      {
        type: 'message_end',
        attempt: 1,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'The goal is to return a greeting.' }] } },
      },
      { type: 'session_end', attempt: 1, data: { status: 'succeeded' } },
      { type: 'user_message', data: { text: 'Can you show an example?' } },
      { type: 'session_start', attempt: 2, data: {} },
      { type: 'session_end', attempt: 2, data: { status: 'failed' } },
    ];
    const facts = teachingVisitFacts(events, { stageKey: binding.stage_key });
    expect(facts.openingDelivered).toBe(true);
    expect(facts.learnerTurns).toBe(1);
  });
});
