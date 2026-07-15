import { BrowserKVStore, type KVStore, type RuntimeStore } from '@openmaic/storage';
import type { RuntimeRecord } from '@openmaic/dsl';
import { isEqual } from 'lodash';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import type { Scene } from '@/lib/types/stage';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { drainProjectRuntimeFully, ensurePBLRuntimeSession } from './drain';
import { foldPBLRuntime, type PBLFoldDiagnostics } from './fold';
import {
  applyLearnerState,
  extractLearnerState,
  stripToDesignTemplate,
  type PBLLearnerState,
} from './learner-state';
import { pblSnapshotRecordPayload, type PBLRuntimeStorePayload } from './record-payloads';
import { clone } from './clone';

let defaultKv: KVStore | undefined;
const inFlightPblRuntimeTransactions = new WeakMap<RuntimeStore, Map<string, Promise<unknown>>>();

export interface HydratePBLProjectArgs {
  stageId: string;
  sceneId: string;
  project: PBLProjectV2;
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
}

export interface HydratePBLProjectResult {
  project: PBLProjectV2;
  source: 'fold' | 'document';
  diagnostics: PBLFoldDiagnostics;
  diff: string[];
  selfHealed: boolean;
}

function getDefaultKv(): KVStore {
  return (defaultKv ??= new BrowserKVStore());
}

async function withPBLRuntimeTransaction<T>(
  store: RuntimeStore,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  let storeTransactions = inFlightPblRuntimeTransactions.get(store);
  if (!storeTransactions) {
    storeTransactions = new Map();
    inFlightPblRuntimeTransactions.set(store, storeTransactions);
  }
  const previous = storeTransactions.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  storeTransactions.set(key, current);
  try {
    return await current;
  } finally {
    if (storeTransactions.get(key) === current) {
      storeTransactions.delete(key);
    }
  }
}

function shortValue(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function diffLearnerState(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 8) return out;
  if (isEqual(a, b)) return out;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    out.push(`${path || '<root>'}: ${shortValue(a)} != ${shortValue(b)}`);
    return out;
  }
  const aObject = a as Record<string, unknown>;
  const bObject = b as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(aObject), ...Object.keys(bObject)])).sort();
  for (const key of keys) {
    diffLearnerState(aObject[key], bObject[key], path ? `${path}.${key}` : key, out);
    if (out.length >= 8) break;
  }
  return out;
}

async function activePBLSessionId(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<string | undefined> {
  const sessions = await store.listSessions(stageId, learnerKey);
  return sessions.find((session) => session.kind === 'pbl' && session.status === 'active')?.id;
}

async function listPBLRecords(args: {
  store: RuntimeStore;
  stageId: string;
  sceneId: string;
  learnerKey: string;
}): Promise<RuntimeRecord[]> {
  const sessionId = await activePBLSessionId(args.store, args.stageId, args.learnerKey);
  if (!sessionId) return [];
  return args.store.listRecords(sessionId, { sceneId: args.sceneId });
}

export async function appendPBLRuntimeSnapshotIfChanged(args: {
  store: RuntimeStore;
  stageId: string;
  sceneId: string;
  learnerKey: string;
  project: PBLProjectV2;
  learnerState: PBLLearnerState;
  records: readonly RuntimeRecord[];
  reason: 'backfill' | 'self_heal' | 'write_cutover';
}): Promise<boolean> {
  const epoch = args.learnerState.runtimeResetEpoch ?? 0;
  const latestPayload = args.records.at(-1)?.payload as Partial<PBLRuntimeStorePayload> | undefined;
  if (
    latestPayload?.kind === 'pbl_snapshot' &&
    latestPayload.epoch === epoch &&
    isEqual(latestPayload.learnerState, args.learnerState) &&
    (args.reason !== 'write_cutover' || latestPayload.reason === 'write_cutover')
  ) {
    return false;
  }

  const sessionId = await ensurePBLRuntimeSession(args.store, args.stageId, args.learnerKey);
  const now = new Date().toISOString();
  await args.store.appendRecord({
    id: `pbl-snapshot-${args.sceneId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sessionId,
    sceneId: args.sceneId,
    createdAt: now,
    payload: pblSnapshotRecordPayload({
      epoch: args.learnerState.runtimeResetEpoch ?? 0,
      learnerState: args.learnerState,
      anchor: {
        lastRuntimeEventId: args.project.runtimeEvents?.at(-1)?.id,
        lastEngagementEventId: args.project.engagementEvents.at(-1)?.id,
      },
      reason: args.reason,
    }),
  });
  return true;
}

function preserveDocumentTransients(
  hydrated: PBLProjectV2,
  documentProject: PBLProjectV2,
): PBLProjectV2 {
  return {
    ...hydrated,
    runtimeEvents: documentProject.runtimeEvents ? clone(documentProject.runtimeEvents) : undefined,
    pendingOpenTaskPriorQuizResults: documentProject.pendingOpenTaskPriorQuizResults
      ? clone(documentProject.pendingOpenTaskPriorQuizResults)
      : undefined,
  };
}

function documentContainsLearnerState(project: PBLProjectV2): boolean {
  const baseline = stripToDesignTemplate(project);
  return !isEqual(extractLearnerState(project), extractLearnerState(baseline));
}

function hasWriteCutoverSnapshot(records: readonly RuntimeRecord[]): boolean {
  return records.some((record) => {
    const payload = record.payload as Partial<PBLRuntimeStorePayload>;
    return payload.kind === 'pbl_snapshot' && payload.reason === 'write_cutover';
  });
}

export async function synchronizePBLProjectRuntime(args: HydratePBLProjectArgs): Promise<void> {
  const kv = args.kv ?? getDefaultKv();
  const learnerKey = args.learnerKey ?? (await getLearnerKey(kv));
  const store = args.store ?? getRuntimeStore();
  const transactionKey = `${args.stageId}:${args.sceneId}:${learnerKey}`;

  await withPBLRuntimeTransaction(store, transactionKey, async () => {
    await drainProjectRuntimeFully({
      stageId: args.stageId,
      sceneId: args.sceneId,
      project: args.project,
      store,
      kv,
      learnerKey,
    });

    const records = await listPBLRecords({
      store,
      stageId: args.stageId,
      sceneId: args.sceneId,
      learnerKey,
    });
    const learnerState = extractLearnerState(args.project);
    const folded = foldPBLRuntime({
      designTemplate: stripToDesignTemplate(args.project),
      records,
    });
    const runtimeIsCurrent =
      isEqual(folded.learnerState, learnerState) && folded.diagnostics.gaps.length === 0;
    const cutoverStarted = hasWriteCutoverSnapshot(records);
    if (runtimeIsCurrent && cutoverStarted) return;

    await appendPBLRuntimeSnapshotIfChanged({
      store,
      stageId: args.stageId,
      sceneId: args.sceneId,
      learnerKey,
      project: args.project,
      learnerState,
      records,
      reason: cutoverStarted ? 'self_heal' : 'write_cutover',
    });
  });
}

export async function hydratePBLProjectFromRuntime(
  args: HydratePBLProjectArgs,
): Promise<HydratePBLProjectResult> {
  const kv = args.kv ?? getDefaultKv();
  const learnerKey = args.learnerKey ?? (await getLearnerKey(kv));
  const store = args.store ?? getRuntimeStore();
  const transactionKey = `${args.stageId}:${args.sceneId}:${learnerKey}`;

  return withPBLRuntimeTransaction(store, transactionKey, async () => {
    await drainProjectRuntimeFully({
      stageId: args.stageId,
      sceneId: args.sceneId,
      project: args.project,
      store,
      kv,
      learnerKey,
    });

    const records = await listPBLRecords({
      store,
      stageId: args.stageId,
      sceneId: args.sceneId,
      learnerKey,
    });
    const designTemplate = stripToDesignTemplate(args.project);
    const folded = foldPBLRuntime({ designTemplate, records });
    const documentState = extractLearnerState(args.project);
    const stateMatchesDocument = isEqual(folded.learnerState, documentState);
    const matchesDocument = stateMatchesDocument && folded.diagnostics.gaps.length === 0;

    if (matchesDocument) {
      return {
        project: preserveDocumentTransients(
          applyLearnerState(designTemplate, folded.learnerState),
          args.project,
        ),
        source: 'fold' as const,
        diagnostics: folded.diagnostics,
        diff: [],
        selfHealed: false,
      };
    }

    const diff = diffLearnerState(folded.learnerState, documentState);
    const hasDocumentLearnerState = documentContainsLearnerState(args.project);
    const cutoverStarted = hasWriteCutoverSnapshot(records);

    if (hasDocumentLearnerState && !cutoverStarted && process.env.NODE_ENV !== 'production') {
      console.warn('[PBL runtime] document state remained authoritative during hydration', {
        stageId: args.stageId,
        sceneId: args.sceneId,
        diff,
        gaps: folded.diagnostics.gaps.slice(0, 8),
      });
    }

    if (hasDocumentLearnerState && !cutoverStarted) {
      const selfHealed = await appendPBLRuntimeSnapshotIfChanged({
        store,
        stageId: args.stageId,
        sceneId: args.sceneId,
        learnerKey,
        project: args.project,
        learnerState: documentState,
        records,
        reason: records.length === 0 ? 'backfill' : 'self_heal',
      });

      return {
        project: args.project,
        source: 'document' as const,
        diagnostics: folded.diagnostics,
        diff,
        selfHealed,
      };
    }

    return {
      project: preserveDocumentTransients(
        applyLearnerState(designTemplate, folded.learnerState),
        args.project,
      ),
      source: 'fold' as const,
      diagnostics: folded.diagnostics,
      diff,
      selfHealed: false,
    };
  });
}

export async function hydratePBLScenesFromRuntime(
  stageId: string,
  scenes: readonly Scene[],
  options: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey'> = {},
): Promise<Scene[]> {
  return Promise.all(
    scenes.map(async (scene) => {
      const content = scene.content;
      if (content.type !== 'pbl' || !content.projectV2) {
        return scene;
      }
      try {
        const result = await hydratePBLProjectFromRuntime({
          stageId,
          sceneId: scene.id,
          project: content.projectV2,
          store: options.store,
          kv: options.kv,
          learnerKey: options.learnerKey,
        });
        return {
          ...scene,
          content: {
            ...content,
            projectV2: result.project,
          },
        } as Scene;
      } catch (error) {
        if (!documentContainsLearnerState(content.projectV2)) {
          throw error;
        }
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            '[PBL runtime] failed to hydrate legacy scene from runtime; using embedded document state',
            {
              stageId,
              sceneId: scene.id,
              error,
            },
          );
        }
        return scene;
      }
    }),
  );
}
