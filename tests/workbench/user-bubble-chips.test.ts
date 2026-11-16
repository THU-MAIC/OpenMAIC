// @vitest-environment jsdom
/**
 * A sent message's tokens: the composer's chips, by the composer's rule. What was
 * written stays what is copied, and what no longer resolves stays as written.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const skills = [{ id: 's1', name: 'deep-interactive', title: 'Deep', source: 'builtin' }];

async function mount(props: Record<string, unknown>) {
  const { UserBubble } = await import('@/components/workbench/chat/user-bubble');
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(createElement(UserBubble, props as never)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(skills)),
  );
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a sent message', () => {
  it('draws a handle and the mentions it names as chips, in place', async () => {
    const container = await mount({
      text: '/deep-interactive compare @Fractions with @notes.pdf',
      courseRefs: [{ kind: 'course', stageId: 'stage-1', title: 'Fractions' }],
      materials: ['notes.pdf'],
    });
    const chips = [...container.querySelectorAll<HTMLElement>('.composer-chip')];
    expect(chips.map((chip) => [chip.dataset.chip, chip.dataset.plain])).toEqual([
      ['skill', '/deep-interactive'],
      ['course', '@Fractions'],
      ['material', '@notes.pdf'],
    ]);
    expect(chips[1]!.textContent).toBe('Fractions');
    // Named in the sentence, so no receipt below it as well.
    expect(container.querySelector('[data-testid="user-bubble-course-ref"]')).toBeNull();
  });

  it('keeps the same chips in the primary tone, marked for their on-primary skin', async () => {
    const container = await mount({ text: '/deep-interactive please', tone: 'primary' });
    const chip = container.querySelector<HTMLElement>('[data-testid="user-bubble-skill"]');
    expect(chip?.closest('[data-tone="primary"]')?.className).toContain('bg-primary');
  });

  it('draws the default bubble without a tone', async () => {
    const container = await mount({ text: 'hello' });
    expect(container.querySelector('[data-tone]')).toBeNull();
    expect(container.querySelector('.bg-primary')).toBeNull();
    expect(container.querySelector('.bg-violet-100')).not.toBeNull();
  });

  it('leaves what does not resolve as written', async () => {
    const container = await mount({ text: '/deleted-skill and @Gone stay as they are' });
    expect(container.querySelector('.composer-chip')).toBeNull();
    expect(container.textContent).toContain('/deleted-skill and @Gone stay as they are');
  });

  it('keeps the handles a message was written with while the skill list is out', async () => {
    await (await mount({ text: '/deep-interactive once' })).remove();
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const container = await mount({ text: '/deep-interactive again' });
    expect(container.querySelector('.composer-chip')?.getAttribute('data-plain')).toBe(
      '/deep-interactive',
    );
  });

  it('copies what was written, not what the chip shows', async () => {
    const container = await mount({ text: '/deep-interactive please\nnext line' });
    const chip = container.querySelector('.composer-chip')!;
    const line = chip.parentElement!;
    const range = document.createRange();
    range.selectNodeContents(line);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const written: Record<string, string> = {};
    const copy = new Event('copy', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { setData: (type: string, value: string) => void };
    };
    copy.clipboardData = { setData: (type, value) => (written[type] = value) };
    await act(async () => void line.dispatchEvent(copy));
    expect(written['text/plain']).toBe('/deep-interactive please\nnext line');
    expect(copy.defaultPrevented).toBe(true);
  });
});
