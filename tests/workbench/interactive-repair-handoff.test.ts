// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeInteractiveRepairHandoff,
  INTERACTIVE_REPAIR_HANDOFF_EVENT,
  INTERACTIVE_REPAIR_HANDOFF_TTL_MS,
  stageInteractiveRepairHandoff,
} from '@/lib/workbench/interactive-repair-handoff';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

describe('interactive repair handoff', () => {
  it('stages one same-tab handoff and consumes it only for the target course', () => {
    const listener = vi.fn();
    window.addEventListener(INTERACTIVE_REPAIR_HANDOFF_EVENT, listener);

    expect(
      stageInteractiveRepairHandoff({
        courseId: 'course-1',
        sceneId: 'scene-1',
        error: '[error] ReferenceError: handleMainButton is not defined',
      }),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(consumeInteractiveRepairHandoff('course-other')).toBeNull();
    expect(consumeInteractiveRepairHandoff('course-1')).toEqual({
      sceneId: 'scene-1',
      error: '[error] ReferenceError: handleMainButton is not defined',
    });
    expect(consumeInteractiveRepairHandoff('course-1')).toBeNull();

    window.removeEventListener(INTERACTIVE_REPAIR_HANDOFF_EVENT, listener);
  });

  it('rejects a stale request after the short handoff TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    expect(
      stageInteractiveRepairHandoff({ courseId: 'course-A', sceneId: 'scene', error: 'boom' }),
    ).toBe(true);
    vi.advanceTimersByTime(INTERACTIVE_REPAIR_HANDOFF_TTL_MS + 1);
    expect(consumeInteractiveRepairHandoff('course-A')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('rejects duplicate-tab replay of a nonce already consumed in another tab', () => {
    expect(
      stageInteractiveRepairHandoff({ courseId: 'course-A', sceneId: 'scene', error: 'boom' }),
    ).toBe(true);
    const original = sessionStorage.getItem('openmaic:workbench:interactive-repair-handoff');
    expect(consumeInteractiveRepairHandoff('course-A')).toEqual({
      sceneId: 'scene',
      error: 'boom',
    });
    // A duplicate tab gets a copy of sessionStorage but shares localStorage.
    sessionStorage.setItem('openmaic:workbench:interactive-repair-handoff', original!);
    expect(consumeInteractiveRepairHandoff('course-A')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('rejects empty handoffs instead of creating a repair draft', () => {
    expect(
      stageInteractiveRepairHandoff({
        courseId: 'course-1',
        sceneId: 'scene-1',
        error: '   ',
      }),
    ).toBe(false);
    expect(consumeInteractiveRepairHandoff('course-1')).toBeNull();
  });
});
