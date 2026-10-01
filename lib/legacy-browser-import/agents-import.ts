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
 * The ledger records the import (`agents: 'done'`) once the server took it, so
 * it runs once per browser; the server keeps an agent the owner already has,
 * so a repeat changes nothing either. The legacy key itself is never written
 * or removed.
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
  /** The server took the agents (some may have been skipped, see the log). */
  | 'imported'
  /** Refused for good (400); recorded, so it is not sent again. */
  | 'dropped'
  /** Not now: not bound to this owner, a conflict, a server or network error. */
  | 'kept';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type ImportStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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
    custom.push({ ...customAgentFields(agent), id });
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

/**
 * Send this browser's custom agents to the owner it is bound to, once. A 2xx
 * answer (or a 400: sending the same agents again cannot succeed) records the
 * import in the ledger; anything else leaves it for a later load.
 */
export async function runAgentsImport(
  options: { fetch?: Fetch; storage?: ImportStorage | null } = {},
): Promise<AgentsImportOutcome> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return 'none';
  if (legacyAgentImportIsComplete(storage)) return 'none';
  const agents = readLegacyCustomAgents(storage);
  // No ledger is created for a browser that has nothing to import.
  if (agents.length === 0) return 'none';

  let browserId: string;
  try {
    browserId = ensureLedger(storage as Storage).browserId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} No browser id for the agents import (${errorCategory(error)}); retrying on a later load`,
    );
    return 'kept';
  }

  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  if (!(await bind(fetchImpl, browserId))) return 'kept';

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
    return 'kept';
  }

  if (response.ok || response.status === 400) {
    try {
      markDone(storage);
    } catch (error) {
      // Harmless: a repeat finds the agents on the server and skips them.
      console.warn(`${LOG_PREFIX} Could not record the agents import (${errorCategory(error)})`);
    }
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} The server refused the custom agents; they are not imported`);
      return 'dropped';
    }
    try {
      const body = (await response.json()) as {
        skipped?: Array<{ id?: unknown; reason?: unknown }>;
      };
      const skipped = (body.skipped ?? [])
        .filter(({ reason }) => reason !== 'exists')
        .map(({ id, reason }) => `${typeof id === 'string' ? id : '?'} (${String(reason)})`);
      if (skipped.length) {
        console.warn(`${LOG_PREFIX} Custom agents not imported: ${skipped.join(', ')}`);
      }
    } catch {
      // The answer's details are informational only.
    }
    return 'imported';
  }
  // 409 LEGACY_IMPORT_NOT_BOUND (the owner changed since the binding), 401,
  // 404, 5xx: the agents stay for a later load.
  console.warn(
    `${LOG_PREFIX} Agents import answered HTTP ${response.status}; retrying on a later load`,
  );
  return 'kept';
}
