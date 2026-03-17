import { NoopStorageProvider } from './providers/noop';
import type { StorageProvider } from './types';

let _provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!_provider) {
    _provider = new NoopStorageProvider();
  }
  return _provider;
}

export type { StorageProvider, StorageType } from './types';
