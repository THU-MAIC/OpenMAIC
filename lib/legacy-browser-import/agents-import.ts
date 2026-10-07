/**
 * The one-time import of the custom agents an earlier build kept in this
 * browser's agent registry (`agent-registry-storage` in localStorage) to
 * `POST /api/agents/import`. The registry now lives on the server
 * (`lib/server/agents`), built-in agents in code.
 *
 * TEMPORARY, like the rest of this directory: see ./README.md.
 *
 * Bound like the other imports: the ledger's browser id is bound first
 * (`POST /api/identity/legacy-import-binding`), and the import request carries
 * it in `X-OpenMAIC-Legacy-Import`, so owner resolution refuses it (409
 * `LEGACY_IMPORT_NOT_BOUND`) for any owner that does not hold the browser.
 * The ledger records each agent the server settled (took, or already had) in
 * `agentsSettled`, and a later run sends only the others: an agent the user
 * deleted on the server after it arrived is never created again. The import
 * is recorded as done (`agents: 'done'`) once every agent is settled; an agent
 * the server skipped (the owner's limit, a record it refuses) keeps it open
 * for later loads. The agents go in batches that fit the route's limits. The
 * legacy key itself is never written or removed, and Clear Local Cache keeps
 * it until the ledger records the import.
 *
 * Runs are serialized across tabs with the Web Lock `AGENTS_IMPORT_LOCK_NAME`,
 * and the settled ids are read and recorded under it. A tab that finds the
 * lock taken leaves the import to that tab. Without Web Locks the tabs are not
 * serialized: two tabs can then still both send an agent, and one the user
 * deleted in between can be created again.
 */
import { isBuiltInAgentId } from '@/lib/orchestration/registry/built-in';
import {
  customAgentFields,
  MAX_IMPORT_BATCH_AGENTS,
  MAX_IMPORT_BODY_BYTES,
} from '@/lib/orchestration/registry/schema';

import { ensureLedger, loadLedger, saveLedger } from './ledger';
import { defaultLocks, withImportLock } from './lock';
import { defaultStorage, errorCategory, LOG_PREFIX } from './model-settings';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from './protocol';

/** Where the old agent registry persisted itself (its zustand `persist` name). */
export const LEGACY_AGENT_REGISTRY_KEY = 'agent-registry-storage';

export const AGENTS_IMPORT_ENDPOINT = '/api/agents/import';

/** The Web Lock that serializes agents import runs across tabs. */
export const AGENTS_IMPORT_LOCK_NAME = 'openmaic:legacy-agents-import';

export type AgentsImportOutcome =
  /** Nothing to import, or this browser's agents were imported before. */
  | 'none'
  /** Every agent is on the server now; recorded in the ledger. */
  | 'imported'
  /**
   * The server took some agents and skipped others (`pending`, with the
   * reason): the import stays open and a later load sends them again.
   */
  | 'partial'
  /** Not now: not bound to this owner, a refusal, a server or network error. */
  | 'kept';

/** An agent still waiting to reach the server, and why. */
export interface PendingLegacyAgent {
  id: string;
  reason: string;
}

export interface AgentsImportResult {
  outcome: AgentsImportOutcome;
  /** How many agents this run added to the owner's. */
  imported: number;
  /** What is still waiting (every agent, for `kept`). */
  pending: PendingLegacyAgent[];
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type ImportStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * An earlier build's record with its empty optional fields left out: a voice
 * without a provider or voice id, an empty model id, a voice design missing a
 * part. Anything else is sent as it was, for the server to check.
 */
function withoutEmptyOptionalFields(fields: Record<string, unknown>): Record<string, unknown> {
  const filled = (value: unknown) => typeof value === 'string' && value !== '';
  const result = { ...fields };
  const voice = result.voiceConfig as Record<string, unknown> | undefined;
  if (voice) {
    if (!filled(voice.providerId) || !filled(voice.voiceId)) delete result.voiceConfig;
    else if (!filled(voice.modelId)) {
      const { modelId: _empty, ...rest } = voice;
      result.voiceConfig = rest;
    }
  }
  const design = result.voiceDesign as Record<string, unknown> | undefined;
  if (design && !['identity', 'texture', 'delivery'].every((part) => filled(design[part]))) {
    delete result.voiceDesign;
  }
  return result;
}

/**
 * The custom agents the old registry persisted, as stored fields (built-in
 * and generated agents were never the registry's to keep). Unvalidated: the
 * server checks each one. An unreadable key holds none.
 */
export function readLegacyCustomAgents(storage: ImportStorage): Record<string, unknown>[] {
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_AGENT_REGISTRY_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let agents: unknown;
  try {
    agents = (JSON.parse(raw) as { state?: { agents?: unknown } } | null)?.state?.agents;
  } catch {
    return [];
  }
  if (!agents || typeof agents !== 'object') return [];
  const custom: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(agents as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const agent = value as Record<string, unknown>;
    const id = typeof agent.id === 'string' ? agent.id : key;
    if (isBuiltInAgentId(id) || agent.isGenerated === true) continue;
    custom.push({ ...withoutEmptyOptionalFields(customAgentFields(agent)), id });
  }
  return custom;
}

/** Whether the ledger records this browser's custom agents as imported. */
export function legacyAgentImportIsComplete(storage: Pick<Storage, 'getItem'>): boolean {
  return loadLedger(storage as Storage)?.agents === 'done';
}

/** Whether the requesting owner holds this browser's binding (false on any failure). */
async function bind(fetchImpl: Fetch, browserId: string): Promise<boolean> {
  try {
    // No fence header: this is the request that creates the binding.
    const response = await fetchImpl(BINDING_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ browserId }),
    });
    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} Could not bind this browser for the agents import (HTTP ${response.status}); retrying on a later load`,
      );
      return false;
    }
    const body = (await response.json()) as { bound?: unknown };
    if (body.bound !== true) {
      console.warn(
        `${LOG_PREFIX} This browser's custom agents belong to another owner; they are not imported here`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not bind this browser for the agents import (${errorCategory(error)}); retrying on a later load`,
    );
    return false;
  }
}

/** Record `ids` as settled, and the import as done once `allIds` all are. */
function recordSettled(storage: ImportStorage, ids: readonly string[], allIds: readonly string[]) {
  const ledger = ensureLedger(storage as Storage);
  const settled = new Set([...(ledger.agentsSettled ?? []), ...ids]);
  ledger.agentsSettled = [...settled];
  if (allIds.every((id) => settled.has(id))) ledger.agents = 'done';
  saveLedger(storage as Storage, ledger);
}

const encoder = new TextEncoder();

/**
 * `agents` in request bodies the import route accepts: at most
 * `MAX_IMPORT_BATCH_AGENTS` each, under `MAX_IMPORT_BODY_BYTES`. An agent too
 * large to send on its own is returned apart (the server would refuse it).
 */
export function importBatches(agents: readonly Record<string, unknown>[]): {
  batches: Record<string, unknown>[][];
  tooLarge: Record<string, unknown>[];
} {
  const envelope = encoder.encode('{"agents":[]}').length;
  const batches: Record<string, unknown>[][] = [];
  const tooLarge: Record<string, unknown>[] = [];
  let batch: Record<string, unknown>[] = [];
  let bytes = envelope;
  for (const agent of agents) {
    const size = encoder.encode(JSON.stringify(agent)).length + 1;
    if (envelope + size > MAX_IMPORT_BODY_BYTES) {
      tooLarge.push(agent);
      continue;
    }
    if (batch.length === MAX_IMPORT_BATCH_AGENTS || bytes + size > MAX_IMPORT_BODY_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = envelope;
    }
    batch.push(agent);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return { batches, tooLarge };
}

/** Server skip reasons that settle an agent: it is there, or never the owner's to import. */
const SETTLED = new Set(['exists', 'built-in']);

const NONE: AgentsImportResult = { outcome: 'none', imported: 0, pending: [] };

/**
 * Send this browser's custom agents to the owner it is bound to. The import is
 * recorded in the ledger once nothing is pending; until then every load sends
 * the agents again (the server skips the ones it already has).
 */
export async function runAgentsImport(
  options: {
    fetch?: Fetch;
    storage?: ImportStorage | null;
    /** `navigator.locks` by default; `null` runs without cross-tab locking. */
    locks?: LockManager | null;
  } = {},
): Promise<AgentsImportResult> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return NONE;
  if (legacyAgentImportIsComplete(storage)) return NONE;
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  // One tab at a time: what is settled is read, and recorded, under the lock,
  // so a tab cannot send an agent another tab imported and the user then
  // deleted. Without Web Locks, tabs are not serialized and that race remains.
  const outcome = await withImportLock(AGENTS_IMPORT_LOCK_NAME, locks, () =>
    runAgentsImportLocked(storage, options.fetch),
  );
  if (outcome !== 'busy-elsewhere') return outcome;
  return {
    outcome: 'kept',
    imported: 0,
    pending: readLegacyCustomAgents(storage).map((agent) => ({
      id: String(agent.id),
      reason: 'importing in another tab',
    })),
  };
}

async function runAgentsImportLocked(
  storage: ImportStorage,
  fetchOption: Fetch | undefined,
): Promise<AgentsImportResult> {
  // Read again under the lock: another tab may have finished meanwhile.
  if (legacyAgentImportIsComplete(storage)) return NONE;
  const all = readLegacyCustomAgents(storage);
  // No ledger is created for a browser that has nothing to import.
  if (all.length === 0) return NONE;
  const allIds = all.map((agent) => String(agent.id));
  const alreadySettled = new Set(loadLedger(storage as Storage)?.agentsSettled ?? []);
  const unresolved = all.filter((agent) => !alreadySettled.has(String(agent.id)));
  const waiting = (agents: readonly Record<string, unknown>[], reason: string) =>
    agents.map((agent) => ({ id: String(agent.id), reason }));

  let browserId: string;
  try {
    browserId = ensureLedger(storage as Storage).browserId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} No browser id for the agents import (${errorCategory(error)}); retrying on a later load`,
    );
    return { outcome: 'kept', imported: 0, pending: waiting(unresolved, 'no browser id') };
  }
  if (unresolved.length === 0) {
    // Every agent settled on earlier runs whose completion was not recorded.
    recordSettled(storage, [], allIds);
    return NONE;
  }

  const fetchImpl: Fetch = fetchOption ?? ((input, init) => fetch(input, init));
  if (!(await bind(fetchImpl, browserId))) {
    return {
      outcome: 'kept',
      imported: 0,
      pending: waiting(unresolved, 'not bound to this owner'),
    };
  }

  const { batches, tooLarge } = importBatches(unresolved);
  const pending: PendingLegacyAgent[] = waiting(tooLarge, 'too large');
  let imported = 0;
  for (const [index, batch] of batches.entries()) {
    const rest = () => waiting(batches.slice(index).flat(), 'not sent');
    let response: Response;
    try {
      response = await fetchImpl(AGENTS_IMPORT_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', [LEGACY_IMPORT_HEADER]: browserId },
        body: JSON.stringify({ agents: batch }),
      });
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Agents import failed (${errorCategory(error)}); retrying on a later load`,
      );
      return { outcome: 'kept', imported, pending: [...pending, ...rest()] };
    }
    let body: { imported?: unknown; skipped?: Array<{ id?: unknown; reason?: unknown }> };
    try {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = (await response.json()) as typeof body;
    } catch {
      // 409 LEGACY_IMPORT_NOT_BOUND (the owner changed since the binding), 400
      // or 413 (the agents as sent), 401, 404, 5xx, an unreadable answer: the
      // agents not settled yet stay for a later load.
      console.warn(
        `${LOG_PREFIX} Agents import answered HTTP ${response.status}; retrying on a later load`,
      );
      return { outcome: 'kept', imported, pending: [...pending, ...rest()] };
    }
    const took = (Array.isArray(body.imported) ? body.imported : []).filter(
      (id): id is string => typeof id === 'string',
    );
    imported += took.length;
    const settled = [...took];
    for (const { id, reason } of Array.isArray(body.skipped) ? body.skipped : []) {
      if (typeof id !== 'string') continue;
      if (SETTLED.has(String(reason))) settled.push(id);
      else pending.push({ id, reason: String(reason) });
    }
    try {
      recordSettled(storage, settled, allIds);
    } catch (error) {
      // A later run sends these again; the server keeps what it has.
      console.warn(`${LOG_PREFIX} Could not record the agents import (${errorCategory(error)})`);
    }
  }

  if (pending.length > 0) {
    console.warn(
      `${LOG_PREFIX} Custom agents not imported yet: ${pending
        .map(({ id, reason }) => `${id || '?'} (${reason})`)
        .join(', ')}; retrying on a later load`,
    );
    return { outcome: 'partial', imported, pending };
  }
  return { outcome: 'imported', imported, pending: [] };
}
