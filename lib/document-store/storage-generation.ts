import { BrowserKVStore, type KVStore } from '@openmaic/storage';

const STORAGE_GENERATION_KEY = 'document-storage-generation';
let defaultKv: KVStore | undefined;

function resolveKv(kv?: KVStore): KVStore {
  if (kv) return kv;
  if (typeof localStorage === 'undefined') {
    throw new Error('Document storage generation requires localStorage (client-only)');
  }
  return (defaultKv ??= new BrowserKVStore());
}

export async function readGeneration(kv?: KVStore): Promise<number> {
  const generation = await resolveKv(kv).get<unknown>(STORAGE_GENERATION_KEY, 'device');
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0;
}

export async function bumpGeneration(kv?: KVStore): Promise<number> {
  const store = resolveKv(kv);
  const generation = (await readGeneration(store)) + 1;
  await store.set(STORAGE_GENERATION_KEY, generation, 'device');
  return generation;
}
