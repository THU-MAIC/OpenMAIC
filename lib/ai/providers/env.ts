import type { ProviderId } from '@/lib/types/provider';

/** Provider-owned environment mappings consumed by the server config loader. */
export const LLM_PROVIDER_ENV_MAP: Readonly<Record<string, ProviderId>> = {
  TOKENSMARKET: 'tokensmarket',
};
