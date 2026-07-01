/**
 * PBL v2 — learner-facing instructor intro (avatar hover tooltip text).
 *
 * Pure (no React) so the "what text to show / when there's none" rule is
 * unit-testable. The instructor's `description` is curated by the planner to be
 * learner-readable; the avatar shows it on hover. Returns undefined when it's
 * absent/blank so the caller can fall back to the role name.
 */
import type { PBLRole } from '@/lib/pbl/v2/types';

export function instructorIntroText(
  role?: Pick<PBLRole, 'description'> | null,
): string | undefined {
  const text = role?.description?.trim();
  return text ? text : undefined;
}
