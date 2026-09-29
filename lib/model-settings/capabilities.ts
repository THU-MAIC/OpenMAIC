/**
 * What the workspace's model settings let the client do, read from the
 * server's view (`/api/model-config`): whether a language model is set up,
 * and which provider each media capability resolves to. The browser keeps no
 * provider state of its own (RFC #1701); every request resolves its models on
 * the server, so the client only needs these facts to decide what to show and
 * what to ask for (browser speech runs in the browser, for instance).
 */
import type { SlotId } from '@/lib/config/model-slots';

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

export function modelCapabilities(view: ModelSettingsView | null | undefined): ModelCapabilities {
  return {
    known: !!view,
    llm: effectiveTarget(view, 'llm'),
    tts: effectiveTarget(view, 'tts'),
    asr: effectiveTarget(view, 'asr'),
    image: effectiveTarget(view, 'image'),
    video: effectiveTarget(view, 'video'),
    webSearch: effectiveTarget(view, 'webSearch'),
    document: effectiveTarget(view, 'document'),
  };
}

/**
 * Whether generation may start as far as the client can tell: a language
 * model is set up, or the settings could not be read (the server then says
 * what is missing).
 */
export function llmUsable(capabilities: ModelCapabilities): boolean {
  return !capabilities.known || !!capabilities.llm;
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
