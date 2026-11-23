// @vitest-environment jsdom
import { act, createElement, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import en from '@/lib/i18n/locales/en-US.json';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('next/dynamic', () => ({
  default: () =>
    function Editor({
      value,
      onChange,
      readOnly,
    }: {
      value: string;
      onChange: (value: string) => void;
      readOnly: boolean;
    }) {
      return createElement('textarea', {
        'aria-label': 'source',
        value,
        readOnly,
        onInput: (event: { currentTarget: HTMLTextAreaElement }) =>
          onChange(event.currentTarget.value),
      });
    },
}));
vi.mock('react-resizable-panels', () => ({
  usePanelRef: () => useRef(null),
  Group: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Panel: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Separator: () => null,
}));
vi.mock('@/components/sandbox/project-terminal', () => ({ ProjectTerminal: () => null }));
import { LearningWorkbenchPanel } from '@/components/scene-renderers/pbl/v3/workbench-panel';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined,
  host: HTMLDivElement,
  failRead = false;
const onSave = vi.fn<Parameters<typeof LearningWorkbenchPanel>[0]['onSave']>(async () => ({
  hash: 'b'.repeat(64),
}));
const onDirtyChange = vi.fn();
let fixtureSequence = 0;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  onSave.mockClear();
  onDirtyChange.mockClear();
  failRead = false;
});
async function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      failRead && url.includes('file=PLAN.md')
        ? Response.json({ error: { code: 'SANDBOX_UNAVAILABLE' } }, { status: 503 })
        : Response.json({ text: 'Saved source', hash: 'a'.repeat(64) }),
    ),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const view = {
    id: `read-retry-panel-${++fixtureSequence}`,
    environmentId: 'environment',
    environment: { ready: true },
    revision: 1,
    files: ['PLAN.md', 'main.py'],
    state: { status: 'running' },
    stage: { kind: 'check', checker: 'tests' },
    actions: ['edit'],
    busy: false,
    evaluation: null,
  } as unknown as LearningView;
  const workbench = {
    environmentId: 'environment',
    revision: 1,
    canEdit: true,
    canManageFiles: false,
  } as LearningWorkbench;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(LearningWorkbenchPanel, {
        view,
        workbench,
        onFileTargetConsumed: () => {},
        pending: false,
        pendingAction: null,
        onRefresh: async () => {},
        onSave,
        onDirtyChange,
      }),
    ),
  );
}
function button(text: string) {
  const result = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  expect(result, text).toBeDefined();
  return result!;
}
async function edit(text: string) {
  const textarea = host.querySelector('textarea')!;
  await act(async () => {
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function blockedDraft() {
  await fixture();
  await edit('Unsent plan draft');
  failRead = true;
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="pblV3.workbench.discard"]')!.click(),
  );
  expect(host.textContent).toContain('pblV3.ide.draftRetained');
}
it('offers a draft-preserving read retry without a discard confirmation or an automatic write while blocked', async () => {
  await blockedDraft();
  const confirmations = vi.mocked(window.confirm).mock.calls.length;
  await act(async () => button('pblV3.ide.retryRead').click());
  expect(window.confirm).toHaveBeenCalledTimes(confirmations);
  expect(host.querySelector('textarea')!.value).toBe('Unsent plan draft');
  expect(host.querySelector('textarea')!.readOnly).toBe(true);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(onSave).not.toHaveBeenCalled();
  failRead = false;
  await act(async () => button('pblV3.ide.retryRead').click());
  expect(host.querySelector('textarea')!.value).toBe('Unsent plan draft');
  expect(host.querySelector('textarea')!.readOnly).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(onSave).toHaveBeenCalledWith(
    'PLAN.md',
    'Unsent plan draft',
    'a'.repeat(64),
    expect.any(Object),
  );
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  expect(en.pblV3.inputBlocked.unsaved).toContain('unsaved changes');
  expect(en.pblV3.inputBlocked.unsaved).not.toMatch(/saving|once saving/i);
});
it('shows saving for a healthy dirty file during the debounce while another file retains a blocked draft', async () => {
  await blockedDraft();
  await act(async () => button('main.py').click());
  expect(host.textContent).not.toContain('pblV3.ide.saved');
  expect(host.textContent).not.toContain('pblV3.ide.draftRetained');
  await edit('Healthy edit');
  expect(host.textContent).toContain('pblV3.ide.saving');
  expect(host.textContent).not.toContain('pblV3.ide.draftRetained');
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(749));
  expect(host.textContent).toContain('pblV3.ide.saving');
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0]?.[0]).toBe('main.py');
  expect(host.textContent).toContain('pblV3.ide.saved');
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
});

it('a healthy tab retains a visible retry action while another file pauses the save queue', async () => {
  await fixture();
  onSave.mockRejectedValueOnce(new Error('Plan acknowledgement lost'));
  await edit('Uncertain plan');
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(onSave).toHaveBeenCalledTimes(1);
  await act(async () => button('main.py').click());
  await edit('Healthy code');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('pblV3.ide.saveFailed');
  expect(button('pblV3.ide.saveFailed').disabled).toBe(false);
  await act(async () => button('pblV3.ide.saveFailed').click());
  expect(onSave.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ['PLAN.md', 'Uncertain plan'],
    ['main.py', 'Healthy code'],
  ]);
  await act(async () => button('PLAN.md ●').click());
  expect(host.textContent).toContain('pblV3.ide.saveFailed');
});

it('clears the paused queue indicator on a clean healthy tab without authorizing another file', async () => {
  await fixture();
  onSave.mockRejectedValueOnce(new Error('Plan acknowledgement lost'));
  await edit('Uncertain plan');
  await act(async () => vi.advanceTimersByTimeAsync(750));
  const request = onSave.mock.calls[0]![3];
  await act(async () => button('main.py').click());
  expect(host.textContent).toContain('pblV3.ide.saveFailed');
  await act(async () => button('pblV3.ide.saveFailed').click());
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('pblV3.ide.saved');
  expect(host.textContent).not.toContain('pblV3.ide.saveFailed');
  await act(async () => button('PLAN.md ●').click());
  expect(host.textContent).toContain('pblV3.ide.saveFailed');
  await act(async () => button('pblV3.ide.saveFailed').click());
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave.mock.calls[1]![3]).toBe(request);
  expect(host.textContent).not.toContain('pblV3.ide.saveFailed');
});

it('loads the updated file after discarding a draft without showing a save confirmation', async () => {
  await fixture();
  await edit('Unsent plan draft');
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ text: 'Updated by the tutor', hash: 'c'.repeat(64) }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="pblV3.workbench.discard"]')!.click(),
  );
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(host.querySelector('textarea')!.value).toBe('Updated by the tutor');
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(onSave).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('pblV3.ide.saved');
});
