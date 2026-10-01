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
 * The ledger records the import (`agents: 'done'`) only once every agent is
 * on the server (imported now, or already there); an agent the server skipped
 * (the owner's limit, a record it refuses) keeps the import open, and every
 * later load sends the agents again. The server keeps an agent the owner
 * already has, so a repeat changes nothing for those. The legacy key itself is
 * never written or removed, and Clear Local Cache keeps it until the ledger
 * records the import.
 */
import { isBuiltInAgentId } from '@/lib/orchestration/registry/built-in';
import { customAgentFields } from '@/lib/orchestration/registry/schema';

import { ensureLedger, loadLedger, saveLedger } from './ledger';
import { defaultStorage, errorCategory, LOG_PREFIX } from './model-settings';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from './protocol';

/** Where the old agent registry persisted itself (its zustand `persist` name). */
export const LEGACY_AGENT_REGISTRY_KEY = 'agent-registry-storage';

export const AGENTS_IMPORT_ENDPOINT = '/api/agents/import';

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

function markDone(storage: ImportStorage): void {
  const ledger = ensureLedger(storage as Storage);
  ledger.agents = 'done';
  saveLedger(storage as Storage, ledger);
}

/** Server skip reasons that settle an agent: it is there, or never the owner's to import. */
const SETTLED = new Set(['exists', 'built-in']);

/**
 * Send this browser's custom agents to the owner it is bound to. The import is
 * recorded in the ledger once nothing is pending; until then every load sends
 * the agents again (the server skips the ones it already has).
 */
export async function runAgentsImport(
  options: { fetch?: Fetch; storage?: ImportStorage | null } = {},
): Promise<AgentsImportResult> {
  const none: AgentsImportResult = { outcome: 'none', imported: 0, pending: [] };
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return none;
  if (legacyAgentImportIsComplete(storage)) return none;
  const agents = readLegacyCustomAgents(storage);
  // No ledger is created for a browser that has nothing to import.
  if (agents.length === 0) return none;
  const kept = (reason: string): AgentsImportResult => ({
    outcome: 'kept',
    imported: 0,
    pending: agents.map((agent) => ({ id: String(agent.id), reason })),
  });

  let browserId: string;
  try {
    browserId = ensureLedger(storage as Storage).browserId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} No browser id for the agents import (${errorCategory(error)}); retrying on a later load`,
    );
    return kept('no browser id');
  }

  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  if (!(await bind(fetchImpl, browserId))) return kept('not bound to this owner');

  let response: Response;
  try {
    response = await fetchImpl(AGENTS_IMPORT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', [LEGACY_IMPORT_HEADER]: browserId },
      body: JSON.stringify({ agents }),
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Agents import failed (${errorCategory(error)}); retrying on a later load`,
    );
    return kept('network error');
  }
  if (!response.ok) {
    // 409 LEGACY_IMPORT_NOT_BOUND (the owner changed since the binding), 400 or
    // 413 (the agents as sent), 401, 404, 5xx: the agents stay for a later load.
    console.warn(
      `${LOG_PREFIX} Agents import answered HTTP ${response.status}; retrying on a later load`,
    );
    return kept(`HTTP ${response.status}`);
  }

  let body: { imported?: unknown; skipped?: Array<{ id?: unknown; reason?: unknown }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return kept('unreadable answer');
  }
  const imported = Array.isArray(body.imported) ? body.imported.length : 0;
  const pending = (Array.isArray(body.skipped) ? body.skipped : [])
    .filter(({ reason }) => !SETTLED.has(String(reason)))
    .map(({ id, reason }) => ({ id: typeof id === 'string' ? id : '', reason: String(reason) }));
  if (pending.length > 0) {
    console.warn(
      `${LOG_PREFIX} Custom agents not imported yet: ${pending
        .map(({ id, reason }) => `${id || '?'} (${reason})`)
        .join(', ')}; retrying on a later load`,
    );
    return { outcome: 'partial', imported, pending };
  }
  try {
    markDone(storage);
  } catch (error) {
    // Harmless: a repeat finds the agents on the server and skips them.
    console.warn(`${LOG_PREFIX} Could not record the agents import (${errorCategory(error)})`);
  }
  return { outcome: 'imported', imported, pending: [] };
}
