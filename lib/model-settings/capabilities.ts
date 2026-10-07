/**
 * What the workspace's model settings let the client do, read from the
 * server's view (`/api/model-config`): whether a language model is set up,
 * and which provider each media capability resolves to. The browser keeps no
 * provider state of its own (RFC #1701); every request resolves its models on
 * the server, so the client only needs these facts to decide what to show and
 * what to ask for (browser speech runs in the browser, for instance).
 */
import { MODEL_SLOTS, type SlotId } from '@/lib/config/model-slots';

import {
  findSlot,
  modelSettingsClient,
  type ModelSettingsClient,
  type ModelSettingsState,
  type ModelSettingsView,
  type TargetView,
} from './client';

export type MediaRoot = 'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'document';

/** The provider and model a slot resolves to, without anything secret. */
export type EffectiveTarget = TargetView;

export interface ModelCapabilities {
  /**
   * Whether the server's settings were read. When they could not be (the
   * server keeps none, or the read failed), nothing is known: callers do not
   * block on the language model and leave optional media off.
   */
  known: boolean;
  llm: EffectiveTarget | null;
  tts: EffectiveTarget | null;
  asr: EffectiveTarget | null;
  image: EffectiveTarget | null;
  video: EffectiveTarget | null;
  webSearch: EffectiveTarget | null;
  document: EffectiveTarget | null;
  /**
   * Every slot that resolves to a model, assigned where it is or inherited:
   * a child slot can resolve while the `llm` root is unassigned or off.
   */
  resolved: ReadonlySet<SlotId>;
}

/** The target a slot resolves to, or null when it is off, unassigned or invalid. */
export function effectiveTarget(
  view: ModelSettingsView | null | undefined,
  slot: SlotId,
): EffectiveTarget | null {
  if (!view) return null;
  const effective = findSlot(view, slot)?.effective;
  if (!effective || effective.status !== 'assigned') return null;
  const {
    status: _status,
    resolvedAt: _resolvedAt,
    source: _source,
    requirements: _requirements,
    fallback: _fallback,
    ...target
  } = effective;
  return target;
}

/**
 * The browser's own speech recognition: it needs no server provider, so it is
 * speech input while the asr slot is unassigned, as it always was; turning the
 * slot off (null) turns speech input off.
 */
const BROWSER_NATIVE_ASR_PROVIDER_ID = 'browser-native';
const BROWSER_SPEECH_RECOGNITION = {
  providerId: BROWSER_NATIVE_ASR_PROVIDER_ID,
  providerSource: 'deployment',
  presetId: BROWSER_NATIVE_ASR_PROVIDER_ID,
  registryId: BROWSER_NATIVE_ASR_PROVIDER_ID,
} as EffectiveTarget;

function speechInput(view: ModelSettingsView | null | undefined): EffectiveTarget | null {
  const assigned = effectiveTarget(view, 'asr');
  if (assigned) return assigned;
  const status = view ? findSlot(view, 'asr')?.effective.status : undefined;
  return !view || status === 'unassigned' ? BROWSER_SPEECH_RECOGNITION : null;
}

export function modelCapabilities(view: ModelSettingsView | null | undefined): ModelCapabilities {
  return {
    known: !!view,
    llm: effectiveTarget(view, 'llm'),
    tts: effectiveTarget(view, 'tts'),
    asr: speechInput(view),
    image: effectiveTarget(view, 'image'),
    video: effectiveTarget(view, 'video'),
    webSearch: effectiveTarget(view, 'webSearch'),
    document: effectiveTarget(view, 'document'),
    resolved: new Set(
      MODEL_SLOTS.map(({ id }) => id as SlotId).filter((id) => !!effectiveTarget(view, id)),
    ),
  };
}

/**
 * Whether requests that resolve through these slots may be sent, as far as
 * the client can tell: every slot resolves to a model (whatever the `llm`
 * root says), or the settings could not be read yet (the server then says
 * what is missing).
 */
export function slotsUsable(capabilities: ModelCapabilities, slots: readonly SlotId[]): boolean {
  return !capabilities.known || slots.every((slot) => capabilities.resolved.has(slot));
}

/** The content slots: the course content default and its per-scene-type children. */
const CONTENT_SLOTS: readonly SlotId[] = [
  'course.content',
  'course.content.slide',
  'course.content.quiz',
  'course.content.interactive',
  'course.content.pbl',
];

/**
 * Whether a course can be generated: the outline and the scene actions
 * resolve, and so does the content of at least one scene type (each scene
 * resolves its own content slot; the server refuses a type without one).
 *
 * The other course slots are not required: with `course.agents` off the
 * generated roster falls back to the preset agents, and with
 * `course.research` off web search runs on the raw requirement instead of a
 * rewritten query; neither request is refused.
 */
export function courseGenerationUsable(capabilities: ModelCapabilities): boolean {
  return (
    slotsUsable(capabilities, ['course.outline', 'course.actions']) &&
    (!capabilities.known || CONTENT_SLOTS.some((slot) => capabilities.resolved.has(slot)))
  );
}

/** Whether classroom chat and discussion can run: they resolve the `classroom` slot. */
export function classroomChatUsable(capabilities: ModelCapabilities): boolean {
  return slotsUsable(capabilities, ['classroom']);
}

/**
 * Whether the workspace cannot generate this kind of media: known to resolve
 * to nothing. While the settings are unknown (not read yet), media is not
 * reported as disabled.
 */
export function mediaGenerationDisabled(
  capabilities: ModelCapabilities,
  kind: 'image' | 'video',
): boolean {
  return capabilities.known && !capabilities[kind];
}

/** Whether the settings for a state could be read (ready, or an earlier view kept). */
function viewOf(state: ModelSettingsState): ModelSettingsView | null {
  return state.view;
}

/** The capabilities of the page's cached view (nothing is read from the server). */
export function currentModelCapabilities(
  client: ModelSettingsClient = modelSettingsClient,
): ModelCapabilities {
  return modelCapabilities(viewOf(client.getState()));
}

/**
 * The capabilities once the view has been read: reads it when nothing was
 * read yet, and waits for a read in flight.
 */
export async function loadModelCapabilities(
  client: ModelSettingsClient = modelSettingsClient,
): Promise<ModelCapabilities> {
  const state = client.getState();
  if (
    state.phase === 'idle' ||
    state.phase === 'loading' ||
    (!state.view && state.phase === 'error')
  ) {
    return modelCapabilities(viewOf(await client.load()));
  }
  return modelCapabilities(viewOf(state));
}

/** Delays between reads after a failed one: a transient failure is not the page's last word. */
export const MODEL_SETTINGS_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

const retries = new WeakMap<
  ModelSettingsClient,
  { attempt: number; timer: ReturnType<typeof setTimeout> | null }
>();

/**
 * Make sure the page has (or is getting) the view: read it when nothing was
 * read yet, and after a failed read with nothing to show, read again later
 * (backing off up to a minute, then every minute) until a read succeeds. A
 * view that was read is kept through later failures.
 */
export function ensureModelSettings(client: ModelSettingsClient = modelSettingsClient): void {
  const state = client.getState();
  if (state.phase === 'idle') {
    void client.load();
    return;
  }
  const entry = retries.get(client) ?? { attempt: 0, timer: null };
  retries.set(client, entry);
  if (state.phase !== 'error' || state.view) {
    // Read (or reading): the next failure starts from the first delay.
    if (state.phase !== 'loading') entry.attempt = 0;
    return;
  }
  if (entry.timer) return;
  const delay =
    MODEL_SETTINGS_RETRY_MS[Math.min(entry.attempt, MODEL_SETTINGS_RETRY_MS.length - 1)];
  entry.attempt += 1;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void client.load().then(() => ensureModelSettings(client));
  }, delay);
}

/**
 * The capabilities for work that must not guess: read (again after a failed
 * read), and null when the settings still cannot be read. Generation stops
 * rather than silently leaving out what the workspace would have given it.
 */
export async function requireModelCapabilities(
  client: ModelSettingsClient = modelSettingsClient,
): Promise<ModelCapabilities | null> {
  const first = await loadModelCapabilities(client);
  if (first.known) return first;
  const again = modelCapabilities((await client.load()).view);
  return again.known ? again : null;
}
