import {
  assertServer,
  boundMethod,
  isOptionalFunction,
  unknownKey,
  unknownKeyMessage,
} from '@/lib/server/host-hook-registration';

import type { GenerationRunHooks } from './types';

/**
 * The process-wide generation run hooks, registered the way the persistence
 * hooks are (`lib/server/persistence-hooks/registry.ts`): once, from
 * `instrumentation.ts` `register()`, before the server serves a request or
 * the generation runner claims a run. The first read seals the registration:
 * a process must not execute some runs with a hook and others without.
 *
 * The state lives on `globalThis` because Next can evaluate this module more
 * than once in one process (the instrumentation hook and route bundles), and
 * all of them must see the one registration.
 */

interface RegistryState {
  hooks?: GenerationRunHooks;
  inUse?: boolean;
}

const REGISTRY_KEY = Symbol.for('openmaic.generation-run-hooks.registry');
const globalState = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
function registry(): RegistryState {
  return (globalState[REGISTRY_KEY] ??= {});
}

const NO_HOOKS: GenerationRunHooks = Object.freeze({ name: 'default' });

const HOOK_KEYS = ['name', 'authorizeStart', 'wrapExecution', 'classifyFailure', 'onRunEvent'];
const FUNCTION_HOOKS = [
  'authorizeStart',
  'wrapExecution',
  'classifyFailure',
  'onRunEvent',
] as const;

/**
 * Register the process-wide generation run hooks. Server-only and
 * single-shot: call it once from `instrumentation.ts` `register()`. Throws --
 * failing the boot -- when called twice, after the hooks were first read, or
 * with a value that is not a {@link GenerationRunHooks} (including an unknown
 * hook name, so a misspelled hook is reported rather than silently never
 * called).
 */
export function configureGenerationRunHooks(hooks: GenerationRunHooks): void {
  assertServer('configureGenerationRunHooks');
  const state = registry();
  if (state.hooks) {
    throw new Error(
      `Generation run hooks are already configured (${state.hooks.name}); ` +
        'configureGenerationRunHooks may be called once per process.',
    );
  }
  if (state.inUse) {
    throw new Error(
      'configureGenerationRunHooks was called after generation started using hooks. Call it ' +
        'from instrumentation.ts register(), before the server serves a request.',
    );
  }
  if (!hooks || typeof hooks !== 'object') {
    throw new Error('configureGenerationRunHooks expects an object');
  }
  // Each hook is read exactly once, so what is validated is what runs.
  const name: unknown = hooks.name;
  if (typeof name !== 'string' || !name) {
    throw new Error('configureGenerationRunHooks expects a non-empty name');
  }
  const unknown = unknownKey(hooks, HOOK_KEYS);
  if (unknown !== undefined) {
    throw new Error(`configureGenerationRunHooks ${unknownKeyMessage(unknown, HOOK_KEYS, 'hook')}`);
  }
  const stored: Record<string, unknown> = { name };
  for (const key of FUNCTION_HOOKS) {
    const value: unknown = hooks[key];
    if (!isOptionalFunction(value)) {
      throw new Error(`configureGenerationRunHooks expects ${key} to be a function`);
    }
    stored[key] = boundMethod(hooks, value);
  }
  state.hooks = Object.freeze(stored) as unknown as GenerationRunHooks;
}

/** The registered hooks, or none. Reading them seals the registration. */
export function getGenerationRunHooks(): GenerationRunHooks {
  const state = registry();
  state.inUse = true;
  return state.hooks ?? NO_HOOKS;
}

export function resetGenerationRunHooksForTests(): void {
  delete globalState[REGISTRY_KEY];
}
