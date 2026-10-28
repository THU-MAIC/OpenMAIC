/** Per-course view preference, local to this browser like the workspace's tabs. */
export type ClassroomMode = 'learning' | 'editing';

export function classroomModeStorageKey(courseId: string): string {
  return `openmaic:workspace:classroom-mode:${encodeURIComponent(courseId)}`;
}

export function readClassroomMode(courseId: string): ClassroomMode {
  try {
    return localStorage.getItem(classroomModeStorageKey(courseId)) === 'editing'
      ? 'editing'
      : 'learning';
  } catch {
    return 'learning';
  }
}

export function writeClassroomMode(courseId: string, mode: ClassroomMode): void {
  try {
    localStorage.setItem(classroomModeStorageKey(courseId), mode);
  } catch {
    // Storage denial must not prevent switching the current classroom's mode.
  }
}
