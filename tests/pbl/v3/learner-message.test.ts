// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLearnerMessage } from '@/components/scene-renderers/pbl/v3/use-learner-message';
import {
  useStudyDraft,
  readPendingMessage,
} from '@/components/scene-renderers/pbl/v3/use-project-drafts';
import type { LearningView } from '@/lib/pbl/v3/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
let study = '',
  sequence = 0;
const storageError = vi.fn();
let current: ReturnType<typeof useLearnerMessage> & {
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
};
const view = (ids: string[] = [], id = study) =>
  ({
    id,
    messages: [],
    conversation: ids.map((id) => ({
      id,
      commandId: id,
      speaker: 'user',
      parts: [{ kind: 'text', id, text: 'Ready' }],
    })),
  }) as unknown as LearningView;
function Hook({ value }: { value: LearningView }) {
  const { text, setText, pendingMessage } = useStudyDraft(value.id, storageError);
  const submission = useLearnerMessage(value, storageError, pendingMessage);
  useEffect(() => {
    current = { ...submission, text, setText };
  }, [submission, text, setText]);
  return null;
}
beforeEach(async () => {
  study = `message-${sequence++}`;
  storageError.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(Hook, { value: view(['earlier']) })));
  await act(async () => current.setText('Ready'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('clears the submitted draft and shows its bubble immediately, ignoring an earlier identical turn', async () => {
  await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
  expect(current.text).toBe('');
  expect(current.entry?.speaker).toBe('user');
  expect(current.entry?.parts).toEqual([{ kind: 'text', id: 'command', text: 'Ready' }]);
  await act(async () => root.render(createElement(Hook, { value: view(['earlier']) })));
  expect(current.entry).not.toBeNull();
});

it('replaces the temporary bubble when SSE arrives before HTTP and does not restore accepted text on a lost acknowledgement', async () => {
  await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
  const accepted = view(['earlier', 'command']);
  await act(async () => root.render(createElement(Hook, { value: accepted })));
  expect(current.entry).toBeNull();
  await act(async () => current.finish('command', false, accepted));
  expect(current.text).toBe('');
  expect(current.entry).toBeNull();
});

it('restores rejected text, then allows an idempotent retry to acknowledge immediately', async () => {
  await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
  await act(async () => current.finish('command', false, view(['earlier'])));
  expect(current.entry).toBeNull();
  expect(current.text).toBe('Ready');
  await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
  expect(current.entry).not.toBeNull();
  expect(current.text).toBe('');
  await act(async () => current.finish('command', true, view(['earlier', 'accepted'])));
  expect(current.entry).toBeNull();
});

it.each([false, true])(
  'preserves a newer draft when HTTP settles (success: %s)',
  async (success) => {
    await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
    await act(async () => current.setText('New draft'));
    await act(async () => current.finish('command', success, view(['earlier'])));
    expect(current.text).toBe(success ? 'New draft' : 'Ready\n\nNew draft');
    expect(current.entry).toBeNull();
  },
);

it('does not clear a newly typed identical draft after success or replace a newer submission on late settlement', async () => {
  await act(async () => current.begin(view(['earlier']), 'command', 'Ready'));
  await act(async () => current.setText('Ready'));
  await act(async () => current.finish('command', true, view(['earlier', 'accepted'])));
  expect(current.text).toBe('Ready');
  await act(async () => current.begin(view(['earlier', 'accepted']), 'next', 'Ready'));
  await act(async () => current.finish('command', false, view(['earlier'])));
  expect(current.entry?.id).toBe('sending-next');
  expect(current.text).toBe('');
});

it('isolates temporary bubbles by study and never mistakes another identical send for its own receipt', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  await act(async () => root.render(createElement(Hook, { value: view([], 'other') })));
  expect(current.entry).toBeNull();
  await act(async () => root.render(createElement(Hook, { value: view(['other-command']) })));
  expect(current.entry).not.toBeNull();
  await act(async () => current.finish('command', false, view(['other-command'])));
  expect(current.text).toBe('Ready');
});

it('remembers an SSE acknowledgement across navigation before a lost HTTP response settles', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  await act(async () => current.observe(view(['command'])));
  expect(readPendingMessage(study)).toBeUndefined();
  await act(async () => root.render(createElement(Hook, { value: view([], `${study}-other`) })));
  await act(async () => current.setText('Other project draft'));
  await act(async () => current.finish('command', false, view([], `${study}-other`)));
  expect(current.text).toBe('Other project draft');
  await act(async () => root.render(createElement(Hook, { value: view() })));
  expect(current.text).toBe('');
  expect(current.entry).toBeNull();
});

async function remount(value: LearningView, reload = false) {
  await act(async () => root.unmount());
  root = createRoot(container);
  if (!reload) {
    await act(async () => root.render(createElement(Hook, { value })));
    return;
  }
  // Discard the module memory cache, as a real page reload does. Only browser
  // sessionStorage survives; no execution request is automatically replayed.
  vi.resetModules();
  const { useStudyDraft: useReloadedDraft } =
    await import('@/components/scene-renderers/pbl/v3/use-project-drafts');
  const { useLearnerMessage: useReloadedMessage } =
    await import('@/components/scene-renderers/pbl/v3/use-learner-message');
  function Reloaded() {
    const { text, setText, pendingMessage } = useReloadedDraft(value.id, storageError);
    const submission = useReloadedMessage(value, storageError, pendingMessage);
    useEffect(() => {
      current = { ...submission, text, setText };
    }, [submission, text, setText]);
    return null;
  }
  await act(async () => root.render(createElement(Reloaded)));
}

it('recovers unacknowledged text from browser storage after a full reload without replaying a request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await act(async () => current.begin(view(), 'command', 'Ready'));
  const saved = JSON.parse(sessionStorage.getItem(`maic:pbl-draft:v1:${study}:ui`)!);
  expect(saved.text).toBe('');
  expect(saved.pendingMessage).toEqual({ id: 'command', text: 'Ready' });
  await remount(view(), true);
  expect(current.text).toBe('Ready');
  expect(current.entry).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not recover a send already acknowledged by the reopened server view', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  await remount(view(['command']), true);
  expect(current.text).toBe('');
  expect(current.entry).toBeNull();
});

it('preserves both unconfirmed text and a newer draft on reopening, then removes only the confirmed text', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  const lateFinish = current.finish;
  await act(async () => current.setText('New draft'));
  await remount(view());
  expect(current.text).toBe('Ready\n\nNew draft');
  await act(async () => current.observe(view(['command'])));
  expect(current.text).toBe('New draft');
  // The old component's failed response must not restore the acknowledged text.
  await act(async () => lateFinish('command', false, view([], `${study}-other`)));
  expect(current.text).toBe('New draft');
});

it('removes untouched recovered text when acknowledgement arrives late, but retains subsequent edits', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  await remount(view());
  expect(current.text).toBe('Ready');
  await act(async () => current.observe(view(['command'])));
  expect(current.text).toBe('');
  await act(async () => current.setText('Another answer'));
  await act(async () => current.begin(view(), 'next', 'Another answer'));
  await remount(view());
  await act(async () => current.setText('Edited recovery'));
  await act(async () => current.observe(view(['next'])));
  expect(current.text).toBe('Edited recovery');
});

it('retains a newly typed identical draft after recovery when acknowledgement arrives', async () => {
  await act(async () => current.begin(view(), 'command', 'Ready'));
  await remount(view());
  expect(current.text).toBe('Ready');
  await act(async () => current.setText('Ready'));
  await act(async () => current.observe(view(['command'])));
  expect(current.text).toBe('Ready');
});

it('surfaces failed text beside newer typing before a normal send can replace its recovery record', async () => {
  await act(async () => current.begin(view(), 'first', 'Ready'));
  await act(async () => current.setText('New draft'));
  await act(async () => current.finish('first', false, view()));
  expect(current.text).toBe('Ready\n\nNew draft');
  expect(readPendingMessage(study)).toMatchObject({
    id: 'first',
    text: 'Ready',
    recovery: { remainder: 'New draft' },
  });
  await act(async () => current.begin(view(), 'second', current.text));
  expect(current.text).toBe('');
  expect(readPendingMessage(study)).toEqual({ id: 'second', text: 'Ready\n\nNew draft' });
  await act(async () => current.finish('second', false, view()));
  expect(current.text).toBe('Ready\n\nNew draft');
  await remount(view(), true);
  expect(current.text).toBe('Ready\n\nNew draft');
});

it.each([false, true])(
  'keeps newer text when the original recovered command is retried (success: %s)',
  async (success) => {
    await act(async () => current.begin(view(), 'first', 'Ready'));
    await act(async () => current.setText('New draft'));
    await act(async () => current.finish('first', false, view()));
    expect(current.text).toBe('Ready\n\nNew draft');
    await act(async () => current.begin(view(), 'first', 'Ready'));
    expect(current.text).toBe('New draft');
    await act(async () => current.finish('first', success, view()));
    expect(current.text).toBe(success ? 'New draft' : 'Ready\n\nNew draft');
  },
);

it('removes only the failed text on a late receipt, preserving newer text through reload', async () => {
  await act(async () => current.begin(view(), 'first', 'Ready'));
  await act(async () => current.setText('New draft'));
  await act(async () => current.finish('first', false, view()));
  expect(current.text).toBe('Ready\n\nNew draft');
  await remount(view());
  await act(async () => current.observe(view(['first'])));
  expect(current.text).toBe('New draft');
  expect(readPendingMessage(study)).toBeUndefined();
  await remount(view(['first']), true);
  expect(current.text).toBe('New draft');
});

it('does not erase new identical typing when retrying a recovered command', async () => {
  await act(async () => current.begin(view(), 'first', 'Ready'));
  await act(async () => current.setText('Ready'));
  await act(async () => current.finish('first', false, view()));
  expect(current.text).toBe('Ready\n\nReady');
  await act(async () => current.begin(view(), 'first', 'Ready'));
  expect(current.text).toBe('Ready');
  await act(async () => current.finish('first', true, view()));
  expect(current.text).toBe('Ready');
});
