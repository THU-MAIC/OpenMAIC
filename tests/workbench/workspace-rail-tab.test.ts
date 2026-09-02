import { describe, expect, it } from 'vitest';
import {
  RAIL_TAB_STORAGE_KEY,
  isRailTab,
  resolveRailTab,
} from '@/lib/workbench/workspace-rail-tab';

describe('isRailTab', () => {
  it('accepts the two tabs and nothing else', () => {
    expect(isRailTab('sessions')).toBe(true);
    expect(isRailTab('courses')).toBe(true);
    for (const bad of ['saved', '', 'SESSIONS', null, undefined, 0, {}]) {
      expect(isRailTab(bad)).toBe(false);
    }
  });
});

describe('resolveRailTab', () => {
  it('honours a stored preference over everything else', () => {
    expect(resolveRailTab({ stored: 'courses' })).toBe('courses');
    // Even against an open course: the stored value is the user's own press.
    expect(resolveRailTab({ stored: 'sessions', hasOpenCourse: true })).toBe('sessions');
  });

  it('opens on courses for a first visit that already has one open', () => {
    // `?course=` must be reachable after a refresh — the row it names is the
    // one marked `aria-current`, and a rail that hid it would be lying.
    expect(resolveRailTab({ stored: null, hasOpenCourse: true })).toBe('courses');
  });

  it('falls back to chats', () => {
    expect(resolveRailTab({})).toBe('sessions');
    expect(resolveRailTab({ stored: null })).toBe('sessions');
    expect(resolveRailTab({ stored: '' })).toBe('sessions');
    // A value from a future version, or a corrupted one, is not a crash.
    expect(resolveRailTab({ stored: 'saved' })).toBe('sessions');
  });

  it('keeps its storage key under the workspace namespace', () => {
    expect(RAIL_TAB_STORAGE_KEY).toBe('openmaic:workspace:rail-tab');
  });
});
