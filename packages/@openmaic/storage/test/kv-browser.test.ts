import { BrowserKVStore } from '../src/index.js';
import { MemoryStorage } from './setup.js';
import { runKVStoreContract } from './kv-contract.js';

runKVStoreContract('BrowserKVStore', () => new BrowserKVStore({ storage: new MemoryStorage() }));
