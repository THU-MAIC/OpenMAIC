/**
 * Server-side binding of the durable user-skill store.
 *
 * The storage package owns the schema and the store (`@openmaic/storage` skill
 * module); this file re-exports the pure validation/patch surface and binds the
 * store to the app's PostgreSQL pool through `user-skill-store.ts`, so tools,
 * routes and the runner import from one place.
 *
 * The owner model here is the request owner resolved by the owner identity
 * seam (`lib/server/identity/`). A claim of anonymous work moves a skill
 * library with the rest of the owner's rows (`lib/persistence/owner-claims.ts`),
 * and creates forward a retired owner (`./user-skill-store.ts`).
 */
import type {
  UserSkillPatchOpInput,
  UserSkillPatchOutcome,
  UserSkillRecord,
} from '@openmaic/storage';

import { getRequestUserSkillStore, getUserSkillStore } from './user-skill-store';

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

/**
 * Create a skill. `source: 'request'` (an upload route) refuses an owner a
 * claim retired; the default, an agent run's create, forwards it to the
 * account instead.
 */
export async function createUserSkill(
  ownerId: string,
  input: { name: string; title: string; description: string; content: string },
  options: { source?: 'request' | 'background' } = {},
): Promise<UserSkillRecord> {
  const store =
    options.source === 'request' ? await getRequestUserSkillStore() : await getUserSkillStore();
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
