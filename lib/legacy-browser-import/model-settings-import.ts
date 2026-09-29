/**
 * The one-time import of the model settings an earlier build kept in this
 * browser: posts the proposal the settings store's migration set aside
 * (`./model-settings.ts`) to `POST /api/model-config/import`.
 *
 * TEMPORARY, like the rest of this directory: see ./README.md.
 *
 * The proposal holds this browser's keys, which belong to whoever used the
 * browser, so it goes only to the owner the browser is bound to, exactly like
 * the course import: the browser id from the importer's ledger is bound first
 * (`POST /api/identity/legacy-import-binding`), and the import request carries
 * it in `X-OpenMAIC-Legacy-Import`, so owner resolution refuses it (409
 * `LEGACY_IMPORT_NOT_BOUND`) for any owner that does not hold the binding.
 *
 * Its completion is tracked on its own: the proposal's key is removed once the
 * server has taken it (or refused it for good), independently of the course
 * import's ledger state.
 *
 * Nothing it logs quotes the proposal or an error message that could.
 */
import { ensureLedger } from './ledger';
import {
  defaultStorage,
  errorCategory,
  LOG_PREFIX,
  MODEL_SETTINGS_IMPORT_ENDPOINT,
  MODEL_SETTINGS_IMPORT_KEY,
  readProposal,
  type ModelSettingsProposal,
  type StorageLike,
} from './model-settings';
import type { ModelSettingsView } from '@/lib/model-settings/client';

import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from './protocol';

export type ModelSettingsImportOutcome =
  /** Nothing was waiting. */
  | 'none'
  /** The server took the proposal; it is gone from the browser. */
  | 'imported'
  /** Unreadable, or refused for good (400); it is gone from the browser. */
  | 'dropped'
  /**
   * Not now: the browser is not bound to this owner (or the binding could not
   * be asked for), a conflict, a server or network error. Kept for a later load.
   */
  | 'kept';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

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
        `${LOG_PREFIX} Could not bind this browser for the model settings import (HTTP ${response.status}); retrying on a later load`,
      );
      return false;
    }
    const body = (await response.json()) as { bound?: unknown };
    if (body.bound !== true) {
      console.warn(
        `${LOG_PREFIX} This browser's model settings belong to another owner; they are not imported here`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not bind this browser for the model settings import (${errorCategory(error)}); retrying on a later load`,
    );
    return false;
  }
}

/**
 * Post a waiting proposal to the owner this browser is bound to. On a 2xx
 * answer the proposal (and with it every key) is removed from the browser; an
 * unreadable proposal or a 400 drops it, since sending it again cannot
 * succeed; anything else keeps it for a later load.
 */
export async function runModelSettingsImport(
  options: {
    fetch?: Fetch;
    storage?: StorageLike | null;
    /** Called with the settings view the import answered, when it answered one. */
    onImported?: (view: ModelSettingsView) => void | Promise<void>;
  } = {},
): Promise<ModelSettingsImportOutcome> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return 'none';
  let proposal: ModelSettingsProposal | undefined;
  try {
    proposal = readProposal(storage);
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Dropping unreadable model settings waiting for import (${errorCategory(error)})`,
    );
    storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);
    return 'dropped';
  }
  if (!proposal) return 'none';

  let browserId: string;
  try {
    browserId = ensureLedger(storage as Storage).browserId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} No browser id for the model settings import (${errorCategory(error)}); retrying on a later load`,
    );
    return 'kept';
  }

  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  if (!(await bind(fetchImpl, browserId))) return 'kept';

  let response: Response;
  try {
    response = await fetchImpl(MODEL_SETTINGS_IMPORT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', [LEGACY_IMPORT_HEADER]: browserId },
      body: JSON.stringify(proposal),
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Model settings import failed (${errorCategory(error)}); retrying on a later load`,
    );
    return 'kept';
  }

  if (response.ok) {
    storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);
    let view: ModelSettingsView | undefined;
    try {
      const body = (await response.json()) as {
        skipped?: Array<{ item?: unknown }>;
        view?: ModelSettingsView;
      };
      if (body.view && typeof body.view === 'object' && Array.isArray(body.view.slots)) {
        view = body.view;
      }
      // Item ids only: a reason may repeat what was submitted.
      const skipped = (body.skipped ?? [])
        .map(({ item }) => (typeof item === 'string' ? item : ''))
        .filter(Boolean);
      if (skipped.length) {
        console.warn(`${LOG_PREFIX} Model settings not imported: ${skipped.join(', ')}`);
      }
    } catch {
      // The answer's details are informational only.
    }
    if (view) await options.onImported?.(view);
    return 'imported';
  }
  if (response.status === 400) {
    storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);
    console.warn(`${LOG_PREFIX} The server refused the model settings; they are not imported`);
    return 'dropped';
  }
  // 409 LEGACY_IMPORT_NOT_BOUND (the owner changed since the binding), a
  // conflict, 404, 401, 5xx: the proposal stays for a later load.
  console.warn(
    `${LOG_PREFIX} Model settings import answered HTTP ${response.status}; retrying on a later load`,
  );
  return 'kept';
}
