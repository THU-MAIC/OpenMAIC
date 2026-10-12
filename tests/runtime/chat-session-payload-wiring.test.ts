import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { DSL_VERSION } from '@openmaic/dsl';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const cookie = '11111111-1111-4111-8111-111111111111';
const learnerKey = `anon:${cookie}`;
const now = 1_800_000_000_000;
const timestamp = new Date(now).toISOString();
const cue = {
  fromAgentId: 'teacher',
  prompt: 'Choose an example.',
  options: ['Example', 'Continue'],
  parkedAt: now,
};
const director = { turnCount: 2, agentResponses: [], whiteboardLedger: [] };

function sessionState() {
  return {
    kind: 'chat_session_state',
    payloadVersion: 1,
    role: 'system',
    content: 'Q&A',
    chatSessionId: 'qa',
    type: 'qa',
    title: 'Q&A',
    status: 'waiting-user',
    config: { agentIds: ['teacher'] },
    toolCalls: [],
    messageIds: [],
    createdAt: now,
    updatedAt: now,
    cueUser: cue,
    directorState: director,
  };
}

const invalidCues: [string, unknown][] = [
  ['null cue', null],
  ['array cue', []],
  ['unknown cue field', { ...cue, extra: 'unexpected' }],
  ['missing parkedAt', { prompt: 'Question?' }],
  ['null parkedAt', { ...cue, parkedAt: null }],
  ['string parkedAt', { ...cue, parkedAt: String(now) }],
  ['oversized agent id', { ...cue, fromAgentId: 'a'.repeat(257) }],
  ['non-string agent id', { ...cue, fromAgentId: 42 }],
  ['oversized prompt', { ...cue, prompt: 'p'.repeat(241) }],
  ['non-string prompt', { ...cue, prompt: 42 }],
  ['one option', { ...cue, options: ['Example'] }],
  ['five options', { ...cue, options: ['One', 'Two', 'Three', 'Four', 'Five'] }],
  ['empty legacy option', { ...cue, options: ['', 'Continue'] }],
  ['whitespace legacy option', { ...cue, options: ['  ', 'Continue'] }],
  ['oversized legacy option', { ...cue, options: ['o'.repeat(61), 'Continue'] }],
  ['non-string legacy option', { ...cue, options: [42, 'Continue'] }],
  ['null options', { ...cue, options: null }],
  ['empty structured label', { ...cue, options: [{ label: '' }, { label: 'Continue' }] }],
  ['whitespace structured label', { ...cue, options: [{ label: '  ' }, { label: 'Continue' }] }],
  [
    'oversized structured label',
    { ...cue, options: [{ label: 'o'.repeat(61) }, { label: 'Continue' }] },
  ],
  [
    'missing structured label',
    { ...cue, options: [{ action: 'end_discussion' }, { label: 'Continue' }] },
  ],
  [
    'unknown option action',
    { ...cue, options: [{ label: 'Example' }, { label: 'Continue', action: 'resume_playback' }] },
  ],
  [
    'null option action',
    { ...cue, options: [{ label: 'Example' }, { label: 'Continue', action: null }] },
  ],
  [
    'unknown option field',
    { ...cue, options: [{ label: 'Example', extra: 'unexpected' }, { label: 'Continue' }] },
  ],
];

const invalidDirectors: [string, unknown][] = [
  ['null director', null],
  ['array director', []],
  ['missing turn count', { agentResponses: [], whiteboardLedger: [] }],
  ['negative turn count', { ...director, turnCount: -1 }],
  ['fractional turn count', { ...director, turnCount: 1.5 }],
  ['string turn count', { ...director, turnCount: '2' }],
  ['missing agent responses', { turnCount: 2, whiteboardLedger: [] }],
  ['null agent responses', { ...director, agentResponses: null }],
  ['missing whiteboard ledger', { turnCount: 2, agentResponses: [] }],
  ['non-array whiteboard ledger', { ...director, whiteboardLedger: {} }],
  ['too many agent responses', { ...director, agentResponses: Array(257).fill({}) }],
  ['too many whiteboard entries', { ...director, whiteboardLedger: Array(257).fill({}) }],
  [
    'oversized serialized director',
    { ...director, agentResponses: [{ contentPreview: 'a'.repeat(65_536) }] },
  ],
  [
    'oversized UTF-8 director',
    { ...director, agentResponses: [{ contentPreview: '问'.repeat(22_000) }] },
  ],
];

describe('chat session payload through /api/persistence (PGlite)', () => {
  let pool: PGlitePool;
  let store: HttpRuntimeStore;
  let fetch: typeof globalThis.fetch;
  let stageId: string;
  let runtimeId: string;
  let baseline: Awaited<ReturnType<HttpRuntimeStore['listRecords']>>;
  const responses: { method: string; path: string; status: number }[] = [];

  beforeAll(async () => {
    vi.resetModules();
    const url = `postgres://chat-session-bounds-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    pool = new PGlitePool(new PGlite());
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(url, () => pool as never);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    fetch = async (input, init) => {
      const request = new Request(new URL(String(input), 'http://localhost'), init);
      request.headers.set('cookie', `anonymous_id=${cookie}`);
      const response = await handlePersistenceRequest(request, {
        poolFactory: () => pool as never,
      });
      responses.push({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    };
    stageId = `cue-${randomUUID()}`;
    const seeded = await fetch(`/api/persistence/documents/${stageId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dslVersion: DSL_VERSION,
        stage: { id: stageId, name: 'Cue bounds', createdAt: now, updatedAt: now },
        scenes: [],
      }),
    });
    expect(seeded.status).toBe(204);
    store = new HttpRuntimeStore({ baseUrl: 'http://localhost/api/persistence', fetch });
  }, 30_000);

  beforeEach(async () => {
    runtimeId = `chat-${randomUUID()}`;
    await store.createSession({
      id: runtimeId,
      kind: 'chat',
      stageId,
      learnerKey,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.appendRecord({
      id: `${runtimeId}:ordinary`,
      sessionId: runtimeId,
      createdAt: timestamp,
      payload: { role: 'assistant', content: 'Choose an example.' },
    });
    baseline = await store.listRecords(runtimeId);
    responses.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
    vi.unstubAllEnvs();
  });

  it.each(invalidCues)('rejects %s without appending a row', async (_name, cueUser) => {
    await expect(
      store.appendRecord({
        id: `${runtimeId}:invalid`,
        sessionId: runtimeId,
        createdAt: timestamp,
        payload: { ...sessionState(), cueUser },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(responses[0]).toMatchObject({ method: 'POST', status: 400 });
    expect(responses[0]!.path).toBe(`/api/persistence/runtime/sessions/${runtimeId}/records`);
    expect(await store.listRecords(runtimeId)).toEqual(baseline);
  });

  it.each(invalidDirectors)('rejects %s without appending a row', async (_name, directorState) => {
    await expect(
      store.appendRecord({
        id: `${runtimeId}:invalid`,
        sessionId: runtimeId,
        createdAt: timestamp,
        payload: { ...sessionState(), directorState },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(responses[0]).toMatchObject({ method: 'POST', status: 400 });
    expect(await store.listRecords(runtimeId)).toEqual(baseline);
  });

  it.each(['parkedAt', 'turnCount'])(
    'rejects nonfinite %s sent directly as a JSON exponent',
    async (field) => {
      // JSON number syntax permits exponents that overflow JavaScript's finite range.
      const body = JSON.stringify({
        id: `${runtimeId}:nonfinite`,
        sessionId: runtimeId,
        createdAt: timestamp,
        payload: sessionState(),
      }).replace(new RegExp(`"${field}":\\d+`), `"${field}":1e400`);
      const response = await fetch(`/api/persistence/runtime/sessions/${runtimeId}/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(await store.listRecords(runtimeId)).toEqual(baseline);
    },
  );

  it('persists metadata-free, prompt-only, legacy and structured cues without losing option actions', async () => {
    const validCues = [
      { parkedAt: now },
      { parkedAt: now, prompt: 'What do you think?' },
      cue,
      {
        ...cue,
        fromAgentId: 'a'.repeat(256),
        prompt: 'p'.repeat(240),
        options: ['o'.repeat(60), 'Continue'],
      },
      {
        ...cue,
        options: [
          { label: 'o'.repeat(60) },
          { label: '继续学习' },
          { label: 'Example' },
          { label: 'Back to the lesson', action: 'end_discussion' },
        ],
      },
      { ...cue, options: ['Example', { label: '回到课程吧', action: 'end_discussion' }] },
    ];
    for (const [index, cueUser] of validCues.entries()) {
      const payload = { ...sessionState(), cueUser };
      await store.appendRecord({
        id: `${runtimeId}:valid-${index}`,
        sessionId: runtimeId,
        createdAt: timestamp,
        payload,
      });
      expect((await store.listRecords(runtimeId)).at(-1)?.payload).toEqual(payload);
    }
    expect((await store.listRecords(runtimeId))[0]).toEqual(baseline[0]);
  });

  it('accepts omitted metadata and director collections at their limits', async () => {
    const { cueUser: _cue, directorState: _director, ...withoutMetadata } = sessionState();
    await store.appendRecord({
      id: `${runtimeId}:without-metadata`,
      sessionId: runtimeId,
      createdAt: timestamp,
      payload: withoutMetadata,
    });
    const agentResponse = {
      agentId: 'teacher',
      agentName: 'Teacher',
      contentPreview: 'Example',
      actionCount: 0,
      whiteboardActions: [],
    };
    const whiteboardAction = {
      actionName: 'wb_clear',
      agentId: 'teacher',
      agentName: 'Teacher',
      params: {},
    };
    const payload = {
      ...sessionState(),
      directorState: {
        turnCount: 256,
        agentResponses: Array(256).fill(agentResponse),
        whiteboardLedger: Array(256).fill(whiteboardAction),
      },
    };
    await store.appendRecord({
      id: `${runtimeId}:at-limit`,
      sessionId: runtimeId,
      createdAt: timestamp,
      payload,
    });
    expect((await store.listRecords(runtimeId)).at(-1)?.payload).toEqual(payload);
  });
});
