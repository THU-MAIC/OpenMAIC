/**
 * Generation run hooks: the host-facing surface.
 *
 * Registered once, from `instrumentation.ts` `register()`, next to the
 * persistence hooks:
 *
 * ```ts
 * const { configureGenerationRunHooks } = await import('@/lib/server/generation-run-hooks');
 * configureGenerationRunHooks({ name: 'my-host', authorizeStart, wrapExecution });
 * ```
 *
 * Server-only. See `./types.ts` for what each hook is given and when it runs.
 */
export type {
  GenerationExecutionContext,
  GenerationFailureClassification,
  GenerationRunAttributes,
  GenerationRunHookEvent,
  GenerationRunHooks,
  GenerationStartContext,
  GenerationStartDecision,
  GenerationStartOrigin,
} from './types';
export { configureGenerationRunHooks } from './registry';
