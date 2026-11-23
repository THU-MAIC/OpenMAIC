import 'server-only';
import { guardedServerRuntimeStore } from '@/lib/persistence/runtime-tombstone-guard';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import {
  createWhiteboardRuntimeService,
  WhiteboardRuntimeSessionInvariantError,
} from '@/lib/whiteboard/runtime/store';
import { foldWhiteboardRuntimeRecordsWithHistory } from '@/lib/whiteboard/runtime/fold';
import { PBL_WHITEBOARD_RUNTIME_KIND } from '@/lib/whiteboard/runtime/types';
import { createPBLWhiteboardTools, pblWhiteboardTail } from '@/lib/pbl/v3/whiteboard-tools';
import { stageStep } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';
import { notifyDurableAgentEvent } from '@/lib/server/agent-runtime/event-notify-bus';
import { currentMilestone } from '@/lib/pbl/v3/domain/orchestration/state';
import { projectFor } from './runtime';
import type { Study } from './store';
import { pblWhiteboardEnabled } from './whiteboard-config';

export interface StudyWhiteboardIds {
  studyId: string;
  stageId: string;
  ownerId: string;
  milestoneId: string;
  stageIndex: number;
}

const HISTORY_PAGE_LIMIT = 24;
const CACHED_BOARD_LIMIT = 128;
type ExplainBoard = NonNullable<LearningView['explainBoard']>;
type BoardHistory = Awaited<ReturnType<typeof foldWhiteboardRuntimeRecordsWithHistory>>;
interface CachedBoard {
  lastSeq: number | null;
  whiteboard: ExplainBoard['whiteboard'];
  pages: BoardHistory['pages'];
  historical: boolean;
}
// A provider replacement starts a fresh cache. Owner + classroom partitioning
// also prevents a learner claim from reusing another owner's cached contents.
const boardCaches = new WeakMap<ServerPersistenceProvider, Map<string, CachedBoard>>();

function boardCache(provider: ServerPersistenceProvider) {
  let cache = boardCaches.get(provider);
  if (!cache) {
    cache = new Map();
    boardCaches.set(provider, cache);
  }
  return cache;
}

function boardCacheKey(ids: StudyWhiteboardIds, sessionId: string) {
  return JSON.stringify([ids.ownerId, ids.stageId, sessionId]);
}

function boardSessionId(ids: StudyWhiteboardIds) {
  return `pbl-whiteboard:${ids.studyId}:${ids.milestoneId}:${ids.stageIndex}`;
}

export function studyWhiteboard(row: Study | StudyWhiteboardIds) {
  const ids: StudyWhiteboardIds =
    'studyId' in row
      ? (row as StudyWhiteboardIds)
      : {
          studyId: row.id,
          stageId: row.stage_id,
          ownerId: row.owner_id,
          milestoneId: currentMilestone(projectFor(row).definition, row.state)!.id,
          stageIndex: row.state.position.stageIndex,
        };
  const sessionId = boardSessionId(ids);
  const service = getServerPersistenceProvider(process.env.DATABASE_URL ?? '').then((provider) => ({
    provider,
    runtime: createWhiteboardRuntimeService({
      store: guardedServerRuntimeStore(provider.runtimeStore, provider.pool),
      scope: { kind: PBL_WHITEBOARD_RUNTIME_KIND, sessionId },
      resolveLearnerKey: () => ids.ownerId,
    }),
  }));
  return {
    sessionId,
    read: async () => (await service).runtime.read(ids.stageId),
    tail: async () => pblWhiteboardTail((await service).runtime, ids.stageId),
    tools: async (
      messageId: string,
      withExecution?: Parameters<typeof createPBLWhiteboardTools>[0]['withExecution'],
    ) => {
      const { provider, runtime } = await service;
      return createPBLWhiteboardTools({
        service: runtime,
        stageId: ids.stageId,
        learnerKey: ids.ownerId,
        sessionId,
        messageId,
        withExecution,
        onWrite: () => {
          boardCaches.get(provider)?.delete(boardCacheKey(ids, sessionId));
          return notifyDurableAgentEvent(provider.pool, {
            kind: 'session',
            sessionId: ids.studyId,
          });
        },
      });
    },
  };
}

async function readBoardHistory(
  provider: ServerPersistenceProvider,
  ids: StudyWhiteboardIds,
  historical: boolean,
): Promise<CachedBoard> {
  const sessionId = boardSessionId(ids);
  const store = guardedServerRuntimeStore(provider.runtimeStore, provider.pool);
  const cache = boardCache(provider);
  const key = boardCacheKey(ids, sessionId);
  // Always recheck identity/existence, even for finished boards: a deletion,
  // tombstone or owner claim must never expose a cached board.
  const session = await store.getSession(sessionId);
  if (!session || session.learnerKey !== ids.ownerId) {
    cache.delete(key);
    return { whiteboard: null, lastSeq: null, pages: [], historical };
  }
  if (
    session.id !== sessionId ||
    session.kind !== PBL_WHITEBOARD_RUNTIME_KIND ||
    session.stageId !== ids.stageId ||
    session.status !== 'active'
  ) {
    throw new WhiteboardRuntimeSessionInvariantError(`Invalid PBL board session ${sessionId}`);
  }
  const cached = cache.get(key);
  // Finished stages are immutable. Re-read once at the handoff in case the
  // last active snapshot preceded the final write. Revisiting an active stage
  // always reads its log and compares lastSeq before reusing the fold.
  if (historical && cached?.historical) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const records = await store.listRecords(sessionId);
  const lastSeq = records.at(-1)?.seq ?? null;
  let result: CachedBoard;
  if (cached && cached.lastSeq === lastSeq) {
    result = { ...cached, historical };
  } else {
    const { state, pages } = await foldWhiteboardRuntimeRecordsWithHistory(sessionId, records);
    result = {
      whiteboard: state.whiteboard,
      lastSeq: state.lastSeq,
      pages: pages.slice(-HISTORY_PAGE_LIMIT),
      historical,
    };
  }
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > CACHED_BOARD_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}

export async function studyExplainBoard(row: Study): Promise<{ explainBoard?: ExplainBoard }> {
  if (!pblWhiteboardEnabled()) return {};
  const definition = projectFor(row).definition;
  const position = row.state.position;
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const pages: NonNullable<ExplainBoard['pages']> = [];
  let whiteboard: ExplainBoard['whiteboard'] = null;
  let lastSeq: number | null = null;
  for (let milestoneIndex = 0; milestoneIndex <= position.milestoneIndex; milestoneIndex++) {
    const milestone = definition.milestones[milestoneIndex]!;
    const stageCount =
      milestoneIndex === position.milestoneIndex
        ? position.stageIndex + 1
        : milestone.stages.length;
    for (let stageIndex = 0; stageIndex < stageCount; stageIndex++) {
      const historical =
        milestoneIndex < position.milestoneIndex || stageIndex < position.stageIndex;
      const board = await readBoardHistory(
        provider,
        {
          studyId: row.id,
          stageId: row.stage_id,
          ownerId: row.owner_id,
          milestoneId: milestone.id,
          stageIndex,
        },
        historical,
      );
      const metadata = {
        milestoneIndex,
        stageIndex,
        step: stageStep(milestone.stages[stageIndex]!),
      };
      const prefix = `${milestone.id}:${stageIndex}`;
      pages.push(
        ...board.pages.map((page) => ({
          ...metadata,
          id: `${prefix}:${page.beforeClearSeq}`,
          whiteboard: page.whiteboard,
        })),
      );
      if (historical && board.whiteboard?.elements.length) {
        pages.push({ ...metadata, id: `${prefix}:final`, whiteboard: board.whiteboard });
      }
      if (!historical) ({ whiteboard, lastSeq } = board);
      if (pages.length > HISTORY_PAGE_LIMIT) pages.splice(0, pages.length - HISTORY_PAGE_LIMIT);
    }
  }
  return { explainBoard: { whiteboard, lastSeq, pages } };
}
