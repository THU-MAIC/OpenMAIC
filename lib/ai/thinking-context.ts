/**
 * Async-context carrier for per-request ThinkingConfig.
 *
 * callLLM / streamLLM wrap each AI SDK call in thinkingContext.run()
 * so that the custom fetch wrapper in providers.ts can read the
 * current thinking preference and inject vendor-specific body params.
 *
 * IMPORTANT: This module uses node:async_hooks which is server-only.
 * providers.ts must NOT import this module directly (it's also used
 * on the client via settings.ts). Instead, providers.ts reads the
 * context via globalThis.__thinkingContext, which is set here at
 * module load time and guaranteed to be available before any fetch
 * wrapper runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ThinkingConfig } from '@/lib/types/provider';

const thinkingGlobal = globalThis as typeof globalThis & {
  __thinkingContext?: AsyncLocalStorage<ThinkingConfig | undefined>;
};

// Next.js evaluates this module separately for instrumentation and API routes.
// Reuse one store so a later evaluation cannot replace the context read by
// providers.ts while the long-lived runner still uses the original export.
export const thinkingContext = (thinkingGlobal.__thinkingContext ??= new AsyncLocalStorage<
  ThinkingConfig | undefined
>());
