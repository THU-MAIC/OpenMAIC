import type { PBLProjectPackageEntry } from '@openmaic/dsl';

export const PROJECT_LIMITS = {
  files: 512,
  fileBytes: 512 * 1024,
  bytes: 8 * 1024 * 1024,
  teachingBytes: 32 * 1024,
  projects: 16,
  scenes: 256,
};

export function safeProjectPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\\\x00-\x1f\x7f:%]/.test(value) &&
    !value
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.startsWith('.') || part.trim() !== part,
      )
  );
}

/** Count validated resource indexes once per content checksum, even across scene bindings. */
export function projectResourcesWithinLimits(entries: Iterable<PBLProjectPackageEntry>): boolean {
  const checksums = new Set<string>();
  let files = 0,
    bytes = 0;
  for (const entry of entries) {
    if (checksums.has(entry.checksum)) continue;
    checksums.add(entry.checksum);
    if (checksums.size > PROJECT_LIMITS.projects) return false;
    for (const file of Object.values(entry.files)) {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROJECT_LIMITS.fileBytes)
        return false;
      files++;
      bytes += file.size;
      if (files > PROJECT_LIMITS.files || bytes > PROJECT_LIMITS.bytes) return false;
    }
  }
  return true;
}
