// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CourseIssueKind } from '@openmaic/dsl';
import { db } from '@/lib/device-storage/database';
import { useCourseIssues } from '@/lib/edit/use-course-issues';
import { useStageStore } from '@/lib/store/stage';
import { CourseIssuesButton } from '@/components/edit/EditDock/CourseIssuesButton';
import {
  AgentFixContext,
  type AgentFixAccess,
  type AgentFixRequest,
} from '@/lib/workbench/agent-fix-handoff';
import type { Scene } from '@/lib/types/stage';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Counts how often the list asks the device cache, passing every call through.
const cacheQueries = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/device-storage/observe-legacy-speech-audio', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/device-storage/observe-legacy-speech-audio')>();
  return {
    ...real,
    observeLegacyCourseAudio: (...args: Parameters<typeof real.observeLegacyCourseAudio>) => {
      cacheQueries.count += 1;
      return real.observeLegacyCourseAudio(...args);
    },
  };
});

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'edit.issues.pageLabel') return `Page ${options?.index} · ${options?.title}`;
      if (key === 'edit.issues.fixPrefillIssue') return `Fix ${options?.issue} on ${options?.page}`;
      if (options && 'count' in options) return `${key}:${options.count}`;
      return key;
    },
  }),
}));

// The list's logic is what is under test here; Radix's own popover and tooltip
// behaviour (portals, focus, positioning) is exercised in the browser.
vi.mock('@/components/ui/popover', async () => {
  const React = await import('react');
  const Ctx = React.createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => React.createElement(Ctx.Provider, { value: { open, onOpenChange } }, children),
    PopoverTrigger: ({ children }: { children: ReactElement<{ onClick?: () => void }> }) => {
      const ctx = React.useContext(Ctx);
      return React.cloneElement(children, { onClick: () => ctx.onOpenChange(!ctx.open) });
    },
    PopoverContent: ({
      children,
      'data-testid': testId,
    }: {
      children: ReactNode;
      'data-testid'?: string;
    }) => {
      const ctx = React.useContext(Ctx);
      return ctx.open ? React.createElement('div', { 'data-testid': testId }, children) : null;
    },
  };
});
vi.mock('@/components/edit/EditDock/dock-context', () => ({
  DockBarTip: ({ children }: { children: ReactNode }) => children,
}));

const slide = (
  id: string,
  order: number,
  actions: Scene['actions'],
  title = `Title ${order}`,
  elements: ReadonlyArray<Record<string, unknown>> = [{ id: 'el-present', type: 'text' }],
) =>
  ({
    id,
    stageId: 'course-1',
    type: 'slide',
    title,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
        elements,
      },
    },
    actions,
  }) as unknown as Scene;

const unvoiced = slide('scene-a', 1, [{ id: 'speech-a', type: 'speech', text: 'Hello' }]);
const cue = slide('scene-b', 2, [
  { id: 'speech-b', type: 'speech', text: 'Look', audioId: 'asset-b' },
  { id: 'cue-b', type: 'spotlight', elementId: 'el-gone' },
]);
const clean = slide('scene-c', 3, [{ id: 'speech-c', type: 'speech', text: 'Done', audioId: 'c' }]);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: ReactElement) {
  container ??= document.createElement('div');
  if (!container.isConnected) document.body.appendChild(container);
  root ??= createRoot(container);
  await act(async () => {
    root?.render(element);
    // Let the device-cache liveQuery answer.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function Probe() {
  const issues = useCourseIssues();
  return createElement(
    'ul',
    null,
    issues.map((issue) =>
      createElement(
        'li',
        { key: issue.id, 'data-kind': issue.kind, 'data-severity': issue.severity },
        `${issue.sceneId}:${issue.kind}`,
      ),
    ),
  );
}

const rows = () => [...(container?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
const testId = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const listedKinds = () =>
  [...(container?.querySelectorAll<HTMLElement>('[data-testid="course-issue-item"]') ?? [])].map(
    (item) => item.dataset.kind,
  );
/** Listed issues as `sceneId:kind`, the scene read from each row's "Go to". */
const listed = () =>
  [...(container?.querySelectorAll<HTMLElement>('[data-testid="course-issue-item"]') ?? [])].map(
    (item) => {
      const goTo = item.querySelector<HTMLElement>('[data-testid^="course-issue-goto-"]');
      return `${goTo?.dataset.testid?.slice('course-issue-goto-'.length)}:${item.dataset.kind}`;
    },
  );
const itemOn = (sceneId: string) =>
  container
    ?.querySelector(`[data-testid="course-issue-goto-${sceneId}"]`)
    ?.closest<HTMLElement>('[data-testid="course-issue-item"]');

/**
 * Narration issues wait on the device cache's first answer, which can take a
 * while the first time a test opens the database: wait for it, bounded.
 */
async function settle(done: () => boolean) {
  for (let attempt = 0; attempt < 40 && !done(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

beforeEach(() => {
  setModelSettingsViewForTests({ tts: { registryId: 'openai-tts' } });
  useStageStore.setState({
    stage: { id: 'course-1', name: 'Course', createdAt: 1, updatedAt: 1 },
    scenes: [unvoiced, cue, clean],
    currentSceneId: 'scene-c',
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await db.audioFiles.clear();
  setModelSettingsViewForTests(null);
  useStageStore.setState(useStageStore.getInitialState());
});

describe('useCourseIssues', () => {
  it('derives the whole course and follows the live document and device cache', async () => {
    await render(createElement(Probe));
    expect(rows()).toEqual(['scene-a:speech-without-audio', 'scene-b:dangling-cue']);

    // Fixing a cause clears its issue: the cue was removed, and the narration
    // was found in this device's cache.
    await act(async () => {
      useStageStore.setState({
        scenes: [unvoiced, { ...cue, actions: cue.actions!.slice(0, 1) }, clean],
      });
    });
    expect(rows()).toEqual(['scene-a:speech-without-audio']);
    await act(async () => {
      await db.audioFiles.put({
        id: 'tts_s1_speech-a',
        stageId: 'course-1',
        text: 'Hello',
        blob: new Blob(['audio']),
        format: 'mp3',
        createdAt: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(rows()).toEqual([]);
  });

  it('asks the device cache again only when the narration changes', async () => {
    await render(createElement(Probe));
    const queries = cacheQueries.count;

    // A page title or a cue is not narration: the cache is not asked again.
    await act(async () => {
      useStageStore.setState({
        scenes: [
          { ...unvoiced, title: 'Renamed' },
          { ...cue, actions: cue.actions!.slice(0, 1) },
          clean,
        ],
      });
    });
    expect(cacheQueries.count).toBe(queries);

    // Rewording a narration line is: its audio may no longer match.
    await act(async () => {
      useStageStore.setState({
        scenes: [
          { ...unvoiced, actions: [{ id: 'speech-a', type: 'speech', text: 'Hello again' }] },
          cue,
          clean,
        ] as Scene[],
      });
    });
    expect(cacheQueries.count).toBe(queries + 1);
  });
});

describe('CourseIssuesButton', () => {
  const owner = (handOff: AgentFixAccess['handOff']) =>
    createElement(
      AgentFixContext.Provider,
      { value: { handOff } },
      createElement(CourseIssuesButton),
    );

  it('lists every issue by page, goes to a page, and hands one issue or all to the agent', async () => {
    const handOff = vi.fn<(request: AgentFixRequest) => void>();
    await render(owner(handOff));
    await settle(() => testId('edit-course-issues-count')?.textContent === '2');
    expect(testId('edit-course-issues-count')?.textContent).toBe('2');
    expect(testId('edit-course-issues-count')?.dataset.severity).toBe('warning');

    await act(async () => testId('edit-course-issues')?.click());
    expect(listedKinds()).toEqual(['speech-without-audio', 'dangling-cue']);
    expect(testId('course-issues-popover')?.textContent).toContain('Page 1 · Title 1');
    expect(testId('course-issues-popover')?.textContent).toContain('Page 2 · Title 2');

    await act(async () => testId('course-issue-goto-scene-b')?.click());
    expect(useStageStore.getState().currentSceneId).toBe('scene-b');
    expect(testId('course-issues-popover')).toBeNull();

    await act(async () => testId('edit-course-issues')?.click());
    const fixCue = container?.querySelector<HTMLElement>(
      '[data-testid^="course-issue-fix-"][data-testid*="dangling-cue"]',
    );
    await act(async () => fixCue?.click());
    expect(handOff).toHaveBeenLastCalledWith({
      courseId: 'course-1',
      prefill: 'Fix edit.issues.kind.danglingCue on Page 2 · Title 2 (cue-b)',
    });

    await act(async () => testId('edit-course-issues')?.click());
    await act(async () => testId('course-issues-fix-all')?.click());
    expect(handOff).toHaveBeenLastCalledWith({
      courseId: 'course-1',
      prefill: 'edit.issues.fixPrefillCourse',
    });
  });

  // Every kind `collectCourseIssues` reports from the document reaches the
  // list with its own label, and leaves it once its cause is fixed.
  const voiced = { id: 'speech-ok', type: 'speech', text: 'Hi', audioId: 'asset-ok' };
  const image = (src: string) => [
    { id: 'el-present', type: 'text' },
    { id: 'img', type: 'image', src },
  ];
  const kinds: ReadonlyArray<{
    kind: CourseIssueKind;
    label: string;
    broken: Scene;
    fixed: Scene;
  }> = [
    {
      kind: 'speech-without-audio',
      label: 'edit.issues.kind.speechWithoutAudio',
      broken: slide('k', 1, [{ id: 'speech-k', type: 'speech', text: 'Hi' }] as Scene['actions']),
      fixed: slide('k', 1, [voiced] as Scene['actions']),
    },
    {
      kind: 'media-not-generated',
      label: 'edit.issues.kind.mediaNotGenerated',
      broken: slide('k', 1, [voiced] as Scene['actions'], 'Media', image('gen_img_1')),
      fixed: slide(
        'k',
        1,
        [voiced] as Scene['actions'],
        'Media',
        image('https://example.com/picture.png'),
      ),
    },
    {
      kind: 'dangling-cue',
      label: 'edit.issues.kind.danglingCue',
      broken: slide('k', 1, [
        voiced,
        { id: 'cue-k', type: 'spotlight', elementId: 'el-gone' },
      ] as Scene['actions']),
      fixed: slide('k', 1, [
        voiced,
        { id: 'cue-k', type: 'spotlight', elementId: 'el-present' },
      ] as Scene['actions']),
    },
    {
      kind: 'empty-actions',
      label: 'edit.issues.kind.emptyActions',
      broken: slide('k', 1, []),
      fixed: slide('k', 1, [voiced] as Scene['actions']),
    },
    {
      kind: 'empty-speech',
      label: 'edit.issues.kind.emptySpeech',
      broken: slide('k', 1, [
        voiced,
        { id: 'speech-blank', type: 'speech', text: ' ' },
      ] as Scene['actions']),
      fixed: slide('k', 1, [
        voiced,
        { id: 'speech-blank', type: 'speech', text: 'Now', audioId: 'asset-now' },
      ] as Scene['actions']),
    },
    {
      kind: 'unbound-cue',
      label: 'edit.issues.kind.unboundCue',
      broken: slide('k', 1, [
        voiced,
        { id: 'cue-k', type: 'spotlight', elementId: '' },
      ] as Scene['actions']),
      fixed: slide('k', 1, [
        voiced,
        { id: 'cue-k', type: 'spotlight', elementId: 'el-present' },
      ] as Scene['actions']),
    },
    {
      kind: 'empty-discussion',
      label: 'edit.issues.kind.emptyDiscussion',
      broken: slide('k', 1, [
        voiced,
        { id: 'talk', type: 'discussion', topic: '' },
      ] as Scene['actions']),
      fixed: slide('k', 1, [
        voiced,
        { id: 'talk', type: 'discussion', topic: 'Why does it fall?' },
      ] as Scene['actions']),
    },
  ];

  it('covers every document issue kind', () => {
    expect(kinds.map(({ kind }) => kind).sort()).toEqual(
      [
        'dangling-cue',
        'empty-actions',
        'empty-discussion',
        'empty-speech',
        'media-not-generated',
        'speech-without-audio',
        'unbound-cue',
      ].sort(),
    );
  });

  it.each(kinds)('lists $kind with its label and drops it once fixed', async (entry) => {
    // A page whose narration has no audio on the server or on this device is
    // listed only once the device cache has answered for the course's current
    // narration (until then every narration issue is held back). Waiting for it
    // after each change means the list has settled, so an issue that is still
    // there cannot pass for one that was fixed.
    const sentinel = slide(
      'sentinel',
      2,
      [{ id: 'speech-sentinel', type: 'speech', text: 'Still silent' }] as Scene['actions'],
      'Sentinel',
    );
    const settled = 'sentinel:speech-without-audio';
    useStageStore.setState({ scenes: [entry.broken, sentinel] });
    await render(owner(vi.fn()));
    await act(async () => testId('edit-course-issues')?.click());
    await settle(() => listed().includes(settled) && listed().length === 2);
    expect(listed()).toEqual([`k:${entry.kind}`, settled]);
    expect(itemOn('k')?.textContent).toContain(entry.label);
    expect(testId('edit-course-issues-count')?.textContent).toBe('2');

    await act(async () => {
      useStageStore.setState({ scenes: [entry.fixed, sentinel] });
    });
    await settle(() => listed().includes(settled));
    expect(listed()).toEqual([settled]);
    expect(testId('edit-course-issues-count')?.textContent).toBe('1');
  });

  it('offers no hand-off where a conversation could not change the course', async () => {
    await render(owner(null));
    await settle(() => testId('edit-course-issues-count')?.textContent === '2');
    await act(async () => testId('edit-course-issues')?.click());
    expect(container?.querySelectorAll('[data-testid="course-issue-item"]')).toHaveLength(2);
    expect(container?.querySelector('[data-testid^="course-issue-fix-"]')).toBeNull();
    expect(testId('course-issues-fix-all')).toBeNull();
  });

  it('says so when the course has no issues', async () => {
    useStageStore.setState({ scenes: [clean] });
    await render(owner(vi.fn()));
    expect(testId('edit-course-issues-count')).toBeNull();
    await act(async () => testId('edit-course-issues')?.click());
    expect(testId('course-issues-popover')?.textContent).toContain('edit.issues.empty');
    expect(testId('course-issues-fix-all')).toBeNull();
  });
});
