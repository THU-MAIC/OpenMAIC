// @vitest-environment jsdom
import { act, createElement, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const layout = vi.hoisted(
  () =>
    new Map<
      string,
      (sizes: Record<string, number>, meta: { isUserInteraction: boolean }) => void
    >(),
);
// Drive the library's committed-layout boundary. Actual divider dragging is covered in the browser spec.
vi.mock('react-resizable-panels', () => ({
  usePanelRef: () => useRef(null),
  Group: ({
    children,
    onLayoutChanged,
  }: {
    children: { props: { id: string } }[];
    onLayoutChanged: typeof layout extends Map<string, infer T> ? T : never;
  }) => {
    layout.set(children[0]!.props.id, onLayoutChanged);
    return createElement('div', null, children as unknown as ReactNode);
  },
  Panel: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Separator: () => createElement('div'),
}));
import { WorkbenchSplit } from '@/components/scene-renderers/pbl/v3/workbench-split';
import { useStudyDraft } from '@/components/scene-renderers/pbl/v3/use-project-drafts';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let sequence = 0;
afterEach(() => {
  layout.clear();
  vi.unstubAllGlobals();
});

function Harness({ id }: { id: string }) {
  const { text, setText, showWorkspace, setShowWorkspace, showAssistant, setShowAssistant } =
    useStudyDraft(id, () => {});
  const [app, setApp] = useState(true);
  return createElement(
    'main',
    null,
    createElement('input', { value: text, onChange: () => {}, 'aria-label': 'draft' }),
    createElement('button', { onClick: () => setText('learner draft'), 'data-seed': true }, 'seed'),
    createElement('button', {
      'aria-label': 'workspace',
      'aria-pressed': showWorkspace,
      onClick: () => {
        if (showWorkspace) setShowAssistant(true);
        setShowWorkspace(!showWorkspace);
      },
    }),
    createElement('button', {
      'aria-label': 'assistant',
      'aria-pressed': showAssistant,
      onClick: () => {
        if (showAssistant) setShowWorkspace(true);
        setShowAssistant(!showAssistant);
      },
    }),
    createElement('output', null, String(app)),
    createElement(WorkbenchSplit, {
      workspace: createElement('div', null, 'editor'),
      assistant: createElement('div', null, 'chat'),
      application: createElement('iframe', { title: 'preview' }),
      showApplication: app,
      onCollapseApplication: () => setApp(false),
      showWorkspace,
      showAssistant,
      onCollapseWorkspace: () => {
        setShowAssistant(true);
        setShowWorkspace(false);
      },
      onCollapseAssistant: () => {
        setShowWorkspace(true);
        setShowAssistant(false);
      },
    }),
  );
}

async function fixture() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness, { id: `split-${++sequence}` })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-seed]')!.click());
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function commit(group: string, sizes: Record<string, number>, isUserInteraction = true) {
  layout.get(group)!(sizes, { isUserInteraction });
}

it('synchronizes an outer drag collapse and reopens workspace with one click without dropping drafts or the preview document', async () => {
  const f = await fixture();
  try {
    const iframe = f.host.querySelector('iframe');
    const workspace = f.host.querySelector<HTMLButtonElement>('[aria-label="workspace"]')!;
    await act(async () => commit('work-area', { 'work-area': 0, assistant: 100 }));
    expect(workspace.getAttribute('aria-pressed')).toBe('false');
    expect(f.host.querySelector('output')!.textContent).toBe('false');
    await act(async () => workspace.click());
    expect(workspace.getAttribute('aria-pressed')).toBe('true');
    expect(f.host.querySelector('input')!.value).toBe('learner draft');
    expect(f.host.querySelector('iframe')).toBe(iframe);
  } finally {
    await f.cleanup();
  }
});

it('synchronizes assistant and inner workspace collapses while keeping a valid persisted draft', async () => {
  const f = await fixture();
  try {
    const assistant = f.host.querySelector<HTMLButtonElement>('[aria-label="assistant"]')!;
    const workspace = f.host.querySelector<HTMLButtonElement>('[aria-label="workspace"]')!;
    await act(async () => commit('work-area', { 'work-area': 100, assistant: 0 }));
    expect(assistant.getAttribute('aria-pressed')).toBe('false');
    await act(async () => commit('workspace', { workspace: 0, application: 100 }));
    expect(workspace.getAttribute('aria-pressed')).toBe('false');
    expect(assistant.getAttribute('aria-pressed')).toBe('true');
    expect(f.host.querySelector('output')!.textContent).toBe('true');
    expect(f.host.querySelector('input')!.value).toBe('learner draft');
    await act(async () => workspace.click());
    expect(workspace.getAttribute('aria-pressed')).toBe('true');
  } finally {
    await f.cleanup();
  }
});

it('ignores imperative/restoration layout changes and preserves the existing application collapse callback', async () => {
  const f = await fixture();
  try {
    await act(async () => {
      commit('work-area', { 'work-area': 0, assistant: 100 }, false);
      commit('workspace', { workspace: 0, application: 0 }, false);
    });
    expect(f.host.querySelector('[aria-label="workspace"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(f.host.querySelector('output')!.textContent).toBe('true');
    await act(async () => commit('workspace', { workspace: 100, application: 0 }));
    expect(f.host.querySelector('output')!.textContent).toBe('false');
    expect(f.host.querySelector('[aria-label="workspace"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
  } finally {
    await f.cleanup();
  }
});
