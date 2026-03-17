export type StorageType = 'media' | 'poster' | 'audio';

export interface StorageProvider {
  /** Upload blob to storage. Returns the public URL. Skips if already exists (dedup). */
  upload(hash: string, blob: Buffer, type: StorageType, mimeType?: string): Promise<string>;
  /** Check if a key already exists in storage. */
  exists(hash: string, type: StorageType): Promise<boolean>;
  /** Build the public download URL for a given hash. */
  getUrl(hash: string, type: StorageType): string;
  /** Batch check which hashes exist. Returns set of existing hashes. */
  batchExists(hashes: string[], type: StorageType): Promise<Set<string>>;
}
