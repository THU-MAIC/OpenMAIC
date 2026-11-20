'use client';

import { useSyncExternalStore } from 'react';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { AccountVoice, BuiltInTTSProviderId } from '@/lib/audio/types';
import { voiceAccountFor } from '@/lib/audio/voice-account';
import { db } from '@/lib/device-storage/database';
import { deviceOwnerKey } from '@/lib/device-storage/owner-key';
import {
  findSlot,
  modelSettingsClient,
  type ModelSettingsView,
  type TargetView,
} from '@/lib/model-settings/client';
import { useModelSettingsView } from '@/lib/model-settings/use-model-settings';
import { useSettingsStore } from '@/lib/store/settings';

interface AccountVoiceList {
  voices: AccountVoice[];
  /** A personal catalogue that has not yet confirmed which roster voices it contains. */
  unverifiedProviderId?: string;
  canDeleteRemote: boolean;
  loading: boolean;
  error: string | null;
}

const empty: AccountVoiceList = { voices: [], canDeleteRemote: false, loading: false, error: null };
let observedLists = 0;

function ownerChanged() {
  modelSettingsClient.adopt(null);
  void modelSettingsClient.load({ fresh: true });
}

async function missingPreference(
  providerId: string,
  scope: string | undefined,
  voices: AccountVoice[],
) {
  const { ttsVoice, ttsVoiceAccount, ttsVoiceProviderId } = useSettingsStore.getState();
  if (
    !scope ||
    ttsVoiceAccount !== scope ||
    ttsVoiceProviderId !== providerId ||
    voices.some((voice) => voice.id === ttsVoice)
  )
    return;
  // A clone saved on this device may still be pending its first synthesis.
  const local = await db.voiceProfiles.get(ttsVoice).catch(() => undefined);
  if (local?.kind === 'clone' && local.providerId === providerId && local.accountScope === scope)
    return;
  return ttsVoice;
}

async function fetchAccountList(target: TargetView, revision: number, signal: AbortSignal) {
  const query = new URLSearchParams({
    providerId: target.registryId,
    expectedServiceId: target.providerId,
    expectedRevision: String(revision),
  });
  const response = await fetch(`/api/generate/voice?${query}`, { cache: 'no-store', signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    throw new Error(body.error || `HTTP ${response.status}`, { cause: response.status });
  }
  return body as Pick<AccountVoiceList, 'voices' | 'canDeleteRemote'>;
}

function createVoiceList(view?: ModelSettingsView, target?: TargetView, canList = false) {
  const initial =
    canList && target && !target.voices?.length
      ? { ...empty, unverifiedProviderId: target.registryId }
      : empty;
  let snapshot: AccountVoiceList = initial;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();

  function publish(next: AccountVoiceList) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function refresh() {
    if (!view || !target || listeners.size === 0 || modelSettingsClient.getState().view !== view)
      return;
    request?.abort();
    const controller = (request = new AbortController());
    const current = () =>
      !controller.signal.aborted && modelSettingsClient.getState().view === view;
    publish({ ...snapshot, canDeleteRemote: false, loading: true, error: null });
    try {
      const [body] = await Promise.all([
        canList
          ? fetchAccountList(target, view.revision ?? 0, controller.signal)
          : { voices: [], canDeleteRemote: false },
        deviceOwnerKey(),
      ]);
      if (!current()) return;
      const voices: AccountVoice[] = target.voices?.length ? [] : body.voices;
      const account =
        !target.voices?.length && body.canDeleteRemote ? voiceAccountFor(view) : undefined;
      if (account) {
        const missing = await missingPreference(target.registryId, account.scope, voices);
        if (!current()) return;
        account.missingVoice = missing;
      }
      publish({ voices, canDeleteRemote: body.canDeleteRemote, loading: false, error: null });
      return voices;
    } catch (error) {
      if (current()) {
        // A transient outage can leave a voice playing. A refused or changed account drops its rows.
        const status = error instanceof Error ? error.cause : undefined;
        const temporary =
          typeof status !== 'number' || status >= 500 || status === 408 || status === 429;
        publish({
          ...(temporary ? snapshot : empty),
          canDeleteRemote: false,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    refresh,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (++observedLists === 1) window.addEventListener('auth-change', ownerChanged);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (--observedLists === 0) window.removeEventListener('auth-change', ownerChanged);
          request?.abort();
          snapshot = initial;
        }
      };
    },
  };
}

const inactive = createVoiceList();
// Only mounted readers share results. A new settings view (including a key
// revision or an owner change) gets a fresh list, even for the same preset.
const lists = new WeakMap<ModelSettingsView, ReturnType<typeof createVoiceList>>();

function listFor(view: ModelSettingsView | null) {
  if (!view) return inactive;
  const tts = findSlot(view, 'tts')?.effective;
  if (
    tts?.status !== 'assigned' ||
    !TTS_PROVIDERS[tts.registryId as BuiltInTTSProviderId]?.supportsAccountVoices
  )
    return inactive;
  const key = view.providers.find((p) => p.id === tts.providerId && p.source === 'workspace')?.key;
  const canList = tts.providerSource === 'workspace' && !!key?.set && !key.unreadable;
  // A shared service needs only the identity read, and only to resolve a private preference.
  if (!canList && !useSettingsStore.getState().ttsVoiceAccount) return inactive;
  let list = lists.get(view);
  if (!list) {
    list = createVoiceList(view, tts, canList);
    lists.set(view, list);
  }
  return list;
}

/** The active workspace credential's discovered voices, shared by settings and voice pickers. */
export function useAccountVoices(enabled = true) {
  const view = useModelSettingsView();
  const list = enabled ? listFor(view) : inactive;
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot, () => empty);
  return { ...state, refresh: list.refresh };
}
