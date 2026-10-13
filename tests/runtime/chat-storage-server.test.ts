import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { DSL_VERSION } from '@openmaic/dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadChatSessions, saveChatSessions } from '@/lib/utils/chat-storage';
import {
  normalizeStoredSessionsForRestore,
  parkSessionForUser,
} from '@/components/chat/use-chat-sessions';
import type { ChatSession } from '@/lib/types/chat';

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
const postgresUrl = process.env.PG_CHAT_CUE_URL;

function qaSession(id: string, turnCount: number): ChatSession {
  const now = 1_800_000_000_000;
  const summaries = Array.from({ length: turnCount }, (_, index) => {
    const turn = index + 1;
    return `第${turn}轮：${'我们结合生活中的例子解释这个概念，并说明每个步骤的原因。'.repeat(12)}`.slice(
      0,
      300,
    );
  });
  return {
    id,
    type: 'qa',
    title: 'Q&A',
    status: 'waiting-user',
    messages: summaries
      .flatMap((summary, index): ChatSession['messages'] => [
        {
          id: `${id}:user-${index + 1}`,
          role: 'user',
          parts: [{ type: 'text', text: `请解释第${index + 1}个问题，并给出一个实际例子。` }],
        },
        {
          id: `${id}:teacher-${index + 1}`,
          role: 'assistant',
          parts: [{ type: 'text', text: summary }],
        },
      ])
      .slice(-200),
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: now,
    updatedAt: now + turnCount,
    cueUser: { fromAgentId: 'default-1', prompt: '还有什么问题？', parkedAt: now + turnCount },
    directorState: {
      turnCount,
      agentResponses: summaries.map((contentPreview) => ({
        agentId: 'default-1',
        agentName: 'Teacher',
        contentPreview,
        actionCount: 0,
        whiteboardActions: [],
      })),
      whiteboardLedger: [],
    },
  };
}

for (const backend of ['PGlite', 'PostgreSQL'] as const) {
  describe.skipIf(backend === 'PostgreSQL' && !postgresUrl)(
    `parked chat through /api/persistence (${backend})`,
    () => {
      let pool: PGlitePool | Pool;
      let store: HttpRuntimeStore;
      let stageId: string;
      const paths: string[] = [];
      beforeEach(async () => {
        delete (globalThis as Record<symbol, unknown>)[Symbol.for('openmaic.persistence.provider')];
        vi.resetModules();
        vi.stubGlobal('navigator', {
          locks: { request: async (...args: unknown[]) => (args.at(-1) as () => unknown)() },
        });
        paths.length = 0;
        const url = backend === 'PGlite' ? `postgres://chat-cue-${randomUUID()}` : postgresUrl!;
        vi.stubEnv('DATABASE_URL', url);
        vi.stubEnv('ASSET_S3_BUCKET', '');
        vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
        vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
        pool =
          backend === 'PGlite' ? new PGlitePool(new PGlite()) : new Pool({ connectionString: url });
        const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
        await getServerPersistenceProvider(url, () => pool as never);
        const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(new URL(String(input), 'http://localhost'), init);
          request.headers.set('cookie', `anonymous_id=${cookie}`);
          paths.push(new URL(request.url).pathname);
          return handlePersistenceRequest(request, { poolFactory: () => pool as never });
        };
        stageId = `cue-${randomUUID()}`;
        const now = 1_800_000_000_000;
        const seeded = await fetch(`/api/persistence/documents/${stageId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            dslVersion: DSL_VERSION,
            stage: { id: stageId, name: 'Cue test', createdAt: now, updatedAt: now },
            scenes: [],
          }),
        });
        expect(seeded.status).toBe(204);
        store = new HttpRuntimeStore({ baseUrl: 'http://localhost/api/persistence', fetch });
      }, 60_000);
      afterEach(async () => {
        await pool?.end();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      });

      it.each([
        ['prompt-only', 'What do you think?', undefined],
        ['metadata-free', undefined, undefined],
        ['one option', 'What do you think?', ['Only one']],
      ] as const)(
        'persists a %s cue created by the session hook',
        async (_name, prompt, options) => {
          const now = 1_800_000_000_000;
          const input = parkSessionForUser(
            {
              id: 'open-ended',
              type: 'qa',
              title: 'Q&A',
              status: 'active',
              messages: [],
              config: { agentIds: ['default-1'] },
              toolCalls: [],
              pendingToolCalls: [],
              createdAt: now,
              updatedAt: now,
            },
            undefined,
            prompt,
            options ? [...options] : undefined,
            now + 1,
          );
          await saveChatSessions(stageId, [input], { store, learnerKey });
          const [loaded] = await loadChatSessions(stageId, { store, learnerKey });
          expect(loaded?.status).toBe('waiting-user');
          expect(loaded?.cueUser).toEqual({ ...(prompt ? { prompt } : {}), parkedAt: now + 1 });
          expect(paths.some((path) => path.includes('/records'))).toBe(true);
        },
      );

      it('saves and reloads waiting-user, prompt/options and director context without a model request', async () => {
        const now = 1_800_000_000_000;
        const input: ChatSession = {
          id: 'parked-qa',
          type: 'qa',
          title: 'Q&A',
          status: 'waiting-user',
          messages: [
            {
              id: 'agent-turn',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Choose an example.' }],
            },
          ],
          config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
          toolCalls: [],
          pendingToolCalls: [],
          createdAt: now,
          updatedAt: now,
          sceneId: 'scene-1',
          lastActionIndex: 3,
          cueUser: {
            fromAgentId: 'default-1',
            prompt: 'Choose an example.',
            options: [
              { label: 'Show an example' },
              { label: 'Back to the lesson', action: 'end_discussion' },
            ],
            parkedAt: now,
          },
          directorState: { turnCount: 2, agentResponses: [], whiteboardLedger: [] },
        };
        await saveChatSessions(stageId, [input], { store, learnerKey });
        const loaded = normalizeStoredSessionsForRestore(
          await loadChatSessions(stageId, { store, learnerKey }),
        );
        expect(loaded).toEqual([input]);
        const runtime = await store.listSessions(stageId, learnerKey);
        const records = await store.listRecords(runtime[0]!.id);
        expect(records.at(-1)?.payload).toMatchObject({
          status: 'waiting-user',
          cueUser: input.cueUser,
          directorState: input.directorState,
        });
        const recordCount = records.length;
        await saveChatSessions(stageId, loaded, { store, learnerKey });
        expect(await store.listRecords(runtime[0]!.id)).toHaveLength(recordCount);
        expect(paths.every((path) => path.startsWith('/api/persistence/'))).toBe(true);
      });

      it('keeps saving a growing many-turn Q&A and the sessions after it', async () => {
        const laterSession = qaSession('later-qa', 1);
        for (let turn = 1; turn <= 70; turn += 1) {
          const growingSession = qaSession('long-qa', turn);
          await saveChatSessions(stageId, [growingSession, laterSession], { store, learnerKey });
          const loaded = await loadChatSessions(stageId, { store, learnerKey });
          expect(loaded.find((session) => session.id === growingSession.id)).toEqual(
            growingSession,
          );
        }

        const growingSession = qaSession('long-qa', 71);
        const laterUpdate = qaSession('later-qa', 2);
        expect(
          new TextEncoder().encode(JSON.stringify(growingSession.directorState)).byteLength,
        ).toBeGreaterThan(64 * 1024);
        await saveChatSessions(stageId, [growingSession, laterUpdate], { store, learnerKey });
        const loaded = await loadChatSessions(stageId, { store, learnerKey });
        expect(loaded.find((session) => session.id === growingSession.id)).toEqual(growingSession);
        expect(loaded.find((session) => session.id === laterUpdate.id)).toEqual(laterUpdate);
      }, 30_000);

      it('loads a previously persisted large snapshot with its recent history and director context', async () => {
        await saveChatSessions(stageId, [qaSession('preexisting-qa', 1)], { store, learnerKey });
        const snapshot = qaSession('preexisting-qa', 300);
        const { directorState: _director, ...withoutDirector } = snapshot;
        await saveChatSessions(stageId, [withoutDirector], { store, learnerKey });
        const [runtime] = await store.listSessions(stageId, learnerKey);
        const stateRecord = (await store.listRecords(runtime!.id)).at(-1)!;
        const persistedRecord = {
          ...stateRecord,
          payload: { ...stateRecord.payload, directorState: snapshot.directorState },
        };
        // Seed a snapshot written before director bounds existed, bypassing the write validator.
        await pool.query(
          'UPDATE runtime_records SET data = $1::jsonb WHERE session_id = $2 AND seq = $3',
          [JSON.stringify(persistedRecord), runtime!.id, stateRecord.seq],
        );

        expect(
          new TextEncoder().encode(JSON.stringify(snapshot.directorState)).byteLength,
        ).toBeGreaterThan(64 * 1024);
        const [loaded] = await loadChatSessions(stageId, { store, learnerKey });
        expect(loaded).toEqual(snapshot);
        expect(loaded?.messages.at(-1)).toEqual(snapshot.messages.at(-1));
        expect(loaded?.directorState?.agentResponses).toHaveLength(300);
      });
    },
  );
}
