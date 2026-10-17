// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import { useCourseRefsOwnerLifecycle, useCourseRefsStore } from '@/lib/store/course-refs';
import type { WorkbenchCourseNavigation } from '@/lib/workbench/panel-context';
import { useRepairComposerPrefill } from '@/lib/workbench/use-repair-composer-prefill';
import type { WorkbenchComposerPrefill } from '@/lib/workbench/interactive-repair-prefill';

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t = createWorkbenchTranslator('en-US');
const prefill: WorkbenchComposerPrefill = {
  id: 10,
  courseId: 'course-flink',
  text: 'Repair scene-1 (untrusted evidence)',
};

const navigation: WorkbenchCourseNavigation = {
  activeCourseId: 'unrelated-visible-course',
  openCourse: () => {},
  lookupCourse: (id) => ({ id, name: id, pageCount: null }),
  courseOptions: [],
};

const replaceDraft = vi.fn();
const onConsumed = vi.fn();

function Probe({
  owner,
  expected,
  draft = '',
  selectedPrefill = prefill,
  courseNavigation = navigation,
}: {
  owner: string | null;
  expected: string | null;
  draft?: string;
  selectedPrefill?: WorkbenchComposerPrefill | null;
  courseNavigation?: WorkbenchCourseNavigation;
}) {
  // Same effect order as WorkbenchChat: attach refs before prefill runs.
  useCourseRefsOwnerLifecycle(owner);
  useRepairComposerPrefill({
    prefill: selectedPrefill,
    composerOwnerId: owner,
    expectedOwnerId: expected,
    draft,
    navigation: courseNavigation,
    replaceDraft,
    onConsumed,
    t,
    untitledCourse: 'Untitled',
  });
  return null;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useCourseRefsStore.getState().detachOwner();
  replaceDraft.mockClear();
  onConsumed.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useCourseRefsStore.getState().detachOwner();
  vi.restoreAllMocks();
});

async function render(input: Parameters<typeof Probe>[0]) {
  await act(async () => root.render(createElement(Probe, input)));
}

describe('interactive repair composer effect', () => {
  it('waits for pane session attach and binds the explicit target, not the visible course', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    await render({ owner: null, expected: 'adopted-session' });
    expect(replaceDraft).not.toHaveBeenCalled();
    expect(onConsumed).not.toHaveBeenCalled();
    expect(useCourseRefsStore.getState().refs).toEqual([]);

    await render({ owner: 'wrong-previous-session', expected: 'adopted-session' });
    expect(onConsumed).not.toHaveBeenCalled();

    await render({ owner: 'adopted-session', expected: 'adopted-session' });
    expect(useCourseRefsStore.getState().ownerSessionId).toBe('adopted-session');
    expect(useCourseRefsStore.getState().refs.map((r) => r.stageId)).toEqual(['course-flink']);
    expect(replaceDraft).toHaveBeenCalledExactlyOnceWith(prefill.text);
    expect(onConsumed).toHaveBeenCalledExactlyOnceWith(prefill.id);
    expect(request).not.toHaveBeenCalled();

    // Repaint and owner lifecycle must not replay or drop the reference.
    await render({ owner: 'adopted-session', expected: 'adopted-session' });
    expect(replaceDraft).toHaveBeenCalledTimes(1);
    expect(useCourseRefsStore.getState().refs.map((r) => r.stageId)).toEqual(['course-flink']);
  });

  it('stages an unsent repair against a new draft owner when no session exists', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    await render({ owner: null, expected: 'draft:course-flink' });
    expect(onConsumed).not.toHaveBeenCalled();
    await render({ owner: 'draft:course-flink', expected: 'draft:course-flink' });
    expect(useCourseRefsStore.getState().ownerSessionId).toBe('draft:course-flink');
    expect(useCourseRefsStore.getState().refs.map((r) => r.stageId)).toEqual(['course-flink']);
    expect(replaceDraft).toHaveBeenCalledExactlyOnceWith(prefill.text);
    expect(onConsumed).toHaveBeenCalledExactlyOnceWith(prefill.id);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not overwrite an occupied draft or attach a ref', async () => {
    await render({ owner: 'session', expected: 'session', draft: 'Keep my own text' });
    expect(replaceDraft).not.toHaveBeenCalled();
    expect(useCourseRefsStore.getState().refs).toEqual([]);
    expect(onConsumed).toHaveBeenCalledExactlyOnceWith(prefill.id);
  });

  it('waits while the target course is still being generated', async () => {
    await render({
      owner: 'session',
      expected: 'session',
      courseNavigation: { ...navigation, generatingCourseIds: new Set(['course-flink']) },
    });
    expect(onConsumed).not.toHaveBeenCalled();
    expect(replaceDraft).not.toHaveBeenCalled();

    await render({ owner: 'session', expected: 'session' });
    expect(onConsumed).toHaveBeenCalledExactlyOnceWith(prefill.id);
    expect(useCourseRefsStore.getState().refs[0]?.stageId).toBe('course-flink');
  });
});
