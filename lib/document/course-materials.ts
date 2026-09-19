import type { SelectedCourseMaterial } from '@/lib/types/generation';

type CourseMaterialFingerprintInput = Pick<File, 'name' | 'size' | 'lastModified'>;

export function courseMaterialFingerprint(file: CourseMaterialFingerprintInput): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function dedupeCourseMaterialFiles(
  existing: SelectedCourseMaterial[],
  incoming: File[],
): File[] {
  const seen = new Set(existing.map(courseMaterialFingerprint));
  return incoming.filter((file) => {
    const fingerprint = courseMaterialFingerprint(file);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}
