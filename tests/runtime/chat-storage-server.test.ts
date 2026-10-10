import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { DSL_VERSION } from '@openmaic/dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadChatSessions, saveChatSessions } from '@/lib/utils/chat-storage';
import { normalizeStoredSessionsForRestore } from '@/components/chat/use-chat-sessions';
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

for (const backend of ['PGlite', 'PostgreSQL'] as const) {
  describe.skipIf(backend === 'PostgreSQL' && !postgresUrl)(
    `parked chat through /api/persistence (${backend})`,
    () => {
      let pool: PGlitePool | Pool;
      let store: HttpRuntimeStore;
      let stageId: string;
      const paths: string[] = [];
      beforeEach(async () => {
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
      }, 30_000);
      afterEach(async () => {
        await pool?.end();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      });

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
            options: ['Show an example', '不用，继续课程'],
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
    },
  );
}
