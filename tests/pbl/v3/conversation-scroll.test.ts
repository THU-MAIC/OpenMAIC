// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationViewport } from '@/components/scene-renderers/pbl/v3/conversation-scroll';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
let viewport: HTMLDivElement;
let contentHeight: number;
let viewportHeight: number;
let resize: () => void;

async function mount(height = 600) {
  contentHeight = height;
  viewportHeight = 200;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render();
  viewport = container.querySelector('.pbl-conversation-scroll')!;
  let position = 0;
  Object.defineProperties(viewport, {
    scrollTop: {
      get: () => position,
      set: (value: number) => {
        position = Math.max(0, Math.min(value, Math.max(0, contentHeight - viewportHeight)));
      },
    },
    scrollHeight: { get: () => contentHeight },
    clientHeight: { get: () => viewportHeight },
  });
  await act(async () => resize());
}
async function render(text = 'Streaming reply') {
  await act(async () =>
    root!.render(
      createElement(
        ConversationViewport,
        { generating: true, onClick: () => {} },
        createElement('p', null, text),
      ),
    ),
  );
}
async function grow() {
  contentHeight += 300;
  await act(async () => resize());
}
async function input(event: Event) {
  await act(async () => viewport.dispatchEvent(event));
}
async function scroll(top: number) {
  viewport.scrollTop = top;
  await input(new Event('scroll'));
}
async function latest() {
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

it('follows beyond the height of a reply and keeps following viewport resizes and content shrink', async () => {
  await mount();
  expect(viewport.scrollTop).toBe(400);
  await grow();
  expect(viewport.scrollTop).toBe(700);
  viewportHeight = 100;
  await act(async () => resize());
  expect(viewport.scrollTop).toBe(800);
  contentHeight = 500;
  await act(async () => resize());
  expect(viewport.scrollTop).toBe(400);
  await grow();
  expect(viewport.scrollTop).toBe(700);
});

it('keeps manual reading near or exactly at the tail across output, a new turn and resizes until Latest', async () => {
  await mount();
  await input(new WheelEvent('wheel', { deltaY: -30, bubbles: true }));
  await scroll(370);
  await input(new WheelEvent('wheel', { deltaY: 10, bubbles: true }));
  await scroll(380);
  await grow();
  expect(viewport.scrollTop).toBe(380);
  await render('Another agent turn');
  viewportHeight = 100;
  await grow();
  expect(viewport.scrollTop).toBe(380);
  await input(new WheelEvent('wheel', { deltaY: 1000, bubbles: true }));
  await scroll(contentHeight - viewportHeight);
  const manual = viewport.scrollTop;
  await grow();
  expect(viewport.scrollTop).toBe(manual);
  await latest();
  expect(viewport.scrollTop).toBe(contentHeight - viewportHeight);
  await grow();
  expect(viewport.scrollTop).toBe(contentHeight - viewportHeight);
});

it('yields immediately to touch, scrollbar and keyboard input, and accepts native forwarded scrolling', async () => {
  await mount();
  for (const event of [
    new Event('touchmove', { bubbles: true }),
    new MouseEvent('pointerdown', { bubbles: true }),
    new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }),
  ]) {
    const before = viewport.scrollTop;
    await input(event);
    await grow();
    expect(viewport.scrollTop).toBe(before);
    await latest();
  }
  await scroll(viewport.scrollTop - 80);
  const native = viewport.scrollTop;
  await grow();
  expect(viewport.scrollTop).toBe(native);
});

it('keeps following for ordinary bubble clicks', async () => {
  await mount();
  await act(async () => container.querySelector('p')!.click());
  await grow();
  expect(viewport.scrollTop).toBe(contentHeight - viewportHeight);
});

it('follows content that arrives after an empty mount', async () => {
  await mount(0);
  await input(new MouseEvent('pointerdown', { bubbles: true }));
  contentHeight = 1200;
  await act(async () => resize());
  expect(viewport.scrollTop).toBe(1000);
});
