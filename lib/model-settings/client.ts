/**
 * Client for the workspace model settings (`/api/model-config`, RFC #1701).
 *
 * Everything the settings UI shows comes from the server's view: slots,
 * providers, presets and the revision to write against. This module keeps one
 * cached view per page and applies changes against its revision. A stale
 * revision (409 CONFLICT) or a slot the deployment has just locked reloads the
 * view, so the caller only has to tell the user.
 *
 * The types are imported from the server module as types only: nothing of it
 * runs in the browser.
 */
import type {
  ModelSettingsChange,
  ModelSettingsView,
  PresetView,
  ProviderView,
  SlotView,
} from '@/lib/server/model-config/settings';

export type { ModelSettingsChange, ModelSettingsView, PresetView, ProviderView, SlotView };

export const MODEL_SETTINGS_ENDPOINT = '/api/model-config';

export interface ModelSettingsState {
  /**
   * `unavailable`: the server keeps no workspace settings (no persistence), so
   * models are whatever the deployment configures.
   */
  phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  /** The last view read; kept while a reload is in flight. */
  view: ModelSettingsView | null;
  error?: string;
}

export type ApplyResult =
  | { ok: true; view: ModelSettingsView }
  | {
      ok: false;
      /**
       * `conflict`: someone else changed the settings; the view was reloaded.
       * `locked`: the deployment locks a slot this change touched; reloaded too.
       * `invalid`: the server refused the change (message says why).
       * `unconfirmed`: the server took the request but its answer was lost, so
       * the change may or may not have been saved; the view was reloaded to
       * tell (`view`, when the reload worked).
       */
      reason: 'conflict' | 'locked' | 'invalid' | 'unavailable' | 'failed' | 'unconfirmed';
      code?: string;
      message: string;
      view?: ModelSettingsView;
    };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return body.error ?? {};
  } catch {
    return {};
  }
}

export function createModelSettingsClient(fetchImpl: Fetch) {
  let state: ModelSettingsState = { phase: 'idle', view: null };
  let loading: Promise<ModelSettingsState> | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: ModelSettingsState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  async function fetchView(): Promise<ModelSettingsState> {
    try {
      const response = await fetchImpl(MODEL_SETTINGS_ENDPOINT, { cache: 'no-store' });
      if (response.status === 404) return { phase: 'unavailable', view: null };
      if (!response.ok) {
        const { message } = await errorBody(response);
        return { phase: 'error', view: state.view, error: message ?? `HTTP ${response.status}` };
      }
      return { phase: 'ready', view: (await response.json()) as ModelSettingsView };
    } catch (error) {
      return {
        phase: 'error',
        view: state.view,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Read the view again. Concurrent calls share one request. */
  function load(): Promise<ModelSettingsState> {
    if (loading) return loading;
    setState({ ...state, phase: 'loading', error: undefined });
    loading = fetchView()
      .then((next) => {
        setState(next);
        return next;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /** Apply one change against the revision of the cached view. */
  async function apply(change: ModelSettingsChange): Promise<ApplyResult> {
    if (loading) await loading;
    if (!state.view) await load();
    const view = state.view;
    if (!view) {
      return state.phase === 'unavailable'
        ? { ok: false, reason: 'unavailable', message: 'Model settings are not available' }
        : { ok: false, reason: 'failed', message: state.error ?? 'Could not load the settings' };
    }

    // A write whose answer never arrives (the connection lost before or after
    // the server read it, a body cut short) may have been saved: read the
    // settings again to tell, and say it is unconfirmed. `view` is the reloaded
    // view when that read worked.
    const unconfirmed = async (error: unknown): Promise<ApplyResult> => {
      const reloaded = await load();
      return {
        ok: false,
        reason: 'unconfirmed',
        message: error instanceof Error ? error.message : String(error),
        ...(reloaded.phase === 'ready' && reloaded.view ? { view: reloaded.view } : {}),
      };
    };

    let response: Response;
    try {
      response = await fetchImpl(MODEL_SETTINGS_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: view.revision, change }),
      });
    } catch (error) {
      return unconfirmed(error);
    }

    if (response.ok) {
      let next: ModelSettingsView;
      try {
        next = (await response.json()) as ModelSettingsView;
      } catch (error) {
        return unconfirmed(error);
      }
      setState({ phase: 'ready', view: next });
      return { ok: true, view: next };
    }
    if (response.status === 404) {
      setState({ phase: 'unavailable', view: null });
      return { ok: false, reason: 'unavailable', message: 'Model settings are not available' };
    }
    const { code, message = `HTTP ${response.status}` } = await errorBody(response);
    if (response.status === 409) {
      await load();
      return { ok: false, reason: code === 'SLOT_LOCKED' ? 'locked' : 'conflict', code, message };
    }
    return {
      ok: false,
      reason: response.status === 400 ? 'invalid' : 'failed',
      code,
      message,
    };
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    apply,
  };
}

export type ModelSettingsClient = ReturnType<typeof createModelSettingsClient>;

/** The page's shared client. */
export const modelSettingsClient = createModelSettingsClient((input, init) => fetch(input, init));

export function findSlot(view: ModelSettingsView, slot: string): SlotView | undefined {
  return view.slots.find((entry) => entry.slot === slot);
}

/** Whether the workspace has a language model: the effective `llm` is assigned. */
export function isLlmConfigured(view: ModelSettingsView | null): boolean {
  return view ? findSlot(view, 'llm')?.effective.status === 'assigned' : false;
}

/** Whether the first-run setup applies: no language model and nothing locks `llm`. */
export function needsFirstRunSetup(view: ModelSettingsView | null): boolean {
  if (!view) return false;
  const llm = findSlot(view, 'llm');
  return !!llm && !llm.locked && llm.effective.status === 'unassigned';
}
