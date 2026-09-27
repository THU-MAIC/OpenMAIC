import type { AssetMeta, BinaryBlob } from '@openmaic/dsl';
import { AssetQuotaExceededError, type AssetPrincipal, type AssetStore } from '@openmaic/storage';

export interface RecordedPut {
  principalKey: string;
  bytes: Buffer;
  type: string;
  meta: Record<string, unknown> | undefined;
}

export interface FakeAssetStore {
  /** The seam `defaultPersistGenerated*` accepts in place of the Pg store. */
  store: AssetStore;
  /** Every accepted allocation, in order. */
  puts: RecordedPut[];
  /** Refuse further allocations for room, the way a quota-bounded store does. */
  full: boolean;
}

/**
 * An asset store that allocates in memory, or refuses for room.
 *
 * The refusal is the contract's own `AssetQuotaExceededError`, not a generic
 * throw, because what the tools are asserted to do with it depends on it being
 * classified as a refusal rather than as a fault.
 */
export function createFakeAssetStore(options: { full?: boolean } = {}): FakeAssetStore {
  const state: FakeAssetStore = {
    puts: [],
    full: options.full ?? false,
    store: undefined as unknown as AssetStore,
  };
  let next = 0;
  state.store = {
    async put(principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta) {
      if (state.full) throw new AssetQuotaExceededError();
      state.puts.push({
        principalKey: principal.key,
        bytes: Buffer.from(await data.arrayBuffer()),
        type: data.type,
        meta: meta as Record<string, unknown> | undefined,
      });
      next += 1;
      return `ast_fake_${next}` as never;
    },
    async identify() {
      return null;
    },
    async resolve() {
      return null;
    },
    async remove() {},
    async replace() {
      throw new Error('not used by these tests');
    },
  } as unknown as AssetStore;
  return state;
}
