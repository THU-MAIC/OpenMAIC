// @vitest-environment jsdom

/**
 * One control, one place.
 *
 * The seam between the conversation and the classroom used to carry the folds for
 * BOTH panes: two mutually-reversed chevrons at the same height, a centimetre
 * apart, and a third one (the slide navigator's own fold, at the classroom's left
 * edge) right beside them. Nothing said which panel any of them meant.
 *
 * So: the seam resizes and nothing else, and each pane folds from its own header.
 * The navigation rail was the last exception — it was held to have no header, so
 * its fold stayed a pill floating in the middle of its own seam, which is the
 * same line that drags the rail's width. It has a header: the row carrying the
 * wordmark and the PRO pill. Its fold is anchored to that row's trailing edge,
 * and EVERY seam on the surface means exactly one thing.
 *
 * What is pinned here is that split — plus the fold SEMANTICS, which did not
 * change: who may fold, and that the last visible pane may not (that half lives
 * in `workspace-panes.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ResizeHandle } from '@/components/workbench/workspace/ResizeHandle';
import { PaneFoldButton } from '@/components/workbench/workspace/PaneFoldButton';

beforeAll(() => {
  // jsdom has no pointer-capture API; the handle calls it unconditionally.
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.documentElement.removeAttribute('data-ws-resizing');
});

function pointerEvent(type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return container;
}

async function renderSeam(withSiblingGrip = false) {
  const calls = { commit: 0, reset: 0, siblingGrip: 0 };
  const host = mount();
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(ResizeHandle, {
        testId: 'seam',
        label: 'resize the conversation',
        edge: 'right',
        current: () => 400,
        clamp: (width: number) => width,
        onPreview: () => undefined,
        onCommit: () => {
          calls.commit += 1;
        },
        onReset: () => {
          calls.reset += 1;
        },
      }),
    );
  });
  if (withSiblingGrip) {
    // A control planted beside the seam, as the rail's collapse grip used to be.
    // The seam must now ignore it completely: a press released without moving is
    // not a fold any more, from anywhere.
    const grip = document.createElement('button');
    grip.className = 'ws-grip-right';
    grip.addEventListener('click', () => {
      calls.siblingGrip += 1;
    });
    host.append(grip);
  }
  return { host, calls };
}

describe('the pane seam', () => {
  it('carries no fold control — only the resize thread', async () => {
    const { host } = await renderSeam();
    const seam = host.querySelector('[data-testid="seam"]') as HTMLElement;

    expect(seam).not.toBeNull();
    expect(seam.querySelector('button')).toBeNull();
    expect(host.querySelectorAll('.ws-grip')).toHaveLength(0);
    expect(seam.querySelector('.ws-resize-thread')).not.toBeNull();
    // Its accessible name is about width, and now that is all it does.
    expect(seam.getAttribute('aria-label')).toBe('resize the conversation');
  });

  it('still resizes on drag and resets on double click', async () => {
    const { host, calls } = await renderSeam();
    const seam = host.querySelector('[data-testid="seam"]') as HTMLElement;

    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 100 }));
    });
    expect(calls.commit).toBe(1);

    await act(async () => {
      seam.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(calls.reset).toBe(1);
  });

  it('folds nothing on a short click, with or without a control beside it', async () => {
    // The rail's fold used to be reachable this way, which is how one line came
    // to mean both "resize me" and "collapse me".
    const withGrip = await renderSeam(true);
    const seam = withGrip.host.querySelector('[data-testid="seam"]') as HTMLElement;
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown'));
      seam.dispatchEvent(pointerEvent('pointerup'));
    });
    expect(withGrip.calls).toMatchObject({ siblingGrip: 0, commit: 0 });

    if (root) await act(async () => root?.unmount());
    container?.remove();

    const alone = await renderSeam(false);
    const lonelySeam = alone.host.querySelector('[data-testid="seam"]') as HTMLElement;
    await act(async () => {
      lonelySeam.dispatchEvent(pointerEvent('pointerdown'));
      lonelySeam.dispatchEvent(pointerEvent('pointerup'));
    });
    expect(alone.calls).toMatchObject({ siblingGrip: 0, commit: 0 });
  });
});

describe('a pane’s own fold button', () => {
  it('is one labelled control pointing the way the pane leaves', async () => {
    let folded = 0;
    const host = mount();
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(PaneFoldButton, {
          testId: 'chat-fold',
          label: '收起对话',
          direction: 'left',
          onClick: () => {
            folded += 1;
          },
        }),
      );
    });

    const button = host.querySelector('[data-testid="chat-fold"]') as HTMLButtonElement;
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(button.getAttribute('aria-label')).toBe('收起对话');
    expect(button.getAttribute('title')).toBe('收起对话');
    expect(button.querySelector('svg')).not.toBeNull();

    await act(async () => button.click());
    expect(folded).toBe(1);
  });
});

/**
 * Where each fold button is MOUNTED is a fact about the panes' JSX, and the
 * regression to guard is somebody moving one back onto the seam.
 */
describe('fold placement', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('puts the conversation’s fold in its own header', () => {
    const source = read('components/workbench/workspace/WorkspaceChatPane.tsx');
    const header = source.indexOf('<header');
    const headerEnd = source.indexOf('</header>');
    const fold = source.indexOf('workspace-chat-fold');

    expect(fold).toBeGreaterThan(header);
    expect(fold).toBeLessThan(headerEnd);
  });

  it('puts the classroom’s fold at the seam side of its header, before the tabs', () => {
    const source = read('components/workbench/workspace/WorkspaceClassroomPane.tsx');
    const header = source.indexOf('<header');
    const headerEnd = source.indexOf('</header>');
    const fold = source.indexOf('workspace-classroom-fold');
    const tabs = source.indexOf('<WorkspaceCourseTabs');

    // In the header…
    expect(fold).toBeGreaterThan(header);
    expect(fold).toBeLessThan(headerEnd);
    // …and at its LEFT end (near the seam), ahead of the course tab strip — so it
    // flanks the seam opposite the conversation's fold rather than sitting far
    // right by the window edge.
    expect(fold).toBeLessThan(tabs);
  });

  it('wires the classroom fold from the shell, so the button actually renders', () => {
    // The regression: the header had a fold button, but the shell never passed
    // `onCollapse`, so it was gated out and the classroom had no visible collapse
    // entry (its title row showed only the tab and its close ×).
    const shell = read('components/workbench/workspace/WorkspaceShell.tsx');
    const open = shell.indexOf('<WorkspaceClassroomPane');
    const close = shell.indexOf('/>', open);
    const props = shell.slice(open, close);
    expect(props).toContain('onCollapse=');
  });

  it('keeps classroom visibility outside the attached-chat fold', () => {
    const pane = read('components/workbench/workspace/WorkspaceClassroomPane.tsx');
    const chatPane = read('components/workbench/workspace/WorkspaceChatPane.tsx');
    const shell = read('components/workbench/workspace/WorkspaceShell.tsx');

    // Each pane has its own state writer and receives only its own callback.
    // Closing or reopening chat therefore cannot mutate classroom visibility.
    expect(shell).toContain('setChat(true)');
    expect(shell).toContain('setChat(false)');
    expect(shell).toContain('setClassroom(true)');
    expect(shell).toContain('setClassroom(false)');
    expect(shell).toContain('collapse.collapseChat');
    expect(shell).toContain('collapse.collapseClassroom');
    expect(pane).toContain('<WorkbenchPanelProvider visible={!hidden} playback={playback}>');
    expect(chatPane).toContain('<WorkbenchChat hosted adjacentPanelOpen={!fill} />');
    expect(shell).not.toContain('panelOpen !== classroomVisible');
  });

  it('memoizes the classroom pane and its browser seam across chat-only renders', () => {
    const pane = read('components/workbench/workspace/WorkspaceClassroomPane.tsx');
    const shell = read('components/workbench/workspace/WorkspaceShell.tsx');

    expect(pane).toContain('memo(function WorkspaceClassroomPane');
    expect(shell).toContain('const classroomBrowser = useMemo(');
    expect(shell).toContain('browser={classroomBrowser}');
  });

  it('anchors the rail’s fold to the trailing edge of its header, not beside the logo', () => {
    const rail = read('components/workbench/workspace/WorkspaceRail.tsx');
    // The header row owns all three controls, but auto margin pushes the fold
    // to the rail boundary instead of pinning it beside the PRO badge.
    const row =
      /<div className="flex h-16 shrink-0 items-center gap-2 px-4">([\s\S]*?)<\/div>/.exec(rail);
    expect(row, 'the rail’s header row').not.toBeNull();
    expect(row![1]).toContain('testId="pro-nav-home"');
    expect(row![1]).toContain('<ProBadge');
    expect(row![1]).toContain('testId="pro-nav-collapse"');
    expect(row![1]).toContain('className="ml-auto"');
    expect(row![1].indexOf('pro-nav-collapse')).toBeGreaterThan(row![1].indexOf('<ProBadge'));

    // And it is the same button the other two panes fold with — one fold
    // language, not a rail-specific grip.
    expect(rail).toContain("import { PaneFoldButton } from './PaneFoldButton'");
    expect(rail).not.toContain('PaneCollapseGrip');
  });

  it('leaves nothing on any seam to collapse anything', () => {
    const shell = read('components/workbench/workspace/WorkspaceShell.tsx');
    const handle = read('components/workbench/workspace/ResizeHandle.tsx');
    const rail = read('components/workbench/workspace/WorkspaceRail.tsx');

    // The shell's only `onCollapse` props go to the two content panes.
    for (const dead of ['collapseLabel', 'onCollapseLeading', 'collapseLeadingLabel']) {
      expect(shell).not.toContain(dead);
      expect(handle).not.toContain(dead);
    }
    expect(handle).not.toContain('ws-resize-grip');
    // The handle no longer reaches for a collapse control beside it, and the
    // grip it used to find does not exist in the product at all.
    expect(handle).not.toContain('ws-grip');
    expect(handle).not.toContain('collapseTarget');
    expect(rail).not.toContain('ws-grip');
    const css = read('components/workbench/workspace-shell.css');
    expect(css).not.toContain('.ws-grip');
    // The rail's seam is built by the shell, and its accessible name is about
    // width — which is now all it does.
    const seam = shell.slice(shell.indexOf('pro-rail-resize-handle'));
    expect(seam.slice(0, seam.indexOf('/>'))).toContain("label={t('workspace.resizeAria')}");
  });

  /**
   * COLLAPSED, the top brand is replaced by an explicit expand action in the
   * same header slot. Destination glyphs still expand into their own sections.
   */
  it('replaces the collapsed wordmark with an explicit expand button', () => {
    const rail = read('components/workbench/workspace/WorkspaceRail.tsx');
    const mini = rail.slice(rail.indexOf('pro-nav-rail-mini'), rail.indexOf('renderCourseRow'));

    expect(mini).toContain('testId="pro-nav-expand"');
    expect(mini).toContain("label={t('workspace.expandNav')}");
    expect(mini).toContain('direction="right"');
    expect(mini).toContain('onClick={onToggleCollapsed}');
    expect(mini).not.toContain('pro-nav-home-mini');
    // The strip is the list of destinations, and saved courses are not one any
    // more: the drawer is gone, so there is no glyph that opens it.
    expect(mini).not.toContain('pro-nav-mini-saved');

    // Each destination glyph expands, and says so on top of naming its tab.
    for (const glyph of ['pro-nav-mini-sessions', 'pro-nav-mini-courses']) {
      const button = new RegExp(`data-testid="${glyph}"[\\s\\S]*?/>\\s*</button>`).exec(mini);
      expect(button, glyph).not.toBeNull();
      expect(button![0], glyph).toContain('expandLabel(');
      expect(button![0], glyph).toContain('aria-expanded={false}');
      expect(button![0], glyph).toContain('expandInto(');
    }
  });
});
