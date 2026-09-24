import { describeStoredOwnerId } from './registry';
import type { OwnerPrincipal, SubjectKind } from './types';
import { isStorableOwnerId } from './types';

/**
 * The principal of an owner id read back from storage, for work that has no
 * request to authenticate: an agent run, a generation job, a claim.
 *
 * `kind` and the roles an id always carries come from the methods'
 * `describeStoredOwner` (`describeStoredOwnerId` in `./registry.ts`: the
 * built-ins recognize the ids they mint); roles a request is granted (a
 * token's groups) are not known here. An id no method recognizes is described as `kind: 'user'` with no
 * roles -- never as anonymous, so it cannot be the anonymous side of a claim.
 * `assurance` is always `unverified-legacy`: nothing was presented.
 *
 * The id is used as stored. Work that is about to create rows canonicalizes it
 * first (`canonicalizeOwner` in `lib/persistence/owner-merges.ts`), because a
 * claim can retire it while the work runs.
 */
export function principalFromStoredOwner(ownerId: string): OwnerPrincipal {
  if (!isStorableOwnerId(ownerId)) {
    throw new Error('principalFromStoredOwner requires a storable owner id');
  }
  const description = describeStoredOwnerId(ownerId);
  const kind: SubjectKind = KINDS.has(description?.kind as SubjectKind)
    ? description!.kind
    : 'user';
  const roles = description?.roles instanceof Set ? description.roles : NO_ROLES;
  return {
    ownerId,
    kind,
    roles,
    assurance: 'unverified-legacy',
    channel: 'stored',
  };
}

const NO_ROLES: ReadonlySet<string> = new Set<string>();
const KINDS: ReadonlySet<SubjectKind> = new Set<SubjectKind>([
  'anonymous',
  'user',
  'device',
  'shared',
  'service',
]);
