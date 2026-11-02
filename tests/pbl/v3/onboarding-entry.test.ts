// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchOnboarding } from '@/components/scene-renderers/pbl/v3/use-workbench-onboarding';
import { ONBOARDING_STORAGE_KEY } from '@/lib/pbl/v3/onboarding';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, container: HTMLDivElement, root: Root;
let owner: { current: HTMLElement | null };
let guide: ReturnType<typeof useWorkbenchOnboarding>;
type EntryProps = {
  ready?: boolean;
  available?: boolean;
  blocked?: boolean;
  completed?: boolean;
  studyId?: string;
};
function Harness({
  ready = false,
  available = ready,
  blocked = false,
  completed = false,
  studyId = 'study-a',
}: EntryProps) {
  const current = useWorkbenchOnboarding({
    root: owner,
    studyId,
    autoStart: true,
    ready,
    available,
    blocked,
    completed,
  });
  useEffect(() => {
    guide = current;
  });
  return null;
}
async function render(props: EntryProps = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
beforeEach(() => {
  host = document.createElement('div');
  host.innerHTML = '<textarea>Keep my draft</textarea>';
  document.body.append(host);
  owner = { current: host };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  container.remove();
  vi.unstubAllGlobals();
});

it('takes modal ownership at readiness before any animation-frame input gap', async () => {
  await render();
  expect(guide.active).toBe(false);
  await render({ ready: true });
  expect(guide.active).toBe(true);
});
it('ignores legacy browser completion and preserves existing text', async () => {
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'seen');
  await render({ ready: true });
  expect(guide.active).toBe(true);
  expect(host.querySelector('textarea')!.value).toBe('Keep my draft');
});
it('resumes incomplete entry after errors both before and after the guide opens', async () => {
  await render({ ready: true, blocked: true });
  expect(guide.active).toBe(false);
  await render({ ready: true });
  expect(guide.active).toBe(true);
  await render({ ready: true, blocked: true });
  expect(guide.active).toBe(false);
  await render({ ready: true });
  expect(guide.active).toBe(true);
});
it('holds the current guide through transient metadata and stream reconnection', async () => {
  await render({ ready: true });
  await render({ ready: false, available: true });
  expect(guide.active).toBe(true);
  await render({ ready: true });
  expect(guide.active).toBe(true);
});
it('resumes an incomplete guide after real environment recovery', async () => {
  await render({ ready: true });
  await render();
  expect(guide.active).toBe(false);
  await render({ ready: true });
  expect(guide.active).toBe(true);
});
it('does not auto-open acknowledged studies, while manual replay remains available', async () => {
  await render({ ready: true, completed: true });
  expect(guide.active).toBe(false);
  await act(async () => guide.replay());
  expect(guide.active).toBe(true);
  await act(async () => guide.close());
  expect(guide.active).toBe(false);
});
it('keeps a successful finish closed before SSE catches up, without exempting another study', async () => {
  await render({ ready: true });
  await act(async () => guide.close());
  expect(guide.active).toBe(false);
  await render({ ready: true });
  expect(guide.active).toBe(false);
  await render({ ready: true, studyId: 'another-owner-or-project' });
  expect(guide.active).toBe(true);
});
