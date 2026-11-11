/**
 * Every script action has a designed card. The union's own `type` literals are
 * read from its source, so a new action cannot quietly fall back to the blank
 * circle: this fails until it has an icon, a colour and a label in every locale.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DESIGNED_CUE_TYPES,
  cueLabel,
  cueMeta,
  cueSummary,
} from '@/components/edit/ActionsBar/cue-meta';
import { Circle } from 'lucide-react';

const source = readFileSync(join(process.cwd(), 'packages/@openmaic/dsl/src/action.ts'), 'utf8');
const unionTypes = [...source.matchAll(/^\s*type: '([A-Za-z_]+)';/gm)].map((match) => match[1]!);

const LOCALES = join(process.cwd(), 'lib/i18n/locales');
const lookup = (tree: unknown, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree);

describe('script action display', () => {
  it('reads the whole union', () => {
    expect(unionTypes).toEqual(expect.arrayContaining(['speech', 'widget_setState', 'wb_clear']));
    expect(unionTypes.length).toBeGreaterThanOrEqual(21);
  });

  it.each(unionTypes)('%s has its own icon and tint', (type) => {
    expect(DESIGNED_CUE_TYPES).toContain(type);
    const meta = cueMeta(type);
    expect(meta.icon).not.toBe(Circle);
    expect(meta.glyph).toMatch(/dark:/);
  });

  it.each(readdirSync(LOCALES).filter((file) => file.endsWith('.json')))(
    '%s names every action',
    (file) => {
      const tree: unknown = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
      for (const type of unionTypes) {
        const label = lookup(tree, cueMeta(type).labelKey);
        expect(label, `${file} ${type}`).toEqual(expect.any(String));
        expect(label, `${file} ${type}`).not.toBe('');
      }
    },
  );

  it('gives an unknown type the generic card and a readable name', () => {
    expect(cueMeta('from_a_later_build').icon).toBe(Circle);
    expect(cueLabel('from_a_later_build', (key) => key)).toBe('edit.cue.action');
    expect(cueSummary({ type: 'from_a_later_build' })).toBe('');
    // Not fooled by what every object inherits.
    expect(cueMeta('constructor').icon).toBe(Circle);
  });

  it('sums an action up from its parameters, never as raw JSON', () => {
    const state = cueSummary({
      id: 'a',
      type: 'widget_setState',
      state: { age: 5, budget: 'mid', other: false, nested: { deep: 1 } },
    });
    expect(state).toBe('age 5 · budget mid · other ✗ · nested');
    expect(cueSummary({ id: 'a', type: 'widget_highlight', target: '#result-list' })).toBe(
      'result-list',
    );
    expect(cueSummary({ id: 'a', type: 'wb_close' })).toBe('');
    expect(cueSummary({ id: 'a', type: 'widget_setState', state: 'bad' as never })).toBe('');
    const long = cueSummary({
      id: 'a',
      type: 'wb_draw_text',
      content: `<p>${'x'.repeat(200)}</p>`,
      x: 0,
      y: 0,
    });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).not.toContain('<');
  });
});
