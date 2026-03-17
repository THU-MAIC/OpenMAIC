import type { StorageProvider, StorageType } from '../types';

/** No-op provider used when no external storage is configured. */
export class NoopStorageProvider implements StorageProvider {
  async upload(): Promise<string> {
    return '';
  }
  async exists(): Promise<boolean> {
    return false;
  }
  getUrl(): string {
    return '';
  }
  async batchExists(_hashes: string[], _type: StorageType): Promise<Set<string>> {
    return new Set();
  }
}
