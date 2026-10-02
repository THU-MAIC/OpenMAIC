/**
 * The model settings of an earlier build that could not be moved to the
 * server (RFC #1701, tracked in #1725, P2).
 *
 * TEMPORARY, like the rest of this directory: see ./README.md.
 *
 * The version 5 settings migration drops the old settings once they are
 * staged, so whatever the import could not carry over would otherwise be
 * lost with its keys: a custom speech service, a key pair, a provider the
 * server refused (a custom endpoint for a media service, say). Those are kept
 * here, in this browser only, exactly as they were staged: Settings → Model
 * Services lists them once with the reason, so the user can set them up again,
 * and the user discards them. They are never sent anywhere: nothing reads this
 * key but the notice.
 */
import type { SlotCapability } from '@/lib/config/model-slots';

import {
  defaultStorage,
  errorCategory,
  LOG_PREFIX,
  type ProposedProvider,
  type StorageLike,
} from './model-settings';

/** The localStorage key of the settings that were not imported. */
export const MODEL_SETTINGS_UNIMPORTED_KEY = 'maic:legacy-import:model-settings-unimported';

export type UnimportedReason =
  /** The server refused it; `detail` says why. */
  | 'refused'
  /** The deployment declares a provider under the same id. */
  | 'reserved'
  /** A custom speech or transcription service: a workspace provider cannot express one. */
  | 'custom-service'
  /** A service that authenticates with a key pair (AliDocMind). */
  | 'key-pair'
  /** A custom chat provider of a kind the server cannot express (no endpoint, an unknown type). */
  | 'unsupported'
  /** The server's answer did not confirm it was imported. */
  | 'unconfirmed';

export interface UnimportedModelSetting {
  /** The proposal's item id (a provider or slot id), or `capability:legacyId` for one never proposed. */
  id: string;
  kind: 'provider' | 'slot';
  /** The capability it served (providers). */
  capability?: SlotCapability;
  /** The name the user knew it by. */
  name: string;
  /** The preset it was proposed as (providers that were proposed). */
  preset?: string;
  reason: UnimportedReason;
  /** The server's reason (English, from the import's answer). */
  detail?: string;
  /** The provider ids the workspace had when it was recorded: a new one of the same preset re-adds it. */
  knownProviders?: string[];
  /** What the browser kept, keys included, as staged. */
  settings: ProposedProvider & {
    accessKeyId?: string;
    accessKeySecret?: string;
    modelId?: string;
    /** A slot's assignment (`provider:model`, a provider, or null for off). */
    assignment?: string | null;
  };
}

export interface UnimportedModelSettings {
  items: UnimportedModelSetting[];
  /** Whether the user was told about the current items (the one-time toast). */
  notified?: boolean;
}

/** What is kept; empty when nothing is, or the stored text is unreadable. */
export function readUnimported(
  storage: StorageLike | null = defaultStorage(),
): UnimportedModelSettings {
  if (!storage) return { items: [] };
  try {
    const raw = storage.getItem(MODEL_SETTINGS_UNIMPORTED_KEY);
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw) as Partial<UnimportedModelSettings> | null;
    const items = Array.isArray(parsed?.items)
      ? parsed.items.filter(
          (item): item is UnimportedModelSetting =>
            !!item && typeof item === 'object' && typeof item.id === 'string',
        )
      : [];
    return { items, ...(parsed?.notified === true ? { notified: true } : {}) };
  } catch {
    return { items: [] };
  }
}

function write(storage: StorageLike, state: UnimportedModelSettings): void {
  if (!state.items.length) {
    storage.removeItem(MODEL_SETTINGS_UNIMPORTED_KEY);
    return;
  }
  storage.setItem(MODEL_SETTINGS_UNIMPORTED_KEY, JSON.stringify(state));
}

/**
 * Keep settings that were not imported, over any kept before under the same
 * id. Answers whether they are durably kept (true when there is nothing to
 * keep): callers must not drop the settings they came from otherwise. New
 * items are announced again.
 */
export function keepUnimported(
  items: readonly UnimportedModelSetting[],
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!items.length) return true;
  if (!storage) return false;
  try {
    const current = readUnimported(storage);
    const incoming = new Set(items.map((item) => item.id));
    const fresh = items.some(
      (item) => !current.items.some((kept) => kept.id === item.id && sameSettings(kept, item)),
    );
    write(storage, {
      items: [...current.items.filter((item) => !incoming.has(item.id)), ...items],
      ...(current.notified && !fresh ? { notified: true } : {}),
    });
    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not keep the model settings that were not imported (${errorCategory(error)})`,
    );
    return false;
  }
}

function sameSettings(a: UnimportedModelSetting, b: UnimportedModelSetting): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Forget kept settings by id (the user set them up again, or discarded them). */
export function forgetUnimported(
  ids: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !ids.length) return;
  try {
    const current = readUnimported(storage);
    const drop = new Set(ids);
    write(storage, { ...current, items: current.items.filter((item) => !drop.has(item.id)) });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not update the kept model settings (${errorCategory(error)})`,
    );
  }
}

/** Discard every kept setting, keys included. */
export function discardUnimported(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(MODEL_SETTINGS_UNIMPORTED_KEY);
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not discard the kept model settings (${errorCategory(error)})`,
    );
  }
}

/**
 * The kept settings, when the user has not been told about them yet; marks
 * them told. Undefined when there is nothing to tell.
 */
export function takeUnimportedNotice(
  storage: StorageLike | null = defaultStorage(),
): UnimportedModelSetting[] | undefined {
  if (!storage) return undefined;
  const current = readUnimported(storage);
  if (!current.items.length || current.notified) return undefined;
  try {
    write(storage, { ...current, notified: true });
  } catch {
    // Not marked: shown again on a later load, which is the safe side.
  }
  return current.items;
}
