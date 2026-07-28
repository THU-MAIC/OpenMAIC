'use client';

import { BrowserDocumentStore, type MaicDocument } from '@openmaic/storage';
import { validateSceneExtended, validateStageExtended } from '@/lib/dsl-extensions/validate';
import { createLogger } from '@/lib/logger';
import { supabase } from '@/lib/supabase/client';
import type { Scene as AppScene } from '@/lib/types/stage';
import { accountNamespace, sha256Hex } from './identity';
import { getBridgeEntry, putBridgeEntry } from './ledger';
import { reportBridgeDiagnostic, reportDocumentParityDiagnostic } from './diagnostics';
import {
  DOCUMENT_BRIDGE_VERSION,
  DOCUMENT_PARITY_VERSION,
  type BridgeFailureCode,
  type LegacyDocumentSnapshot,
} from './types';

const log = createLogger('DocumentBridge');
const STALE_IN_PROGRESS_MS = 5 * 60_000;
const documentStores = new Map<string, BrowserDocumentStore<AppScene>>();
let queue: Promise<void> = Promise.resolve();

export function isDocumentBridgeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE === '1';
}

export function isDocumentParityCheckEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE === '1' &&
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK === '1'
  );
}

function storeFor(namespace: string): BrowserDocumentStore<AppScene> {
  const name = `rj-maic-documents-v1-${namespace}`;
  let store = documentStores.get(name);
  if (!store) {
    store = new BrowserDocumentStore<AppScene>({
      dbName: name,
      validateScene: validateSceneExtended,
    });
    documentStores.set(name, store);
  }
  return store;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDocument(snapshot: LegacyDocumentSnapshot) {
  return {
    stage: snapshot.stage,
    scenes: [...snapshot.scenes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    ...(snapshot.outlineRecord !== undefined ? { outlineRecord: snapshot.outlineRecord } : {}),
  };
}

async function sourceHash(snapshot: LegacyDocumentSnapshot): Promise<string> {
  return sha256Hex(stableJson(snapshot));
}

async function parityHash(snapshot: LegacyDocumentSnapshot): Promise<string> {
  return sha256Hex(stableJson(canonicalDocument(snapshot)));
}

function failureCode(error: unknown): BridgeFailureCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid (stage|scene)|validate|validation/i.test(message)) return 'validation';
  if (/quota/i.test(message)) return 'quota';
  if (/indexeddb|idb|transaction|database/i.test(message)) return 'indexeddb';
  if (/crypto|user id|authenticated/i.test(message)) return 'identity';
  return 'unknown';
}

function scheduleIdle(task: () => void): void {
  const idle = (window as Window & { requestIdleCallback?: (callback: () => void) => number })
    .requestIdleCallback;
  if (idle) {
    idle(task);
    return;
  }
  window.setTimeout(task, 250);
}

/**
 * Queue a best-effort copy after a legacy Dexie course successfully loaded.
 * This function intentionally returns immediately; the caller must never wait
 * for a DocumentStore write before showing a user's existing course.
 */
export function scheduleLegacyDocumentBridge(snapshot: LegacyDocumentSnapshot): void {
  if (!isDocumentBridgeEnabled() || typeof window === 'undefined') return;
  scheduleIdle(() => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        await bridgeLegacyDocument(snapshot);
      })
      .catch((error) => log.warn('Unexpected queued bridge failure:', error));
  });
}

/**
 * B2.2: compare the already-loaded legacy document with its isolated
 * DocumentStore copy. This is strictly observational; callers never await it.
 */
export function scheduleDocumentParityCheck(snapshot: LegacyDocumentSnapshot): void {
  if (!isDocumentParityCheckEnabled() || typeof window === 'undefined') return;
  scheduleIdle(() => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        await compareLegacyDocument(snapshot);
      })
      .catch((error) => log.warn('Unexpected queued parity failure:', error));
  });
}

export async function compareLegacyDocument(
  snapshot: LegacyDocumentSnapshot,
): Promise<'match' | 'missing_document' | 'mismatch' | 'skipped'> {
  if (!isDocumentParityCheckEnabled()) return 'skipped';
  const startedAt = performance.now();
  const courseId = snapshot.stage.id;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      reportDocumentParityDiagnostic({
        outcome: 'identity',
        durationMs: performance.now() - startedAt,
        parityVersion: DOCUMENT_PARITY_VERSION,
        courseId,
        errorCode: 'identity',
      });
      return 'skipped';
    }
    const document = await storeFor(await accountNamespace(user.id)).loadDocument(courseId);
    if (!document) {
      reportDocumentParityDiagnostic({
        outcome: 'missing_document',
        durationMs: performance.now() - startedAt,
        parityVersion: DOCUMENT_PARITY_VERSION,
        courseId,
      });
      return 'missing_document';
    }
    const [legacy, stored] = await Promise.all([
      parityHash(snapshot),
      parityHash({
        stage: document.stage as LegacyDocumentSnapshot['stage'],
        scenes: document.scenes as LegacyDocumentSnapshot['scenes'],
        ...(document.outline !== undefined
          ? { outlineRecord: document.outline as LegacyDocumentSnapshot['outlineRecord'] }
          : {}),
      }),
    ]);
    const outcome = legacy === stored ? 'match' : 'mismatch';
    reportDocumentParityDiagnostic({
      outcome,
      durationMs: performance.now() - startedAt,
      parityVersion: DOCUMENT_PARITY_VERSION,
      ...(outcome === 'mismatch' ? { courseId } : {}),
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = /crypto|user id|authenticated/i.test(message)
      ? 'identity'
      : /indexeddb|idb|transaction|database/i.test(message)
        ? 'indexeddb'
        : 'unknown';
    reportDocumentParityDiagnostic({
      outcome: errorCode === 'identity' ? 'identity' : 'read_failure',
      durationMs: performance.now() - startedAt,
      parityVersion: DOCUMENT_PARITY_VERSION,
      courseId,
      errorCode,
    });
    return 'skipped';
  }
}

export async function bridgeLegacyDocument(
  snapshot: LegacyDocumentSnapshot,
): Promise<'migrated' | 'skipped'> {
  if (!isDocumentBridgeEnabled()) return 'skipped';
  const startedAt = performance.now();
  const courseId = snapshot.stage.id;
  let namespace = '';
  let hash = '';

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 'skipped';

    namespace = await accountNamespace(user.id);
    // Clone at the background boundary. The legacy source remains untouched.
    const copied = structuredClone(snapshot);
    hash = await sourceHash(copied);
    const existing = await getBridgeEntry(namespace, courseId);
    const isSameSource =
      existing?.sourceHash === hash && existing.bridgeVersion === DOCUMENT_BRIDGE_VERSION;
    const isFreshInProgress =
      existing?.status === 'in_progress' && Date.now() - existing.updatedAt < STALE_IN_PROGRESS_MS;
    if ((existing?.status === 'migrated' || existing?.status === 'failed') && isSameSource) {
      return 'skipped';
    }
    if (isFreshInProgress && isSameSource) return 'skipped';

    await putBridgeEntry(namespace, {
      courseId,
      status: 'in_progress',
      sourceHash: hash,
      bridgeVersion: DOCUMENT_BRIDGE_VERSION,
      updatedAt: Date.now(),
    });

    const stageValidation = validateStageExtended(copied.stage);
    if (!stageValidation.valid) {
      throw new Error(
        `Invalid stage: ${stageValidation.errors.map((issue) => issue.path).join(', ')}`,
      );
    }

    const document: MaicDocument<AppScene> = {
      stage: copied.stage,
      scenes: copied.scenes,
      ...(copied.outlineRecord ? { outline: copied.outlineRecord } : {}),
    };
    await storeFor(namespace).saveDocument(document);
    await putBridgeEntry(namespace, {
      courseId,
      status: 'migrated',
      sourceHash: hash,
      bridgeVersion: DOCUMENT_BRIDGE_VERSION,
      updatedAt: Date.now(),
    });
    reportBridgeDiagnostic({
      outcome: 'success',
      durationMs: performance.now() - startedAt,
      bridgeVersion: DOCUMENT_BRIDGE_VERSION,
    });
    return 'migrated';
  } catch (error) {
    const errorCode = failureCode(error);
    log.warn('Bridge failed; keeping legacy Dexie as the active source.', {
      courseId,
      errorCode,
    });
    if (namespace && hash) {
      try {
        await putBridgeEntry(namespace, {
          courseId,
          status: 'failed',
          sourceHash: hash,
          bridgeVersion: DOCUMENT_BRIDGE_VERSION,
          updatedAt: Date.now(),
          errorCode,
        });
      } catch {
        // A broken ledger must not alter the fallback guarantee either.
      }
    }
    reportBridgeDiagnostic({
      outcome: 'failure',
      durationMs: performance.now() - startedAt,
      bridgeVersion: DOCUMENT_BRIDGE_VERSION,
      courseId,
      errorCode,
    });
    return 'skipped';
  }
}
