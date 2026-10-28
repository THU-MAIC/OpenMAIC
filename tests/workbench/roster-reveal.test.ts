// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => children };
});

import { RosterRevealVisualizer } from '@/components/generation/roster-reveal';
import type { RosterAgent } from '@/lib/workbench/request-schedule';

const agent = (id: string, name: string, role: string): RosterAgent => ({
  id,
  name,
  role,
  persona: `${name} persona`,
  avatar: `/avatars/${id}.png`,
  color: '#3b82f6',
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const revealed = () =>
  [...container.querySelectorAll('[data-testid="request-preview-roster-card"]')].map((card) =>
    card.getAttribute('data-revealed'),
  );

describe('the roster reveal in the preview', () => {
  it('uses the classic card and pace: heading, one flip every half second, the real cast', async () => {
    const cast = [
      agent('t', 'Ms Chen', 'teacher'),
      agent('a', 'Lin', 'student'),
      agent('b', 'Bo', 'student'),
    ];
    await act(async () => root.render(createElement(RosterRevealVisualizer, { agents: cast })));
    expect(container.textContent).toContain('generation.agentRevealTitle');
    expect(revealed()).toEqual(['false', 'false', 'false']);
    await act(async () => vi.advanceTimersByTime(400));
    expect(revealed()).toEqual(['true', 'false', 'false']);
    await act(async () => vi.advanceTimersByTime(500));
    expect(revealed()).toEqual(['true', 'true', 'false']);
    await act(async () => vi.advanceTimersByTime(500));
    expect(revealed()).toEqual(['true', 'true', 'true']);
    // The classic card's front: name, role chip, persona and avatar.
    expect(container.textContent).toContain('Ms Chen');
    expect(container.textContent).toContain('settings.agentRoles.teacher');
    expect(container.textContent).toContain('Ms Chen persona');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/t.png');
  });

  it('reveals a second cast of the same size afresh', async () => {
    const first = [agent('t', 'Ms Chen', 'teacher'), agent('a', 'Lin', 'student')];
    await act(async () => root.render(createElement(RosterRevealVisualizer, { agents: first })));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(revealed()).toEqual(['true', 'true']);
    const second = [agent('t2', 'Mr Wu', 'teacher'), agent('b', 'Bo', 'student')];
    await act(async () => root.render(createElement(RosterRevealVisualizer, { agents: second })));
    // Face down again, then the classic pace from the start.
    expect(revealed()).toEqual(['false', 'false']);
    expect(container.textContent).toContain('Mr Wu');
    await act(async () => vi.advanceTimersByTime(400));
    expect(revealed()).toEqual(['true', 'false']);
    await act(async () => vi.advanceTimersByTime(500));
    expect(revealed()).toEqual(['true', 'true']);
  });

  it('keeps its pace when the preview re-derives the roster on every tick', async () => {
    const cast = () => [agent('t', 'Ms Chen', 'teacher'), agent('a', 'Lin', 'student')];
    const tick = async () =>
      act(async () => root.render(createElement(RosterRevealVisualizer, { agents: cast() })));
    await tick();
    // A fresh array every 250 ms, as the live clock produces.
    for (let elapsed = 0; elapsed < 1000; elapsed += 250) {
      await act(async () => vi.advanceTimersByTime(250));
      await tick();
    }
    expect(revealed()).toEqual(['true', 'true']);
  });
});
