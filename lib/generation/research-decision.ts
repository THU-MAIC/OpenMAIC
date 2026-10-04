/**
 * Whether a generation researches the web: the workspace's webSearch slot, as
 * a successful read of the model settings says (never a guess from settings
 * that could not be read). Decided when the session is saved and again when
 * generation starts or resumes, so a later change of the slot (or a failed
 * read at save time) is not frozen into the session.
 */
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';
import type { UserRequirements } from '@/lib/types/generation';

export function withResearchDecision<T extends { requirements: UserRequirements }>(
  session: T,
  capabilities: ModelCapabilities,
): T {
  const webSearch = !!capabilities.webSearch || undefined;
  if (session.requirements.webSearch === webSearch) return session;
  return { ...session, requirements: { ...session.requirements, webSearch } };
}
