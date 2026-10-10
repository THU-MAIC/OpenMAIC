// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeInteractiveRepairHandoff,
  INTERACTIVE_REPAIR_HANDOFF_EVENT,
  stageInteractiveRepairHandoff,
} from '@/lib/workbench/interactive-repair-handoff';

afterEach(() => {
  sessionStorage.clear();
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
