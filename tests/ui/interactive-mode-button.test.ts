import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';

function renderButton(
  pressed: boolean,
  extraProps: Partial<ComponentProps<typeof InteractiveModeButton>> = {},
) {
  return renderToStaticMarkup(
    createElement(InteractiveModeButton, {
      pressed,
      label: 'Interactive Mode',
      onPressedChange: () => undefined,
      ...extraProps,
    }),
  );
}

describe('InteractiveModeButton markup contract', () => {
  it('emits explicit selected-state visual and semantic tokens', () => {
    const html = renderButton(true);

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('border-cyan-400 bg-cyan-100 text-cyan-900');
    expect(html).toContain('dark:border-cyan-200 dark:bg-cyan-400');
    expect(html).toContain('lucide-check');
  });

  it('emits a distinct unselected-state token set', () => {
    const html = renderButton(false);

    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('border-cyan-600 bg-transparent text-cyan-700');
    expect(html).toContain('dark:border-cyan-700 dark:text-cyan-300');
    expect(html).toContain('lucide-atom');
    expect(html).not.toContain('bg-cyan-100');
    expect(html).not.toContain('dark:bg-cyan-400');
  });

  it('forwards wrapper-injected attributes and classes to the DOM button', () => {
    const html = renderButton(false, {
      'aria-describedby': 'interactive-mode-hint',
      'data-state': 'closed',
      className: 'tooltip-trigger-class',
      title: 'Interactive mode hint',
    });

    expect(html).toContain('aria-describedby="interactive-mode-hint"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('tooltip-trigger-class');
    expect(html).toContain('title="Interactive mode hint"');
  });

  it('limits the dark breathing animation to motion-safe environments', () => {
    const selectedHtml = renderButton(true);
    const unselectedHtml = renderButton(false);

    expect(selectedHtml).toContain(
      'motion-safe:dark:animate-[interactive-mode-breathe_2s_ease-in-out_infinite]',
    );
    expect(selectedHtml).not.toContain(' dark:animate-[interactive-mode-breathe');
    expect(unselectedHtml).toContain('active:scale-95');
    expect(unselectedHtml).toContain('motion-reduce:active:scale-100');
    expect(unselectedHtml).toContain('motion-reduce:transition-none');
    expect(unselectedHtml).not.toContain('spin_3s_linear_infinite');
  });
});
