// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/i18n', () => ({ getClientTranslation: (key: string) => key }));
import { useProjectEditor } from '@/components/scene-renderers/pbl/v3/use-project-editor';
import { SandboxRequestError } from '@/components/sandbox/client';
import {
  acknowledgeDecisionDraft,
  readEditorDraft,
  useStudyDraft,
} from '@/components/scene-renderers/pbl/v3/use-project-drafts';
import type { LearningView } from '@/lib/pbl/v3/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined,
  container: HTMLDivElement,
  sequence = 0;
let editor: ReturnType<typeof useProjectEditor>, ui: ReturnType<typeof useStudyDraft>;
const read = vi.fn(async () => ({ text: 'Saved source', hash: 'a'.repeat(64) }));
const save = vi.fn<Parameters<typeof useProjectEditor>[2]>(async () => ({ hash: 'b'.repeat(64) })),
  error = vi.fn();
const view = (id: string, environmentId = 'environment-one') =>
  ({
    id,
    environmentId,
    environment: { ready: true },
    files: ['PLAN.md', 'main.py'],
    revision: 1,
  }) as LearningView;
function Editor({
  value,
  writable = true,
  enabled = true,
}: {
  value: LearningView;
  writable?: boolean;
  enabled?: boolean;
}) {
  const current = useProjectEditor(value, read, save, error, {
    enabled,
    canEdit: () => writable,
  });
  useEffect(() => {
    editor = current;
  });
  return null;
}
function Ui({ id }: { id: string }) {
  const current = useStudyDraft(id, error);
  useEffect(() => {
    ui = current;
  });
  return null;
}
async function mount(element: ReturnType<typeof createElement>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}
async function leave() {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
}
afterEach(async () => {
  await leave();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  read.mockClear();
  save.mockClear();
  error.mockClear();
});

describe('study-scoped local drafts', () => {
  it('acknowledges only the submitted decision version in its original study and milestone', async () => {
    const id = `decision-receipt-${sequence++}`;
    const response = { chosen: 'Submitted rule', rationale: 'Submitted reason' };
    await mount(createElement(Ui, { id }));
    await act(async () => {
      ui.setDecisionDrafts({ 'first:rule': response, 'second:rule': response });
      ui.setText('Independent chat draft');
    });
    await leave();
    await mount(createElement(Ui, { id: `${id}-other` }));
    await act(async () => ui.setDecisionDrafts({ 'first:rule': response }));
    await act(async () => acknowledgeDecisionDraft(id, 'first:rule', response));
    expect(ui.decisionDrafts).toEqual({ 'first:rule': response });
    await leave();
    await mount(createElement(Ui, { id }));
    expect(ui.decisionDrafts).toEqual({ 'second:rule': response });
    expect(ui.text).toBe('Independent chat draft');
    await act(async () =>
      ui.setDecisionDrafts({
        'first:rule': { ...response, rationale: 'Newer reason' },
      }),
    );
    await act(async () => acknowledgeDecisionDraft(id, 'first:rule', response));
    expect(ui.decisionDrafts['first:rule']?.rationale).toBe('Newer reason');
    await act(async () =>
      ui.setDecisionDrafts({
        'first:rule': { ...response, chosen: 'Newer rule' },
      }),
    );
    await act(async () => acknowledgeDecisionDraft(id, 'first:rule', response));
    expect(ui.decisionDrafts['first:rule']?.chosen).toBe('Newer rule');
  });

  it('restores unsent decision text and rationale only within the same study', async () => {
    const id = `decision-${sequence++}`;
    await mount(createElement(Ui, { id }));
    await act(async () =>
      ui.setDecisionDrafts({
        'stage:rule': { chosen: 'My rule\nwith two branches', rationale: 'My reason' },
      }),
    );
    await leave();
    await mount(createElement(Ui, { id: `${id}-other` }));
    expect(ui.decisionDrafts).toEqual({});
    await leave();
    await mount(createElement(Ui, { id }));
    expect(ui.decisionDrafts['stage:rule']).toEqual({
      chosen: 'My rule\nwith two branches',
      rationale: 'My reason',
    });
    await act(async () => ui.setText('Keep this independent chat draft.'));
    await act(async () => ui.setDecisionDrafts({}));
    expect(ui.text).toBe('Keep this independent chat draft.');
  });

  it('retains dirty tabs, isolates another study and refuses to overwrite changed files after replacement', async () => {
    const id = `editor-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Unsent plan'));
    await act(async () => editor.select('main.py'));
    await act(async () => editor.edit('Unsent code'));
    await leave();
    read.mockClear();
    await mount(createElement(Editor, { value: view(id) }));
    expect(editor.path).toBe('main.py');
    expect(editor.tabs).toEqual(['PLAN.md', 'main.py']);
    expect(editor.buffer?.text).toBe('Unsent code');
    expect(editor.dirty('PLAN.md')).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await leave();
    read.mockResolvedValueOnce({ text: 'Different recovered source', hash: 'c'.repeat(64) });
    read.mockResolvedValueOnce({ text: 'Different recovered plan', hash: 'd'.repeat(64) });
    await mount(createElement(Editor, { value: view(id, 'environment-two') }));
    expect(editor.stale).toBe(true);
    expect(editor.buffer?.text).toBe('Unsent code');
    await act(async () => editor.save());
    expect(save).not.toHaveBeenCalled();
    await leave();
    await mount(createElement(Editor, { value: view(`another-${sequence++}`) }));
    expect(editor.buffer?.text).toBe('Saved source');
    expect(editor.anyDirty).toBe(false);
  });
  it.each([false, true])(
    'recovers a rejected save after environment replacement (reload: %s) without discarding newer typing',
    async (reload) => {
      const id = `restored-save-${sequence++}`;
      await mount(createElement(Editor, { value: view(id) }));
      vi.useFakeTimers();
      save.mockRejectedValueOnce(
        new SandboxRequestError(
          'Restore the environment',
          409,
          'SANDBOX_CONFLICT',
          'ENVIRONMENT_UNAVAILABLE',
        ),
      );
      await act(async () => editor.edit('Rejected draft'));
      await act(async () => vi.advanceTimersByTimeAsync(750));
      const rejected = save.mock.calls[0]![3];
      await act(async () => editor.edit('Newer retained typing'));
      await act(async () =>
        root!.render(
          createElement(Editor, {
            value: { ...view(id), environment: { ready: false } } as LearningView,
            enabled: false,
          }),
        ),
      );
      if (reload) {
        await leave();
        await mount(createElement(Editor, { value: view(id, 'environment-two') }));
      } else
        await act(async () =>
          root!.render(
            createElement(Editor, { value: { ...view(id, 'environment-two'), revision: 2 } }),
          ),
        );
      expect(editor.stale).toBe(false);
      expect(editor.buffer?.text).toBe('Newer retained typing');
      expect(editor.buffer?.saved).toBe('Saved source');
      expect(editor.saveError).toBe('');
      await act(async () => vi.advanceTimersByTimeAsync(750));
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]?.slice(0, 3)).toEqual([
        'PLAN.md',
        'Newer retained typing',
        'a'.repeat(64),
      ]);
      expect(save.mock.calls[1]?.[3].id).not.toBe(rejected.id);
      expect(editor.anyDirty).toBe(false);
    },
  );

  it('recovers an unavailable save when the same environment becomes ready again', async () => {
    const id = `same-environment-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    save.mockRejectedValueOnce(
      new SandboxRequestError('Restore first', 409, 'SANDBOX_CONFLICT', 'ENVIRONMENT_UNAVAILABLE'),
    );
    await act(async () => editor.edit('Retained source'));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await act(async () =>
      root!.render(
        createElement(Editor, {
          value: { ...view(id), environment: { ready: false } } as LearningView,
          enabled: false,
        }),
      ),
    );
    await act(async () =>
      root!.render(createElement(Editor, { value: { ...view(id), revision: 2 } })),
    );
    expect(editor.saveError).toBe('');
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(save).toHaveBeenCalledTimes(2);
    expect(editor.anyDirty).toBe(false);
  });

  it('never overwrites a conflicting restored file or loses the local draft', async () => {
    const id = `restore-conflict-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    await act(async () => editor.edit('My retained source'));
    read.mockResolvedValueOnce({ text: 'Changed by another writer', hash: 'd'.repeat(64) });
    await act(async () =>
      root!.render(createElement(Editor, { value: view(id, 'environment-two') })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(editor.stale).toBe(true);
    expect(editor.buffer?.text).toBe('My retained source');
    expect(readEditorDraft(id).buffers['PLAN.md']?.text).toBe('My retained source');
    expect(save).not.toHaveBeenCalled();
  });

  it('recovers all dirty tabs while respecting current editing permissions', async () => {
    const id = `restore-tabs-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    await act(async () => editor.edit('Retained plan'));
    await act(async () => editor.select('main.py'));
    await act(async () => editor.edit('Retained code'));
    await act(async () =>
      root!.render(createElement(Editor, { value: view(id, 'environment-two'), writable: false })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(save).not.toHaveBeenCalled();
    expect(editor.stale).toBe(false);
    await act(async () =>
      root!.render(
        createElement(Editor, { value: { ...view(id, 'environment-two'), revision: 2 } }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(save.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['main.py', 'Retained code'],
      ['PLAN.md', 'Retained plan'],
    ]);
    expect(editor.anyDirty).toBe(false);
  });

  it('reconciles an uncertain old save observed in the restored file before saving newer typing', async () => {
    const id = `restored-ack-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    save.mockRejectedValueOnce(new Error('Acknowledgement lost'));
    await act(async () => editor.edit('Submitted source'));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    const request = save.mock.calls[0]![3];
    await act(async () => editor.edit('Newer source'));
    read.mockResolvedValueOnce({ text: 'Submitted source', hash: 'c'.repeat(64) });
    await act(async () =>
      root!.render(createElement(Editor, { value: view(id, 'environment-two') })),
    );
    expect(editor.buffer?.saved).toBe('Submitted source');
    expect(editor.buffer?.text).toBe('Newer source');
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(save.mock.calls[1]?.slice(0, 3)).toEqual(['PLAN.md', 'Newer source', 'c'.repeat(64)]);
    expect(save.mock.calls[1]?.[3].id).not.toBe(request.id);
    expect(editor.anyDirty).toBe(false);
  });

  it('does not let a late failure from the released environment freeze the recovered editor', async () => {
    const id = `late-recovery-${sequence++}`;
    let reject!: (error: Error) => void;
    save.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Submitted source'));
    let pending!: Promise<void>;
    await act(async () => {
      pending = editor.save();
    });
    await act(async () => editor.edit('Newer retained source'));
    await act(async () =>
      root!.render(createElement(Editor, { value: view(id, 'environment-two') })),
    );
    expect(editor.stale).toBe(false);
    await act(async () => {
      reject(new Error('Old workspace disconnected'));
      await pending;
    });
    expect(save.mock.calls[1]?.slice(0, 3)).toEqual([
      'PLAN.md',
      'Newer retained source',
      'a'.repeat(64),
    ]);
    expect(editor.saveError).toBe('');
    expect(editor.anyDirty).toBe(false);
  });

  it('recognizes a draft already present in the restored file after a page reload', async () => {
    const id = `reload-ack-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Already saved source'));
    await leave();
    read.mockResolvedValueOnce({ text: 'Already saved source', hash: 'c'.repeat(64) });
    await mount(createElement(Editor, { value: view(id, 'environment-two') }));
    expect(editor.stale).toBe(false);
    expect(editor.anyDirty).toBe(false);
    expect(editor.buffer?.text).toBe('Already saved source');
    expect(save).not.toHaveBeenCalled();
  });
  it('does not let a late save acknowledgement erase a newer draft after scene navigation', async () => {
    const id = `late-${sequence++}`;
    let release!: (value: { hash: string }) => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Submitted source'));
    let pending!: Promise<void>;
    await act(async () => {
      pending = editor.save();
    });
    await leave();
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Newer unsaved source'));
    await act(async () => {
      release({ hash: 'b'.repeat(64) });
      await pending;
    });
    expect(readEditorDraft(id).buffers['PLAN.md']?.text).toBe('Newer unsaved source');
    expect(editor.buffer?.text).toBe('Newer unsaved source');
  });
  it('debounces edits, keeps typing during a save, and saves the next version with the acknowledged hash', async () => {
    const id = `autosave-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    let release!: (receipt: { hash: string }) => void;
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => editor.edit('First edit'));
    await act(async () => vi.advanceTimersByTimeAsync(749));
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.saving).toBe(true);
    await act(async () => editor.edit('Typed while saving'));
    expect(editor.buffer?.text).toBe('Typed while saving');
    await act(async () => release({ hash: 'c'.repeat(64) }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.slice(0, 3)).toEqual([
      'PLAN.md',
      'Typed while saving',
      'c'.repeat(64),
    ]);
    expect(editor.anyDirty).toBe(false);
    expect(editor.buffer?.saved).toBe('Typed while saving');
  });
  it('resumes restored drafts when workspace permissions finish loading', async () => {
    const id = `ready-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Restored draft'));
    await leave();
    await mount(createElement(Editor, { value: view(id), enabled: false }));
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(save).not.toHaveBeenCalled();
    await act(async () => root!.render(createElement(Editor, { value: view(id), enabled: true })));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.anyDirty).toBe(false);
  });
  it.each([
    new Error('Connection interrupted'),
    new SandboxRequestError('Response lost', 503, 'SANDBOX_UNAVAILABLE'),
    new SandboxRequestError('Unclassified conflict', 409, 'SANDBOX_CONFLICT'),
  ])('retains uncertain edits and replays the same submission: %s', async (failure) => {
    const id = `failure-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    vi.useFakeTimers();
    save.mockRejectedValueOnce(failure);
    await act(async () => editor.edit('Submitted edit'));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(editor.saveError).toBe(failure.message);
    const request = save.mock.calls[0]?.[3];
    await act(async () => editor.edit('A newer edit'));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(readEditorDraft(id).buffers['PLAN.md']?.text).toBe('A newer edit');
    await act(async () => editor.save());
    expect(save.mock.calls[1]?.slice(0, 3)).toEqual(['PLAN.md', 'Submitted edit', 'a'.repeat(64)]);
    expect(save.mock.calls[1]?.[3]).toBe(request);
    expect(save.mock.calls[2]?.slice(0, 3)).toEqual(['PLAN.md', 'A newer edit', 'b'.repeat(64)]);
    expect(editor.anyDirty).toBe(false);
  });
  it.each(['PROGRESS_CHANGED', 'WORKSPACE_FILE_CONFLICT'])(
    'starts a fresh request after a definitive %s rejection without rebasing the file hash',
    async (reason) => {
      const id = `conflict-${sequence++}`;
      let revision = 1;
      save.mockImplementationOnce(async (_path, _text, _hash, request) => {
        request.revision ??= revision;
        throw new SandboxRequestError('Changed elsewhere', 409, 'SANDBOX_CONFLICT', reason);
      });
      await mount(createElement(Editor, { value: view(id) }));
      vi.useFakeTimers();
      await act(async () => editor.edit('Rejected draft'));
      await act(async () => vi.advanceTimersByTimeAsync(750));
      const rejected = { ...save.mock.calls[0]![3] };
      await act(async () => editor.edit('Newer retained draft'));
      revision = 2;
      await act(async () =>
        root!.render(createElement(Editor, { value: { ...view(id), revision } })),
      );
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(save).toHaveBeenCalledTimes(1);
      expect(editor.buffer?.text).toBe('Newer retained draft');
      save.mockImplementationOnce(async (_path, _text, _hash, request) => {
        request.revision ??= revision;
        return { hash: 'b'.repeat(64) };
      });
      await act(async () => editor.save());
      expect(save.mock.calls[1]?.slice(0, 3)).toEqual([
        'PLAN.md',
        'Newer retained draft',
        'a'.repeat(64),
      ]);
      expect(save.mock.calls[1]?.[3]).toMatchObject({ revision: 2 });
      expect(save.mock.calls[1]?.[3].id).not.toBe(rejected.id);
      expect(editor.anyDirty).toBe(false);
    },
  );
  it('ignores read-only editor changes and reflects saved Agent changes without writing them back', async () => {
    const id = `readonly-${sequence++}`;
    const value = view(id);
    await mount(createElement(Editor, { value, writable: false }));
    await act(async () => editor.edit('Programmatic Monaco event'));
    expect(editor.anyDirty).toBe(false);
    read.mockResolvedValueOnce({ text: 'Saved by Agent', hash: 'c'.repeat(64) });
    await act(async () =>
      root!.render(createElement(Editor, { value: { ...value, revision: 2 }, writable: false })),
    );
    expect(editor.buffer?.text).toBe('Saved by Agent');
    expect(editor.anyDirty).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('never lets an older file refresh overwrite typing begun while it was in flight', async () => {
    const id = `refresh-${sequence++}`;
    await mount(createElement(Editor, { value: view(id) }));
    let release!: (value: { text: string; hash: string }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () =>
      root!.render(createElement(Editor, { value: { ...view(id), revision: 2 } })),
    );
    await act(async () => editor.edit('New local typing'));
    await act(async () => release({ text: 'Older server read', hash: 'c'.repeat(64) }));
    expect(editor.buffer?.text).toBe('New local typing');
    expect(editor.anyDirty).toBe(true);
  });
  it('preserves chat, incomplete quiz choices and pane selection; a late send clears only its submitted text', async () => {
    const id = `ui-${sequence++}`;
    await mount(createElement(Ui, { id }));
    await act(async () => {
      ui.setText('My unsent explanation');
      ui.setShowWorkspace(false);
      const values: number[] = [];
      values[1] = 0;
      ui.setQuizAnswers({ key: 'milestone:5', values });
    });
    const acknowledged = ui.setText;
    await leave();
    await mount(createElement(Ui, { id }));
    expect(ui.text).toBe('My unsent explanation');
    expect(ui.showWorkspace).toBe(false);
    expect(ui.quizAnswers).toEqual({ key: 'milestone:5', values: [null, 0] });
    await leave();
    await act(async () => acknowledged((text) => (text === 'My unsent explanation' ? '' : text)));
    await mount(createElement(Ui, { id }));
    expect(ui.text).toBe('');
    await act(async () => ui.setText('A newer explanation'));
    await act(async () => acknowledged((text) => (text === 'My unsent explanation' ? '' : text)));
    await leave();
    await mount(createElement(Ui, { id }));
    expect(ui.text).toBe('A newer explanation');
  });
  it('keeps scene-return drafts in memory and reports unavailable browser storage', async () => {
    const id = `quota-${sequence++}`;
    const storage = window.sessionStorage;
    vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue({
      length: storage.length,
      clear: storage.clear.bind(storage),
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    await mount(createElement(Editor, { value: view(id) }));
    await act(async () => editor.edit('Copy this before leaving the page'));
    expect(error).toHaveBeenCalledWith('pblV3.draftStorageUnavailable');
    await leave();
    await mount(createElement(Editor, { value: view(id) }));
    expect(editor.buffer?.text).toBe('Copy this before leaving the page');
  });
});
