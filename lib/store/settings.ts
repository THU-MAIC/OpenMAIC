/**
 * Settings Store
 *
 * The user's own preferences, persisted through the `@openmaic/storage`
 * KVStore in the `account` scope: playback, voice, speech input language,
 * agents and layout.
 *
 * Model and provider configuration is not here. It lives on the server, in
 * the workspace's model settings (`/api/model-config`, RFC #1701); the client
 * reads what it needs from there (`lib/model-settings`). Earlier builds kept
 * providers, keys and model choices in this store; the migration to version 5
 * sets them aside for a one-time import into the workspace
 * (`lib/legacy-browser-import/model-settings.ts`) and drops them.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ASRProviderId } from '@/lib/audio/types';
import type { AgentVoiceOverride } from '@/lib/audio/voice-resolver';
import { isCustomASRProvider } from '@/lib/audio/types';
import { ASR_PROVIDERS, CUSTOM_ASR_DEFAULT_LANGUAGES } from '@/lib/audio/constants';
import { createKVPersistStorage, purgeLegacyPersistKey } from '@/lib/store/kv-persist';
import {
  buildModelSettingsProposal,
  saveModelSettingsProposal,
  type LegacyModelSettingsState,
} from '@/lib/legacy-browser-import/model-settings';

/** Persisted-blob version for zustand's `persist` `migrate` ladder. */
const SETTINGS_PERSIST_VERSION = 5;

/**
 * Bound after the store exists; see `onWriteRefused` for why it is not inlined.
 * The explicit annotation is what breaks the type cycle — inferring this from
 * the store would put the store back in its own definition.
 */
const recovery: { rehydrate?: () => void | Promise<void> } = {};

/** Available playback speed tiers */
export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * Validate and resolve ASR language for a given provider.
 * Keeps current language if supported by the provider, otherwise falls back
 * to the provider's default supported language (or 'auto').
 */
export function getValidASRLanguage(providerId: ASRProviderId, currentLanguage?: string): string {
  if (!providerId || typeof providerId !== 'string') return 'auto';
  let supportedLanguages: readonly string[];
  if (isCustomASRProvider(providerId)) {
    supportedLanguages = CUSTOM_ASR_DEFAULT_LANGUAGES;
  } else {
    supportedLanguages =
      ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS]?.supportedLanguages || [];
  }
  const isLanguageValid = Boolean(
    typeof currentLanguage === 'string' &&
    currentLanguage &&
    supportedLanguages.includes(currentLanguage),
  );
  return isLanguageValid && currentLanguage ? currentLanguage : supportedLanguages[0] || 'auto';
}

export interface SettingsState {
  /**
   * The narration voice the user picked, and the speech provider (registry
   * id) it was picked for. The workspace's `tts` slot decides the provider;
   * the voice applies while the slot names the provider it belongs to, and
   * that provider's default voice applies otherwise.
   */
  ttsVoice: string;
  ttsVoiceProviderId: string;
  ttsSpeed: number;
  /** The language speech input listens for (checked against the asr slot's provider). */
  asrLanguage: string;

  /** Always open the outline review before generating scenes. */
  reviewOutlineEnabled: boolean;

  // Playback controls
  ttsMuted: boolean;
  ttsVolume: number; // 0-1, actual volume level
  autoPlayLecture: boolean;
  playbackSpeed: PlaybackSpeed;

  // Agent settings
  selectedAgentIds: string[];
  agentMode: 'preset' | 'auto';
  autoAgentCount: number;
  /**
   * Per-agent voice picks made in the AgentBar, keyed by agent id. Lives here
   * (persisted) rather than on registry AgentConfig records because default
   * agents are reset from code and generated agents are rebuilt from IndexedDB
   * on every load. Highest-priority input to resolveAgentVoice.
   */
  agentVoiceOverrides: Record<string, AgentVoiceOverride>;
  /**
   * Whether agentMode/selectedAgentIds were explicitly set by the user (in the
   * AgentBar), as opposed to stage-derived defaults written by a classroom
   * load. Only a user-set selection carries across classrooms on restore.
   */
  agentSelectionIsUserSet: boolean;

  // Layout preferences (persisted via localStorage)
  sidebarCollapsed: boolean;
  chatAreaCollapsed: boolean;
  chatAreaWidth: number;
  editRailCollapsed: boolean;
  editRailWidth: number;

  // Voice actions
  /** Pick the narration voice of a speech provider (its registry id). */
  setTTSVoice: (voice: string, providerId: string) => void;
  setTTSSpeed: (speed: number) => void;
  setASRLanguage: (language: string) => void;
  setReviewOutlineEnabled: (enabled: boolean) => void;

  // Playback actions
  setTTSMuted: (muted: boolean) => void;
  setTTSVolume: (volume: number) => void;
  setAutoPlayLecture: (autoPlay: boolean) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;

  // Agent actions
  setSelectedAgentIds: (ids: string[]) => void;
  setAgentMode: (mode: 'preset' | 'auto') => void;
  setAutoAgentCount: (count: number) => void;
  /** Set (or clear, with `undefined`) the persisted voice pick for one agent. */
  setAgentVoiceOverride: (agentId: string, voice: AgentVoiceOverride | undefined) => void;
  setAgentSelectionIsUserSet: (isUserSet: boolean) => void;

  // Layout actions
  setSidebarCollapsed: (collapsed: boolean) => void;
  setChatAreaCollapsed: (collapsed: boolean) => void;
  setChatAreaWidth: (width: number) => void;
  setEditRailCollapsed: (collapsed: boolean) => void;
  setEditRailWidth: (width: number) => void;
}

/** The persisted fields: everything but the actions. */
const PERSISTED_FIELDS = [
  'ttsVoice',
  'ttsVoiceProviderId',
  'ttsSpeed',
  'asrLanguage',
  'reviewOutlineEnabled',
  'ttsMuted',
  'ttsVolume',
  'autoPlayLecture',
  'playbackSpeed',
  'selectedAgentIds',
  'agentMode',
  'autoAgentCount',
  'agentVoiceOverrides',
  'agentSelectionIsUserSet',
  'sidebarCollapsed',
  'chatAreaCollapsed',
  'chatAreaWidth',
  'editRailCollapsed',
  'editRailWidth',
] as const satisfies readonly (keyof SettingsState)[];

export type PersistedSettings = Pick<SettingsState, (typeof PERSISTED_FIELDS)[number]>;

/** Only the known preference fields of a persisted blob. */
function pickPersisted(state: unknown): Partial<PersistedSettings> {
  const picked: Record<string, unknown> = {};
  if (!state || typeof state !== 'object') return picked;
  const record = state as Record<string, unknown>;
  for (const field of PERSISTED_FIELDS) {
    if (Object.hasOwn(record, field)) picked[field] = record[field];
  }
  return picked as Partial<PersistedSettings>;
}

/**
 * The version 5 migration of a persisted blob: model settings set aside for
 * import, the voice tied to the provider it was picked for, and every
 * provider field dropped.
 */
export function migrateSettingsToV5(state: Record<string, unknown>): Partial<PersistedSettings> {
  saveModelSettingsProposal(buildModelSettingsProposal(state as LegacyModelSettingsState));
  const next = pickPersisted(state);
  if (typeof state.ttsProviderId === 'string' && next.ttsVoiceProviderId === undefined) {
    next.ttsVoiceProviderId = state.ttsProviderId;
  }
  // Blobs from before the auto agent mode kept the preset roster.
  if (next.agentMode === undefined) next.agentMode = 'preset';
  return next;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ttsVoice: 'default',
      ttsVoiceProviderId: '',
      ttsSpeed: 1.0,
      asrLanguage: 'zh-CN',
      reviewOutlineEnabled: false,

      // Playback controls
      ttsMuted: false,
      ttsVolume: 1,
      autoPlayLecture: false,
      playbackSpeed: 1,

      // Agents
      selectedAgentIds: ['default-1', 'default-2', 'default-3'],
      agentMode: 'auto' as const,
      autoAgentCount: 3,
      agentVoiceOverrides: {},
      agentSelectionIsUserSet: false,

      // Layout preferences
      sidebarCollapsed: true,
      chatAreaCollapsed: true,
      chatAreaWidth: 320,
      editRailCollapsed: false,
      editRailWidth: 220,

      setTTSVoice: (voice, providerId) => set({ ttsVoice: voice, ttsVoiceProviderId: providerId }),
      setTTSSpeed: (speed) => set({ ttsSpeed: speed }),
      setASRLanguage: (language) => set({ asrLanguage: language }),
      setReviewOutlineEnabled: (enabled) => set({ reviewOutlineEnabled: enabled }),

      setTTSMuted: (muted) => set({ ttsMuted: muted }),
      setTTSVolume: (volume) => set({ ttsVolume: Math.max(0, Math.min(1, volume)) }),
      setAutoPlayLecture: (autoPlay) => set({ autoPlayLecture: autoPlay }),
      setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

      setSelectedAgentIds: (ids) => set({ selectedAgentIds: ids }),
      setAgentMode: (mode) => set({ agentMode: mode }),
      setAutoAgentCount: (count) => set({ autoAgentCount: count }),
      setAgentVoiceOverride: (agentId, voice) =>
        set((state) => {
          const next = { ...state.agentVoiceOverrides };
          if (voice) {
            next[agentId] = voice;
          } else {
            delete next[agentId];
          }
          return { agentVoiceOverrides: next };
        }),
      setAgentSelectionIsUserSet: (isUserSet) => set({ agentSelectionIsUserSet: isUserSet }),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setChatAreaCollapsed: (collapsed) => set({ chatAreaCollapsed: collapsed }),
      setEditRailCollapsed: (collapsed) => set({ editRailCollapsed: collapsed }),
      setEditRailWidth: (width) => set({ editRailWidth: width }),
      setChatAreaWidth: (width) => set({ chatAreaWidth: width }),
    }),
    {
      name: 'settings-storage',
      storage: createKVPersistStorage<Partial<PersistedSettings>>('account', {
        // One recovery attempt when a write is refused because hydration never
        // succeeded — the backend may have come back since. Routed through a
        // variable assigned below rather than naming the store directly: a
        // self-reference here would make the store's own type circular, and
        // every `useSettingsStore(s => ...)` selector would silently widen to
        // `any`.
        onWriteRefused: () => recovery.rehydrate?.(),
      }),
      version: SETTINGS_PERSIST_VERSION,
      partialize: (state) => pickPersisted(state),
      migrate: (persistedState: unknown, version: number) => {
        const state = { ...((persistedState as Record<string, unknown> | null) ?? {}) };
        // v4 → v5: model settings move to the server (RFC #1701).
        return version < 5 ? migrateSettingsToV5(state) : pickPersisted(state);
      },
      // Only known preference fields reach the state; anything else a blob
      // carries (fields of earlier builds) is ignored.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...pickPersisted(persistedState),
      }),
    },
  ),
);

// Bound after the store exists so the `onWriteRefused` hook above stays free of
// a self-reference (see the comment there).
recovery.rehydrate = () => useSettingsStore.persist.rehydrate();

// Best-effort, fire-and-forget: drop the pre-cutover raw `localStorage` blob.
// It is never read (this store does not migrate legacy data), and the old blob
// holds plaintext provider API keys, so clearing it is a small security win. No
// correctness depends on it.
purgeLegacyPersistKey('settings-storage');
