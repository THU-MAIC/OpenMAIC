import { CLASSROOM_ZIP_EXTENSION } from './classroom-zip-types';

/** Identify the source course and export snapshot without opening the archive. */
export function classroomFileName(name: string, id: string, exportedAt: string): string {
  // 40 Unicode code points + 64 ASCII ID characters + timestamp/extension fit in 255 UTF-8 bytes.
  const safeName =
    Array.from(name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim())
      .slice(0, 40)
      .join('') || 'classroom';
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'classroom';
  const stamp = new Date(exportedAt).toISOString().replace(/[-:.]/g, '');
  return `${safeName}_${safeId}_${stamp}${CLASSROOM_ZIP_EXTENSION}`;
}
