// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useLearnerMessage } from '@/components/scene-renderers/pbl/v3/use-learner-message';
import type { LearningView } from '@/lib/pbl/v3/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
let current: ReturnType<typeof useLearnerMessage> & {
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
};
const view = (ids: string[] = [], id = 'study') =>
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
  const [text, setText] = useState('Ready');
  const submission = useLearnerMessage(value, setText);
  useEffect(() => {
    current = { ...submission, text, setText };
  }, [submission, text]);
  return null;
}
beforeEach(async () => {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(Hook, { value: view(['earlier']) })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
    expect(current.text).toBe('New draft');
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
