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
 * server has answered it (or refused it for good), independently of the course
 * import's ledger state. Only what the server confirmed it holds leaves the
 * browser (imported, or a provider it already holds with the same settings,
 * key included: `EXISTS_SAME`): every other item it skipped is kept, with its
 * key, in
 * `./model-settings-unimported.ts` (never sent again), and Settings → Model
 * Services tells the user once.
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
import { getProviderPreset } from '@/lib/config/provider-presets';
import type { SlotCapability } from '@/lib/config/model-slots';
import type { ModelSettingsView } from '@/lib/model-settings/client';

import {
  keepUnimported,
  type UnimportedModelSetting,
  type UnimportedReason,
} from './model-settings-unimported';

import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from './protocol';

export type ModelSettingsImportOutcome =
  /** Nothing was waiting. */
  | 'none'
  /**
   * The server answered the proposal; it is gone from the browser. What the
   * server skipped is kept in the browser (see ./model-settings-unimported.ts).
   */
  | 'imported'
  /**
   * Unreadable, or refused for good (400); it is gone from the browser. What a
   * refused proposal held is kept in the browser first.
   */
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

type ItemKind = 'provider' | 'slot';

interface ImportAnswer {
  imported?: Array<{ kind?: unknown; id?: unknown }>;
  skipped?: Array<{ kind?: unknown; id?: unknown; code?: unknown; reason?: unknown }>;
  view?: ModelSettingsView;
}

/**
 * Skips that leave nothing behind: the workspace already holds the item (for
 * a provider, only when the server compared it and found the same settings,
 * key included: `EXISTS_DIFFERENT` keeps the browser's copy), or the
 * deployment locks the slot.
 */
const SETTLED_SKIPS: Record<ItemKind, ReadonlySet<string>> = {
  provider: new Set(['EXISTS_SAME']),
  slot: new Set(['EXISTS', 'SLOT_LOCKED']),
};

/** Provider ids and slot ids are separate namespaces. */
const itemKey = (kind: ItemKind, id: string) => `${kind}:${id}`;

function answerItemKey(entry: { kind?: unknown; id?: unknown } | null | undefined) {
  if (!entry || typeof entry.id !== 'string') return undefined;
  if (entry.kind !== 'provider' && entry.kind !== 'slot') return undefined;
  return itemKey(entry.kind, entry.id);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The items of a proposal the answer does not show as held by the workspace,
 * as they were proposed (keys included). An answer that cannot be read
 * confirms nothing, and neither does one that contradicts itself about an
 * item (imported and skipped, or skipped with different codes): that item is
 * kept as unconfirmed.
 */
export function unimportedItems(
  proposal: ModelSettingsProposal,
  answer: ImportAnswer | undefined,
): UnimportedModelSetting[] {
  const imported = new Set<string>();
  for (const entry of Array.isArray(answer?.imported) ? answer.imported : []) {
    const key = answerItemKey(entry);
    if (key) imported.add(key);
  }
  const skipped = new Map<string, { code: string; reason?: string }>();
  const contradicted = new Set<string>();
  for (const entry of Array.isArray(answer?.skipped) ? answer.skipped : []) {
    const key = answerItemKey(entry);
    if (!key) continue;
    const code = typeof entry.code === 'string' ? entry.code : '';
    if (imported.has(key) || (skipped.has(key) && skipped.get(key)!.code !== code)) {
      contradicted.add(key);
    }
    skipped.set(key, {
      code,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    });
  }
  for (const key of contradicted) {
    imported.delete(key);
    skipped.delete(key);
  }
  const known = (Array.isArray(answer?.view?.providers) ? answer.view.providers : [])
    .filter((provider) => provider.source === 'workspace')
    .map((provider) => provider.id);
  const reasonFor = (skip: { code: string } | undefined): UnimportedReason =>
    !skip ? 'unconfirmed' : skip.code === 'PROVIDER_RESERVED' ? 'reserved' : 'refused';

  const items: UnimportedModelSetting[] = [];
  const providers = isRecord(proposal.providers) ? proposal.providers : {};
  for (const [id, provider] of Object.entries(providers)) {
    if (imported.has(itemKey('provider', id))) continue;
    const skip = skipped.get(itemKey('provider', id));
    if (skip && SETTLED_SKIPS.provider.has(skip.code)) continue;
    const preset =
      provider && typeof provider === 'object' ? getProviderPreset(provider.preset) : undefined;
    items.push({
      id,
      kind: 'provider',
      ...(preset ? { capability: Object.keys(preset.capabilities)[0] as SlotCapability } : {}),
      name: preset?.name ?? id,
      ...(provider?.preset ? { preset: provider.preset } : {}),
      reason: reasonFor(skip),
      ...(skip?.reason ? { detail: skip.reason } : {}),
      knownProviders: known,
      settings: { ...provider },
    });
  }
  const slots = isRecord(proposal.slots) ? proposal.slots : {};
  for (const [slot, assignment] of Object.entries(slots)) {
    if (imported.has(itemKey('slot', slot))) continue;
    const skip = skipped.get(itemKey('slot', slot));
    if (skip && SETTLED_SKIPS.slot.has(skip.code)) continue;
    items.push({
      id: slot,
      kind: 'slot',
      name: slot,
      reason: reasonFor(skip),
      ...(skip?.reason ? { detail: skip.reason } : {}),
      settings: { preset: '', assignment },
    });
  }
  return items;
}

/**
 * Post a waiting proposal to the owner this browser is bound to. On a 2xx
 * answer the proposal is removed from the browser, and with it every key the
 * server now holds; what it did not take is kept in the browser first
 * (`./model-settings-unimported.ts`), never to be sent again. A 400 refuses
 * the whole proposal, so sending it again cannot succeed: every item, keys
 * included, is kept in the browser the same way (as refused) before the
 * proposal is removed. An unreadable proposal is dropped. Anything else (a
 * conflict, 401, 404, a 5xx, a network error) keeps the proposal for a later
 * load.
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
    let answer: ImportAnswer | undefined;
    let view: ModelSettingsView | undefined;
    try {
      const body = (await response.json()) as ImportAnswer;
      if (body && typeof body === 'object') answer = body;
      if (body?.view && typeof body.view === 'object' && Array.isArray(body.view.slots)) {
        view = body.view;
      }
    } catch {
      // Unreadable: nothing is confirmed, so everything is kept below.
    }
    const unimported = unimportedItems(proposal, answer);
    // The keys the server did not take leave the proposal only once they are
    // kept elsewhere; otherwise the proposal stays and a later load answers
    // it again (the server finds what it took already there).
    if (!keepUnimported(unimported, storage)) return 'kept';
    storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);
    if (unimported.length) {
      // Item ids only: a reason may repeat what was submitted.
      console.warn(
        `${LOG_PREFIX} Model settings not imported (kept in this browser): ${unimported
          .map((item) => `${item.kind} ${item.id}`)
          .join(', ')}`,
      );
    }
    if (view) await options.onImported?.(view);
    return 'imported';
  }
  if (response.status === 400) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } } | null;
      if (typeof body?.error?.message === 'string') detail = body.error.message;
    } catch {
      // No reason given.
    }
    const refused = unimportedItems(proposal, undefined).map(
      (item): UnimportedModelSetting => ({
        ...item,
        reason: 'refused',
        ...(detail ? { detail } : {}),
      }),
    );
    // As above: the proposal goes only once what it holds is kept elsewhere.
    if (!keepUnimported(refused, storage)) return 'kept';
    storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);
    console.warn(
      `${LOG_PREFIX} The server refused the model settings; they are kept in this browser`,
    );
    return 'dropped';
  }
  // 409 LEGACY_IMPORT_NOT_BOUND (the owner changed since the binding), a
  // conflict, 404, 401, 5xx: the proposal stays for a later load.
  console.warn(
    `${LOG_PREFIX} Model settings import answered HTTP ${response.status}; retrying on a later load`,
  );
  return 'kept';
}
