/**
 * A rail row's metadata slot (the running spinner or the timestamp) gives way
 * to the row's ⋯ action on hover, and when that action has focus. A click on a
 * chat row leaves focus on the row button, which reveals no action, so hiding
 * the slot on any focus inside the row blanked the open chat's spinner.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(process.cwd(), 'components/workbench/workspace-shell.css'),
  'utf8',
);

describe('rail row metadata slot', () => {
  it('keeps a focused row its status mark: only the focused ⋯ action takes the slot', () => {
    const rules = [...css.matchAll(/([^{}]*)\{[^}]*opacity:\s*0;[^}]*\}/g)]
      .map((match) => match[1])
      .filter((selector) => selector.includes('.ws-row-meta'));
    expect(rules.length).toBeGreaterThan(0);
    for (const selector of rules) {
      expect(selector).not.toMatch(/ws-row-wrap[\w-]*:focus-within\s+\.ws-row-meta/);
    }
    expect(css).toContain(
      '.ws-row-wrap-actionable:has(.ws-row-trailing:focus-within) .ws-row-meta',
    );
  });

  it('keeps the :has() selector in its own rule, so an engine without it keeps the hover rule', () => {
    const selectorOf = (selector: string) => selector.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const rules = [...css.matchAll(/([^{}]*)\{[^}]*\}/g)].map((match) => selectorOf(match[1]));
    const hover = rules.filter((selector) => selector.includes('.ws-row-wrap-actionable:hover'));
    expect(hover.length).toBeGreaterThan(0);
    for (const selector of hover) expect(selector).not.toContain(':has(');
    const metaHas = rules.filter((r) => r.includes(':has(') && r.includes('.ws-row-meta'));
    expect(metaHas.length).toBeGreaterThan(0);
    for (const selector of metaHas) {
      expect(selector.split(',')).toHaveLength(1);
    }
  });
});
