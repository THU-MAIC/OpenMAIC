import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';

/** Server-authoritative decision shared by every workbench entry route. */
export function isWorkbenchEntryEnabled(): boolean {
  return isProWorkbenchEnabled() && isAgentRuntimeConfigured();
}
