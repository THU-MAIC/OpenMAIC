import { describe, expect, it } from 'vitest';
import {
  forgetWorkspaceSession,
  LAST_WORKSPACE_SESSION_STORAGE_KEY,
  readLastWorkspaceSessionId,
  rememberWorkspaceHome,
  rememberWorkspaceSession,
  validateRememberedWorkspaceSession,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('workspace session entry memory', () => {
  it('resumes the last explicitly opened chat without coupling a classroom', () => {
    const storage = new MemoryStorage();
    rememberWorkspaceSession(' session-last-opened ', storage);

    const remembered = readLastWorkspaceSessionId(storage);
    expect(remembered).toBe('session-last-opened');
    expect(workspaceResumeHref(remembered)).toBe('/workspace?session=session-last-opened');
  });

  it('keeps the clean workspace home when no chat has been remembered', () => {
    expect(workspaceResumeHref(null)).toBe('/workspace');
    expect(workspaceResumeHref('  ')).toBe('/workspace');
  });

  it('remembers an explicit workspace home over the previously opened chat', () => {
    const storage = new MemoryStorage();
    rememberWorkspaceSession('session-old', storage);

    rememberWorkspaceHome(storage);

    expect(readLastWorkspaceSessionId(storage)).toBeNull();
    expect(workspaceResumeHref(readLastWorkspaceSessionId(storage))).toBe('/workspace');
    expect(storage.getItem(LAST_WORKSPACE_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it('forgets only the matching deleted conversation', () => {
    const storage = new MemoryStorage();
    storage.setItem(LAST_WORKSPACE_SESSION_STORAGE_KEY, 'session-kept');

    forgetWorkspaceSession('session-other', storage);
    expect(readLastWorkspaceSessionId(storage)).toBe('session-kept');

    forgetWorkspaceSession('session-kept', storage);
    expect(readLastWorkspaceSessionId(storage)).toBeNull();
  });

  it('forgets a remembered session that is missing from the loaded session list', () => {
    const storage = new MemoryStorage();
    rememberWorkspaceSession('session-stale', storage);

    expect(validateRememberedWorkspaceSession('session-stale', ['session-current'], storage)).toBe(
      false,
    );
    expect(readLastWorkspaceSessionId(storage)).toBeNull();
  });

  it('keeps a remembered session that still exists', () => {
    const storage = new MemoryStorage();
    rememberWorkspaceSession('session-current', storage);

    expect(
      validateRememberedWorkspaceSession('session-current', ['session-current'], storage),
    ).toBe(true);
    expect(readLastWorkspaceSessionId(storage)).toBe('session-current');
  });

  it('stays safe when storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
      removeItem: () => {
        throw new Error('unavailable');
      },
    };

    expect(() => rememberWorkspaceSession('session-a', storage)).not.toThrow();
    expect(() => rememberWorkspaceHome(storage)).not.toThrow();
    expect(readLastWorkspaceSessionId(storage)).toBeNull();
    expect(() => forgetWorkspaceSession('session-a', storage)).not.toThrow();
    expect(() => validateRememberedWorkspaceSession('session-a', [], storage)).not.toThrow();
  });

  it('encodes opaque session ids in the entry URL', () => {
    expect(workspaceResumeHref('session / ?')).toBe('/workspace?session=session%20%2F%20%3F');
  });
});
