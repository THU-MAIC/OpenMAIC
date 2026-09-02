/**
 * The two pane headers are one row across the seam.
 *
 * The conversation's header (title + status word + ◀) and the classroom's
 * (tab strip + start-learning + ▶) are different objects, and while each
 * carried its own `height` they drifted: 44px against 42px, which shows up as
 * a bottom hairline that visibly steps at the seam and two fold chevrons that
 * are not on one baseline. The fix is structural — a single height token,
 * declared once, consumed by the class both headers share — so this checks the
 * STRUCTURE rather than re-stating the pixel value (a test that repeated the
 * number would be a second place to update, i.e. the bug again).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const css = read('components/workbench/workspace-shell.css');
const chatPane = read('components/workbench/workspace/WorkspaceChatPane.tsx');
const classroomPane = read('components/workbench/workspace/WorkspaceClassroomPane.tsx');

const HEIGHT_TOKEN = '--ws-pane-head-h';

/** The declarations inside one rule, by exact selector. */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const match = pattern.exec(css);
  expect(match, `missing rule in workspace-shell.css: ${selector}`).not.toBeNull();
  return match![2]!;
}

const declaredHeights = (body: string): string[] =>
  [...body.matchAll(/(?:^|;)\s*height\s*:\s*([^;]+)/g)].map((match) => match[1]!.trim());

describe('pane header height has one source', () => {
  it('declares the token exactly once', () => {
    const declarations = [...css.matchAll(new RegExp(`${HEIGHT_TOKEN}\\s*:`, 'g'))];
    expect(declarations).toHaveLength(1);
  });

  it('sizes the shared pane-header class from the token, not a literal', () => {
    expect(declaredHeights(ruleBody('.ws-pane-head'))).toEqual([`var(${HEIGHT_TOKEN})`]);
  });

  it('leaves the classroom header no height of its own', () => {
    // The classroom's own rule may still tune its gap; the moment it re-declares
    // a height the seam hairline steps again.
    expect(declaredHeights(ruleBody('.ws-classroom-head'))).toEqual([]);
  });
});

describe('both pane headers consume it', () => {
  it('gives each pane header the shared class', () => {
    for (const [name, source] of [
      ['WorkspaceChatPane', chatPane],
      ['WorkspaceClassroomPane', classroomPane],
    ] as const) {
      const header = /<header[\s\S]*?>/.exec(source);
      expect(header, `${name} must render a pane header`).not.toBeNull();
      expect(header![0], `${name}'s header must carry ws-pane-head`).toContain('ws-pane-head');
      // A height on the element would outrank the stylesheet and re-split them.
      expect(header![0]).not.toMatch(/\bh-\[|\bh-\d|height:/);
      // What puts the title, the status word and the fold chevron on the same
      // baseline in whatever height the token says.
      expect(header![0], `${name}'s header must centre its row`).toContain('items-center');
    }
  });
});
