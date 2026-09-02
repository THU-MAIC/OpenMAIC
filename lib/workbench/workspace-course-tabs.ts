/**
 * Workspace-wide persistence for the right pane's ordered course tabs.
 *
 * This is a browser view preference, not server data: the URL carries the
 * active course while the complete set is stored once for the whole workspace.
 * The payload is untrusted and may outlive several releases, so malformed
 * values are ignored and an oversized write is refused wholesale. Refusing is
 * not an eviction policy: the in-memory tab set remains unbounded and unchanged.
 */

import { type WorkspaceCourseTabs } from '@/lib/workbench/workspace-panes';

// Do not reuse `openmaic:workspace:course-tabs`: that key contains the old,
// incompatible Record<sessionId, tabs> payload and is deliberately ignored.
export const COURSE_TABS_STORAGE_KEY = 'openmaic:workspace:course-tabs:v2';
export const COURSE_TABS_MAX_STORED_CHARS = 1_000_000;

export function parseCourseTabsMemory(stored: string | null): WorkspaceCourseTabs | null {
  if (!stored || stored.length > COURSE_TABS_MAX_STORED_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !Array.isArray(parsed.courseIds)) return null;
    const courseIds = dedupeIds(parsed.courseIds);
    const closedCourseIds = Array.isArray(parsed.closedCourseIds)
      ? dedupeIds(parsed.closedCourseIds).filter((id) => !courseIds.includes(id))
      : [];
    const activeCourseId = parsed.activeCourseId;
    if (courseIds.length === 0) {
      if (activeCourseId !== null || closedCourseIds.length === 0) return null;
      return { courseIds, activeCourseId: null, closedCourseIds };
    }
    if (!validId(activeCourseId) || !courseIds.includes(activeCourseId)) return null;
    return closedCourseIds.length > 0
      ? { courseIds, activeCourseId, closedCourseIds }
      : { courseIds, activeCourseId };
  } catch {
    return null;
  }
}

export function serializeCourseTabsMemory(tabs: WorkspaceCourseTabs): string | null {
  const serialized = JSON.stringify(tabs);
  return serialized.length <= COURSE_TABS_MAX_STORED_CHARS ? serialized : null;
}

export function readCourseTabsMemory(): WorkspaceCourseTabs | null {
  try {
    return parseCourseTabsMemory(localStorage.getItem(COURSE_TABS_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeCourseTabsMemory(tabs: WorkspaceCourseTabs): void {
  try {
    if (tabs.courseIds.length === 0 && (tabs.closedCourseIds?.length ?? 0) === 0) {
      localStorage.removeItem(COURSE_TABS_STORAGE_KEY);
      return;
    }
    const serialized = serializeCourseTabsMemory(tabs);
    if (serialized !== null) localStorage.setItem(COURSE_TABS_STORAGE_KEY, serialized);
  } catch {
    // Private mode can deny storage. Losing local tab memory must not block navigation.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function dedupeIds(values: readonly unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!validId(value) || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}
