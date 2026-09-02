/**
 * Server-side binding of the durable user-skill store.
 *
 * The storage package owns the schema and the store (`@openmaic/storage` skill
 * module); this file re-exports the pure validation/patch surface and binds the
 * store to the app's PostgreSQL pool through `user-skill-store.ts`, so tools,
 * routes and the runner import from one place.
 *
 * The owner model here is the anonymous-cookie owner from
 * `lib/server/agent-runtime/owner.ts`. There is deliberately no owner-merge
 * machinery: identity consolidation is a live-product concern, and the
 * `resolveFinalOwner` seam on the agent-session store is left untouched.
 */
import type {
  UserSkillPatchOpInput,
  UserSkillPatchOutcome,
  UserSkillRecord,
} from '@openmaic/storage';

import { getUserSkillStore } from './user-skill-store';

export {
  USER_SKILL_EDITABLE_PATHS,
  USER_SKILL_LIMIT,
  USER_SKILL_CONTENT_MAX_BYTES,
  USER_SKILL_NAME_PATTERN,
  UserSkillError,
  applyOpsOnce,
  applyUserSkillPatchOps,
  hasUnpairedSurrogate,
  normalizeUserSkillFields,
  validateUserSkillFields,
  validateUserSkillInput,
  type AppliedUserSkillOp,
  type UserSkillEditablePath,
  type UserSkillErrorCode,
  type UserSkillFields,
  type UserSkillPatchOpInput,
  type UserSkillPatchOutcome,
  type UserSkillRecord,
} from '@openmaic/storage';

export { getUserSkillStore } from './user-skill-store';
export type { Queryable, WithTransaction } from './user-skill-store';

export async function listUserSkills(ownerId: string): Promise<UserSkillRecord[]> {
  const store = await getUserSkillStore();
  return store.list(ownerId);
}

export async function findUserSkill(id: string, ownerId: string): Promise<UserSkillRecord | null> {
  const store = await getUserSkillStore();
  return store.find(id, ownerId);
}

export async function findUserSkillByRef(
  ownerId: string,
  ref: string,
): Promise<UserSkillRecord | null> {
  const store = await getUserSkillStore();
  return store.findByRef(ownerId, ref);
}

export async function createUserSkill(
  ownerId: string,
  input: { name: string; title: string; description: string; content: string },
): Promise<UserSkillRecord> {
  const store = await getUserSkillStore();
  return store.create(ownerId, input);
}

export async function deleteUserSkill(ownerId: string, ref: string): Promise<void> {
  const store = await getUserSkillStore();
  return store.delete(ownerId, ref);
}

export async function patchUserSkill(
  ownerId: string,
  ref: string,
  ops: readonly UserSkillPatchOpInput[],
): Promise<UserSkillPatchOutcome> {
  const store = await getUserSkillStore();
  return store.patch(ownerId, ref, ops);
}
