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
import {
  ResizeHandle,
  RESIZE_FOLD_HYSTERESIS,
} from '@/components/workbench/workspace/ResizeHandle';
import {
  createResizeDragOwner,
  type ResizeDragOwner,
} from '@/components/workbench/workspace/resize-drag-owner';
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

// A move carries the held primary button: a move with none means the pointer
// was released where the window could not hear it.
function pointerEvent(type: string, init: MouseEventInit = {}) {
  const buttons = type === 'pointermove' ? 1 : 0;
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, ...init });
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

describe('drag-to-collapse on a seam (live, one gesture)', () => {
  async function renderFoldableSeam(folded = false, drag?: ResizeDragOwner) {
    const calls = {
      commit: [] as number[],
      preview: [] as number[],
      events: [] as string[],
    };
    const host = mount();
    if (folded) host.style.width = '60px';
    await act(async () => {
      root?.render(
        createElement(ResizeHandle, {
          testId: 'rail-seam',
          label: 'resize the rail',
          edge: 'right',
          current: () => 280,
          clamp: (width: number) => Math.min(360, Math.max(200, width)),
          onPreview: (width: number) => calls.preview.push(width),
          onCommit: (width: number) => calls.commit.push(width),
          onReset: () => undefined,
          collapseBelow: 120,
          onCollapse: () => calls.events.push('collapse'),
          onExpand: () => calls.events.push('expand'),
          folded,
          drag,
        }),
      );
    });
    const seam = host.querySelector('[data-testid="rail-seam"]') as HTMLElement;
    return { seam, calls };
  }

  it('folds the moment the drag passes the threshold, and keeps the remembered width', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 50 }));
    });
    // 150px: past the minimum, not past the threshold — held at the minimum.
    expect(calls.events).toEqual([]);
    expect(calls.preview.at(-1)).toBe(200);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    });
    // Folded mid-drag, before any release; the width goes back to 280.
    expect(calls.events).toEqual(['collapse']);
    expect(calls.preview.at(-1)).toBe(280);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 }));
    });
    expect(calls.commit).toEqual([]);
  });

  it('unfolds when the same drag comes back out, then follows the pointer', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 330, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 330, clientY: 50 }));
    });
    expect(calls.events).toEqual(['collapse', 'expand']);
    expect(calls.preview.at(-1)).toBe(330);
    expect(calls.commit).toEqual([330]);
  });

  it('does not flicker at the boundary: unfolding needs the hysteresis margin', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 119, clientY: 50 }));
      // Back to just over the threshold, inside the margin: still folded.
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 124, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 118, clientY: 50 }));
    });
    expect(calls.events).toEqual(['collapse']);
    await act(async () => {
      seam.dispatchEvent(
        pointerEvent('pointermove', { clientX: 120 + RESIZE_FOLD_HYSTERESIS, clientY: 50 }),
      );
    });
    expect(calls.events).toEqual(['collapse', 'expand']);
  });

  it('starts from a folded pane’s edge and unfolds outward, following the pointer', async () => {
    const { seam, calls } = await renderFoldableSeam(true);
    await act(async () => {
      // jsdom has no layout: the folded pane's width reads as 0 here.
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 60, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    });
    expect(calls.events).toEqual([]);
    await act(async () => {
      seam.dispatchEvent(
        pointerEvent('pointermove', { clientX: 60 + 120 + RESIZE_FOLD_HYSTERESIS, clientY: 50 }),
      );
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 60 + 260, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 60 + 260, clientY: 50 }));
    });
    expect(calls.events).toEqual(['expand']);
    expect(calls.commit).toEqual([260]);
  });

  it('a click on a folded pane’s edge does nothing', async () => {
    const { seam, calls } = await renderFoldableSeam(true);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 60, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 60, clientY: 50 }));
    });
    expect(calls.events).toEqual([]);
    expect(calls.commit).toEqual([]);
  });

  it('still widens outward, up to the clamp', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 320, clientY: 50 }));
    });
    expect(calls.preview.at(-1)).toBe(320);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 500, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 500, clientY: 50 }));
    });
    expect(calls.commit).toEqual([360]);
    expect(calls.events).toEqual([]);
  });

  it('leaves things as they are when the pointer is cancelled', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointercancel', { clientX: 40, clientY: 50 }));
    });
    // Folded at that moment: it stays folded, nothing is undone or committed.
    expect(calls.events).toEqual(['collapse']);
    expect(calls.commit).toEqual([]);
  });

  it('an open drag that is cancelled keeps the width it reached', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointercancel', { clientX: 300, clientY: 50 }));
    });
    expect(calls.commit).toEqual([300]);
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
  });

  it('keeps tracking after the handle unmounts mid-drag, under an owner that outlives it', async () => {
    // The shell's owner: it outlives the rail's edges.
    const owner = createResizeDragOwner();
    const { seam, calls } = await renderFoldableSeam(false, owner);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
    });
    await act(async () => root?.render(createElement('div')));
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 300, clientY: 50 }));
    });
    expect(calls.commit).toEqual([300]);
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
    // Ended on its own: the owner holds nothing to abort any more.
    owner.abort();
    expect(calls.commit).toEqual([300]);
  });

  it('aborts the drag as its owner unmounts, without committing', async () => {
    const { seam, calls } = await renderFoldableSeam();
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
    });
    // No owner given: the handle owns its drag.
    await act(async () => root?.render(createElement('div')));
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 320, clientY: 50 }));
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 320, clientY: 50 }));
    });
    expect(calls.preview).toEqual([300]);
    expect(calls.commit).toEqual([]);
  });

  it('an owner that outlives the handle aborts the drag when it goes', async () => {
    const owner = createResizeDragOwner();
    const { seam, calls } = await renderFoldableSeam(false, owner);
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
    });
    await act(async () => root?.render(createElement('div')));
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(true);
    owner.abort();
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 300, clientY: 50 }));
    expect(calls.commit).toEqual([]);
  });

  describe('ends a drag released outside the window', () => {
    async function dragTo300() {
      const { seam, calls } = await renderFoldableSeam();
      await act(async () => {
        seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
        window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 50 }));
      });
      expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(true);
      return { seam, calls };
    }

    async function expectEndedAt300(calls: { commit: number[]; preview: number[] }) {
      expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
      expect(calls.commit).toEqual([300]);
      // A stale drag does not continue on later events with the same pointer.
      await act(async () => {
        window.dispatchEvent(pointerEvent('pointermove', { clientX: 340, clientY: 50 }));
        window.dispatchEvent(pointerEvent('pointerup', { clientX: 340, clientY: 50 }));
      });
      expect(calls.preview).toEqual([300]);
      expect(calls.commit).toEqual([300]);
    }

    it('when the pointer comes back with no button held', async () => {
      const { seam, calls } = await dragTo300();
      await act(async () => {
        window.dispatchEvent(
          pointerEvent('pointermove', { clientX: 360, clientY: 50, buttons: 0 }),
        );
      });
      expect(seam.hasAttribute('data-ws-drag')).toBe(false);
      await expectEndedAt300(calls);
    });

    it('when the window loses focus', async () => {
      const { calls } = await dragTo300();
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });
      await expectEndedAt300(calls);
    });

    it('when the page is hidden', async () => {
      const { calls } = await dragTo300();
      const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      try {
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
        if (visibility) expect(document.visibilityState).toBe('visible');
      }
      await expectEndedAt300(calls);
    });
  });

  it('sets the document resizing flag once per drag, not once per move', async () => {
    const { seam } = await renderFoldableSeam();
    // Each mutation's value before it: absent, then set, and nothing else.
    const before: (string | null)[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) before.push(record.oldValue);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-ws-resizing'],
    });
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 280, clientY: 50 }));
      // Within range, across the fold, and back out again.
      for (const x of [300, 250, 200, 150, 100, 60, 100, 200, 300, 320]) {
        window.dispatchEvent(pointerEvent('pointermove', { clientX: x, clientY: 50 }));
      }
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 320, clientY: 50 }));
    });
    await Promise.resolve();
    observer.disconnect();
    expect(before).toEqual([null, 'true']);
    expect(document.documentElement.hasAttribute('data-ws-resizing')).toBe(false);
  });

  it('never gates the rail’s entrance fade on the per-drag resizing flag', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    // An animation switched off while `[data-ws-resizing]` is set replays when
    // the flag clears: the rail faded in from nothing at the end of every drag.
    const css = read('components/workbench/workspace-shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/\[data-ws-resizing\][^{]*\.ws-enter-rail/);
    // Instead the rail decides as it mounts: a drag-unfolded rail has no fade.
    const rail = read('components/workbench/workspace/WorkspaceRail.tsx');
    expect(rail).toContain("fadeIn && 'ws-enter-rail'");
    expect(rail).not.toMatch(/className="[^"]*ws-enter-rail/);
    const shell = read('components/workbench/workspace/WorkspaceShell.tsx');
    expect(shell).toContain('fadeIn={!railUnfoldedByDrag}');
    const expand = shell.slice(shell.indexOf('const expandRail'));
    expect(expand.slice(0, expand.indexOf('}, []);'))).toContain('setRailUnfoldedByDrag(true)');
  });

  it('never folds a seam that did not opt in', async () => {
    const { host, calls } = await renderSeam();
    const seam = host.querySelector('[data-testid="seam"]') as HTMLElement;
    await act(async () => {
      seam.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointermove', { clientX: 0, clientY: 50 }));
      seam.dispatchEvent(pointerEvent('pointerup', { clientX: 0, clientY: 50 }));
    });
    expect(calls.commit).toBe(1);
  });

  it('is wired on the rail seams only, folding and unfolding through the rail’s own toggle', () => {
    const shell = readFileSync(
      resolve(process.cwd(), 'components/workbench/workspace/WorkspaceShell.tsx'),
      'utf8',
    );
    const railSeam = shell.slice(shell.indexOf('pro-rail-resize-handle'));
    const railProps = railSeam.slice(0, railSeam.indexOf('/>'));
    expect(railProps).toContain('collapseBelow={RAIL_COLLAPSE_THRESHOLD}');
    expect(railProps).toContain('onCollapse={collapseRail}');
    expect(railProps).toContain('onExpand={expandRail}');
    const miniSeam = shell.slice(shell.indexOf('pro-rail-mini-resize-handle'));
    const miniProps = miniSeam.slice(0, miniSeam.indexOf('/>'));
    expect(miniProps).toContain('folded');
    expect(miniProps).toContain('onExpand={expandRail}');
    // Both rail edges hand their drag to the shell, which outlives the swap.
    expect(railProps).toContain('drag={railDrag}');
    expect(miniProps).toContain('drag={railDrag}');
    expect(shell).toContain('const railDrag = useResizeDragOwner();');
    // The chat seam stays a pure resize.
    expect(shell.match(/collapseBelow=/g)).toHaveLength(2);
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
    expect(pane).toContain(
      '<WorkbenchPanelProvider visible={!hidden} learning={learning} historySlot={historySlot}>',
    );
    // The chat learns only whether a pane sits beside it, never the
    // classroom's own visibility (it also carries the knowledge base hand-over).
    const chatElement = chatPane.slice(
      chatPane.indexOf('<WorkbenchChat'),
      chatPane.indexOf('/>', chatPane.indexOf('<WorkbenchChat')),
    );
    expect(chatElement).toContain('adjacentPanelOpen={!fill}');
    expect(chatElement).not.toMatch(/\b(panelOpen|visible|hidden)=|classroom/i);
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
    // The header row owns the wordmark and the fold, and auto margin pushes
    // the fold to the rail boundary instead of pinning it beside the logo.
    const row =
      /<div className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-3">([\s\S]*?)<\/div>/.exec(
        rail,
      );
    expect(row, 'the rail’s header row').not.toBeNull();
    expect(row![1]).toContain('testId="pro-nav-home"');
    expect(row![1]).toContain('testId="pro-nav-collapse"');
    expect(row![1]).toContain('className="ml-auto"');
    expect(row![1].indexOf('pro-nav-collapse')).toBeGreaterThan(row![1].indexOf('pro-nav-home'));

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
  it('keeps an explicit expand button and the same items as the expanded rail', () => {
    const rail = read('components/workbench/workspace/WorkspaceRail.tsx');
    const mini = rail.slice(rail.indexOf('pro-nav-rail-mini'), rail.indexOf('renderCourseRow'));

    expect(mini).toContain('testId="pro-nav-expand"');
    expect(mini).toContain("label={t('workspace.expandNav')}");
    expect(mini).toContain('direction="right"');
    expect(mini).toContain('onClick={onToggleCollapsed}');
    // The mark, not the wordmark: 60px holds the square logo only.
    expect(mini).toContain('testId="pro-nav-home-mini"');
    expect(mini).toContain('brand.markSrc');
    // The strip is the list of destinations, and saved courses are not one any
    // more: the drawer is gone, so there is no glyph that opens it.
    expect(mini).not.toContain('pro-nav-mini-saved');
    // New chat, search, the destinations and the account, as in the expanded rail.
    expect(mini).toContain('pro-workspace-new-session-mini');
    expect(mini).toContain('pro-nav-search-mini');
    expect(mini).toContain('<RailDestinationButton key={item.id} item={item} mini />');
    expect(mini).toContain('<WorkspaceAccountBlock mini');

    // The chat list's glyph expands, and says so on top of naming the list.
    const button = /data-testid="pro-nav-mini-sessions"[\s\S]*?\/>\s*<\/button>/.exec(mini);
    expect(button).not.toBeNull();
    expect(button![0]).toContain('expandLabel(');
    expect(button![0]).toContain('aria-expanded={false}');
    expect(button![0]).toContain('onClick={onToggleCollapsed}');
  });
});
