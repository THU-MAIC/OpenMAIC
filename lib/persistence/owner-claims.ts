/**
 * Claiming anonymous work on sign-in.
 *
 * A visitor who works anonymously and then signs in has two owners: the
 * anonymous one their courses, folders, materials, agent sessions, skills,
 * runtime records and media were written under, and the account. A claim
 * moves everything the anonymous owner holds to the account, in one
 * transaction, and records the move in `owner_merges` so the anonymous id is
 * retired from then on (see `./owner-merges.ts` for what retirement means to
 * later writes).
 *
 * ## Participants
 *
 * Each owner-keyed store re-keys its own rows through a participant. Core
 * registers the stores it ships; a host with tables of its own registers
 * participants for them from `instrumentation.ts` with
 * {@link registerClaimParticipant}, before the first claim (the registry is
 * sealed then, like the other host registries).
 *
 * Participants run in ascending `order` (ties by name) inside the claim's
 * transaction, after it holds both owners' identity locks exclusively:
 *
 * | order | participant       | rows                                                   |
 * |------:|-------------------|--------------------------------------------------------|
 * |   100 | `document-folders`| `document_folders`, `document_stages.folder_id`        |
 * |   200 | `courses`         | `stage_meta` (and the retired `document_stages.owner_id`) |
 * |   300 | `owner-materials` | `owner_material`                                       |
 * |   400 | `agent-sessions`  | `agent_sessions`, the owner session-event projection   |
 * |   500 | `user-skills`     | `agent_user_skill`                                     |
 * |   600 | `runtime`         | `runtime_sessions` (records follow their session)      |
 * |   700 | `assets`          | `asset_entries.principal`                              |
 *
 * Why this order. Every core write path takes the identity lock first, so none
 * of them can be holding a row a claim wants while it waits for the claim: for
 * the rows those paths write, the identity lock is the guarantee, whatever the
 * order. The order is for lockers that do not take it (the offline asset
 * collector, host paths). For the tables a document write spans, the claim
 * locks rows in the order that write does: the `stage_meta` rows first (the
 * folders participant locks the source's before it re-files any
 * `document_stages` row), then document rows, then asset entries last, where
 * the collector and the document write lock them too. Folders run before
 * courses because they read ownership before it moves (a course's folder is
 * resolved against the owner that filed it). The package's session merge
 * locks sessions before the projection counters, as an event append does. A
 * host participant that locks core rows should take an order after the core
 * tables it reads; one that touches only its own tables can take any order
 * (1000 and up is left free for hosts). This is what the tests show: no
 * deadlock between a claim and the fenced writers, including a claim parked
 * mid-way; the collector is not fenced, and a pass racing a claim over the
 * same entries can still make PostgreSQL abort one side (answered as a
 * retryable `OWNER_BUSY`).
 *
 * ## Rules
 *
 * - `from` must be an owner the configured authenticator describes as
 *   anonymous (`principalFromStoredOwner`), and `to` must not be anonymous.
 *   An authenticator that sets `pendingClaim` describes those ids so.
 * - Idempotent: claiming a pair that is already merged succeeds and does
 *   nothing, so a retried request or a second tab is harmless.
 * - A `from` already claimed into a different account is refused: an anonymous
 *   identity's work belongs to the first account that claimed it.
 * - No chains. `to` must not itself be retired, and `from` must not have
 *   absorbed other owners. Since only anonymous owners are claimed and only
 *   non-anonymous owners claim, a merge is always one hop, and canonicalizing
 *   an id is one lookup.
 * - Waits are bounded: the identity locks for `OWNER_CLAIM_LOCK_WAIT_MS`
 *   (default 5 s; while a claim waits, PostgreSQL queues new writers of both
 *   owners behind it, so this wait is kept short), every later lock for 30 s.
 *   Losing a lock race is `OwnerClaimError('OWNER_BUSY')`, which changes
 *   nothing and may be retried as it is.
 * - Quotas are not enforced on the target: nothing is dropped, so an account
 *   can end up above its asset, material, skill or folder limit. It keeps
 *   everything and cannot add more until it is back under.
 */
import {
  PgAgentSessionStore,
  type Queryable as AgentSessionQueryable,
} from '@openmaic/storage/agent-session/pg';
import { reassignDocumentFolders, type Queryable } from '@openmaic/storage/document/pg';
import { PgRuntimeStore } from '@openmaic/storage/runtime/pg';
import { PgUserSkillStore } from '@openmaic/storage/skill/pg';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { OwnerAssurance, OwnerPrincipal, SubjectKind } from '@/lib/server/identity/types';
import { isStorableOwnerId } from '@/lib/server/identity/types';
import { principalFromStoredOwner } from '@/lib/server/identity/stored-owner';

import { assetPrincipalForOwner } from './owner-assets';
import {
  isLockContention,
  isOwnerBusyError,
  lockOwnerIdentities,
  resolveLockWaitMs,
} from './owner-merges';
import { ownerMaterialQuotaLockKey } from './owner-materials';
import { getServerPersistenceProvider, type ServerPersistenceProvider } from './server-provider';
import { STAGE_META_OWNERSHIP } from './stage-meta-ownership';

export interface ClaimParticipant {
  /** Unique; also the key of this participant's count in the claim result. */
  readonly name: string;
  /** Position in the claim's fixed global order; see the table above. */
  readonly order: number;
  /**
   * Move every row `fromOwnerId` holds in this participant's tables to
   * `toOwnerId`, on `tx`. May answer how many rows moved. A throw aborts the
   * whole claim: nothing any participant did is kept.
   */
  rekey(tx: Queryable, fromOwnerId: string, toOwnerId: string): Promise<number | void>;
}

interface RegistryState {
  participants: ClaimParticipant[];
  sealed?: boolean;
}

const REGISTRY_KEY = Symbol.for('openmaic.owner-claims.registry');
const globalState = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
function registry(): RegistryState {
  return (globalState[REGISTRY_KEY] ??= { participants: [] });
}

/** The names core's own participants use; a host participant cannot take one. */
export const CORE_CLAIM_PARTICIPANTS = [
  'document-folders',
  'courses',
  'owner-materials',
  'agent-sessions',
  'user-skills',
  'runtime',
  'assets',
] as const;

/**
 * Register a host claim participant. Server-only, at boot: call it from
 * `instrumentation.ts` `register()`. Throws after the first claim (a process
 * must not run some claims with a participant and others without), for a
 * duplicate or core name, or for a malformed participant.
 */
export function registerClaimParticipant(participant: ClaimParticipant): void {
  if (typeof window !== 'undefined') throw new Error('registerClaimParticipant is server-only');
  const state = registry();
  if (state.sealed) {
    throw new Error(
      'registerClaimParticipant was called after the first claim. Register participants from ' +
        'instrumentation.ts register(), before the server serves a request.',
    );
  }
  if (
    !participant ||
    typeof participant.name !== 'string' ||
    !participant.name ||
    typeof participant.rekey !== 'function' ||
    typeof participant.order !== 'number' ||
    !Number.isFinite(participant.order)
  ) {
    throw new Error(
      'registerClaimParticipant expects { name, order: finite number, rekey(tx, from, to) }',
    );
  }
  if (
    (CORE_CLAIM_PARTICIPANTS as readonly string[]).includes(participant.name) ||
    state.participants.some((existing) => existing.name === participant.name)
  ) {
    throw new Error(`A claim participant named ${JSON.stringify(participant.name)} exists already`);
  }
  state.participants.push({
    name: participant.name,
    order: participant.order,
    rekey: participant.rekey.bind(participant),
  });
}

export function resetClaimParticipantsForTests(): void {
  delete globalState[REGISTRY_KEY];
}

/** Whether `name` names a table (or view) on the current search path. */
async function tableExists(tx: Queryable, name: string): Promise<boolean> {
  const result = await tx.query<{ present: boolean } & Record<string, unknown>>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [name],
  );
  return result.rows[0]?.present === true;
}

/** Transaction-scoped advisory locks on `keys`, in ascending 64-bit key order. */
async function lockTextKeys(tx: Queryable, keys: readonly string[]): Promise<void> {
  const hashed = await tx.query<{ key: string } & Record<string, unknown>>(
    `SELECT DISTINCT hashtextextended(name, 0)::text AS key FROM unnest($1::text[]) AS name`,
    [[...keys]],
  );
  const ordered = hashed.rows
    .map((row) => BigInt(row.key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of ordered) {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()]);
  }
}

/** Core's participants. The asset one needs the provider's byte store to build a registry. */
function coreParticipants(provider: ServerPersistenceProvider): ClaimParticipant[] {
  return [
    {
      name: 'document-folders',
      order: 100,
      rekey: async (tx, from, to) => {
        // The source's ownership rows before any document row, the order a
        // document write locks them in.
        await tx.query(
          'SELECT stage_id FROM stage_meta WHERE owner_id = $1 ORDER BY stage_id FOR UPDATE',
          [from],
        );
        return (
          await reassignDocumentFolders(tx, {
            fromOwnerId: from,
            toOwnerId: to,
            documentOwnership: STAGE_META_OWNERSHIP,
          })
        ).length;
      },
    },
    {
      name: 'courses',
      order: 200,
      rekey: async (tx, from, to) => {
        // Row locks in key order before the update, like every other re-key.
        await tx.query(
          'SELECT stage_id FROM stage_meta WHERE owner_id = $1 ORDER BY stage_id FOR UPDATE',
          [from],
        );
        const moved = await tx.query<{ stage_id: string } & Record<string, unknown>>(
          'UPDATE stage_meta SET owner_id = $2 WHERE owner_id = $1 RETURNING stage_id',
          [from, to],
        );
        // Nothing reads the retired column, but leaving the old owner there
        // would count every claimed course as a disagreement at startup.
        const legacy = await tx.query<{ present: boolean } & Record<string, unknown>>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass('document_stages')
                AND attname = 'owner_id' AND NOT attisdropped
           ) AS present`,
        );
        if (legacy.rows[0]?.present === true) {
          await tx.query('UPDATE document_stages SET owner_id = $2 WHERE owner_id = $1', [
            from,
            to,
          ]);
        }
        return moved.rows.length;
      },
    },
    {
      name: 'owner-materials',
      order: 300,
      rekey: async (tx, from, to) => {
        // The quota locks uploads take, for both owners.
        await lockTextKeys(tx, [ownerMaterialQuotaLockKey(from), ownerMaterialQuotaLockKey(to)]);
        await tx.query('SELECT id FROM owner_material WHERE owner_id = $1 ORDER BY id FOR UPDATE', [
          from,
        ]);
        const moved = await tx.query<{ id: string } & Record<string, unknown>>(
          'UPDATE owner_material SET owner_id = $2 WHERE owner_id = $1 RETURNING id',
          [from, to],
        );
        return moved.rows.length;
      },
    },
    {
      name: 'agent-sessions',
      order: 400,
      rekey: async (tx, from, to) => {
        // Provisioned lazily, by the first use of the agent runtime.
        if (!(await tableExists(tx, 'agent_sessions'))) return 0;
        const pinned = tx as unknown as AgentSessionQueryable;
        const store = new PgAgentSessionStore(pinned, { withTransaction: (body) => body(pinned) });
        const moved = await store.mergeOwner(from, to);
        // Wake both owners' session-list streams: the account's to show what
        // arrived, the anonymous one's to notice it was retired. Lossy, and
        // delivered only on commit.
        const { notifyDurableAgentEvent } =
          await import('@/lib/server/agent-runtime/event-notify-bus');
        await notifyDurableAgentEvent(tx, { kind: 'owner', ownerId: to });
        await notifyDurableAgentEvent(tx, { kind: 'owner', ownerId: from });
        return moved;
      },
    },
    {
      name: 'user-skills',
      order: 500,
      rekey: async (tx, from, to) => {
        if (!(await tableExists(tx, 'agent_user_skill'))) return 0;
        const store = new PgUserSkillStore(tx, { withTransaction: (body) => body(tx) });
        return (await store.mergeOwner(from, to)).moved;
      },
    },
    {
      name: 'runtime',
      order: 600,
      rekey: async (tx, from, to) => {
        // A plain re-key, pinned to this transaction. Not `mergeLearner`,
        // which re-validates every session: one row a newer version wrote
        // would make every claim of this owner fail. Readers keep validating.
        const store = new PgRuntimeStore(tx, {
          withTransaction: (body) => body(tx),
          payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
        });
        return store.reassignLearner(from, to);
      },
    },
    {
      name: 'assets',
      order: 700,
      rekey: async (tx, from, to) =>
        // Moving the entries with the courses keeps the foreign-read rule
        // (`./owner-assets.ts`) satisfied: a course's media is readable by
        // others while the entry's owner is the course's owner, and both are
        // the account now.
        provider
          .assetStoreIn(tx)
          .reassignPrincipal(assetPrincipalForOwner(from).key, assetPrincipalForOwner(to).key),
    },
  ];
}

/** Every participant, in the order a claim runs them. Seals the registry. */
function participantsInOrder(provider: ServerPersistenceProvider): ClaimParticipant[] {
  const state = registry();
  state.sealed = true;
  return [...coreParticipants(provider), ...state.participants].sort(
    (a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export type OwnerClaimRefusal =
  | 'INVALID_OWNER'
  | 'SAME_OWNER'
  | 'SOURCE_NOT_ANONYMOUS'
  | 'TARGET_ANONYMOUS'
  | 'ALREADY_CLAIMED_ELSEWHERE'
  | 'TARGET_RETIRED'
  | 'SOURCE_HAS_CLAIMS'
  | 'OWNER_BUSY';

/** A claim the rules above refuse. Nothing was changed. */
export class OwnerClaimError extends Error {
  constructor(
    readonly code: OwnerClaimRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerClaimError';
  }
}

export interface ClaimOwnerOptions {
  /**
   * The kind of `toOwnerId`. Defaults to what the configured authenticator
   * says of the stored id (`principalFromStoredOwner`). The source's kind is
   * always that: see the rules above.
   */
  toKind?: SubjectKind;
  /** What the anonymous credential proved; recorded on the merge row. */
  fromAssurance?: OwnerAssurance;
  /** The persistence provider to claim in; defaults to this deployment's (`DATABASE_URL`). */
  provider?: ServerPersistenceProvider;
}

export type ClaimOwnerResult =
  | {
      status: 'claimed';
      /** Rows (or folders, courses, sessions...) each participant moved, by participant name. */
      moved: Record<string, number>;
    }
  | { status: 'already-claimed' };

/** How long a claim waits for any row or store lock after its identity locks. */
const CLAIM_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '30s'`;
/** How long a claim waits for the two identity locks (see the rules above). */
const DEFAULT_CLAIM_LOCK_WAIT_MS = 5_000;

/**
 * Move everything `fromOwnerId` owns to `toOwnerId` and retire `fromOwnerId`,
 * in one transaction: all participants' re-keys and the `owner_merges` row
 * commit together or not at all. See the module comment for the rules.
 */
export async function claimOwner(
  fromOwnerId: string,
  toOwnerId: string,
  options: ClaimOwnerOptions = {},
): Promise<ClaimOwnerResult> {
  if (!isStorableOwnerId(fromOwnerId) || !isStorableOwnerId(toOwnerId)) {
    throw new OwnerClaimError('INVALID_OWNER', 'claim owners must be storable owner ids');
  }
  if (fromOwnerId === toOwnerId) {
    throw new OwnerClaimError('SAME_OWNER', 'an owner cannot claim itself');
  }
  const fromKind = principalFromStoredOwner(fromOwnerId).kind;
  const toKind = options.toKind ?? principalFromStoredOwner(toOwnerId).kind;
  if (fromKind !== 'anonymous') {
    throw new OwnerClaimError('SOURCE_NOT_ANONYMOUS', 'only an anonymous owner can be claimed');
  }
  if (toKind === 'anonymous') {
    throw new OwnerClaimError('TARGET_ANONYMOUS', 'an anonymous owner cannot claim');
  }
  const provider =
    options.provider ?? (await getServerPersistenceProvider(process.env.DATABASE_URL ?? ''));
  const participants = participantsInOrder(provider);

  const identityWaitMs = resolveLockWaitMs('OWNER_CLAIM_LOCK_WAIT_MS', DEFAULT_CLAIM_LOCK_WAIT_MS);
  try {
    return await provider.withTransaction((tx) =>
      claimInTransaction(tx, fromOwnerId, toOwnerId, participants, identityWaitMs, options),
    );
  } catch (error) {
    if (isOwnerBusyError(error) || isLockContention(error)) {
      throw new OwnerClaimError(
        'OWNER_BUSY',
        'the owners are being written to; retry the claim shortly',
      );
    }
    throw error;
  }
}

async function claimInTransaction(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
  participants: readonly ClaimParticipant[],
  identityWaitMs: number,
  options: ClaimOwnerOptions,
): Promise<ClaimOwnerResult> {
  {
    await lockOwnerIdentities(tx, [fromOwnerId, toOwnerId], 'exclusive', identityWaitMs);
    await tx.query(CLAIM_LOCK_TIMEOUT_SQL);
    // After the locks, in statements of their own: see `./owner-merges.ts`.
    const merges = await tx.query<
      { from_owner_id: string; to_owner_id: string } & Record<string, unknown>
    >(
      `SELECT from_owner_id, to_owner_id FROM owner_merges
        WHERE from_owner_id IN ($1, $2) OR to_owner_id = $1`,
      [fromOwnerId, toOwnerId],
    );
    const fromMerge = merges.rows.find((row) => row.from_owner_id === fromOwnerId);
    if (fromMerge) {
      if (fromMerge.to_owner_id === toOwnerId) return { status: 'already-claimed' } as const;
      throw new OwnerClaimError(
        'ALREADY_CLAIMED_ELSEWHERE',
        'this anonymous owner was already claimed by another owner',
      );
    }
    if (merges.rows.some((row) => row.from_owner_id === toOwnerId)) {
      throw new OwnerClaimError('TARGET_RETIRED', 'the claiming owner was itself merged away');
    }
    if (merges.rows.some((row) => row.to_owner_id === fromOwnerId)) {
      throw new OwnerClaimError('SOURCE_HAS_CLAIMS', 'the claimed owner has absorbed other owners');
    }

    const moved: Record<string, number> = {};
    for (const participant of participants) {
      const count = await participant.rekey(tx, fromOwnerId, toOwnerId);
      moved[participant.name] = typeof count === 'number' ? count : 0;
    }
    await tx.query(
      `INSERT INTO owner_merges (from_owner_id, to_owner_id, from_assurance, moved)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [fromOwnerId, toOwnerId, options.fromAssurance ?? null, JSON.stringify(moved)],
    );
    return { status: 'claimed', moved } as const;
  }
}

/**
 * Claim the anonymous owner a request presented beside `principal` (its
 * {@link OwnerPrincipal.pendingClaim}) into `principal`. The source must still
 * be described as anonymous by the authenticator (`describeStoredOwner`).
 *
 * The anonymous cookie is a bearer credential: whoever presents it beside a
 * signed-in account can claim that anonymous work into the account -- the
 * same holder could already read and edit it. On a shared device, clear it
 * (or let the claim do so) before another person signs in.
 */
export async function claimPendingOwner(
  principal: OwnerPrincipal,
  options: Omit<ClaimOwnerOptions, 'toKind' | 'fromAssurance'> = {},
): Promise<ClaimOwnerResult> {
  const claim = principal.pendingClaim;
  if (!claim) throw new Error('claimPendingOwner requires a principal with a pendingClaim');
  return claimOwner(claim.fromOwnerId, principal.ownerId, {
    ...options,
    toKind: principal.kind,
    fromAssurance: claim.assurance,
  });
}
