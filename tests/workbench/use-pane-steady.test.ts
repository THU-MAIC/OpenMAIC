// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANE_ENTER_MS, usePaneSteady } from '@/components/workbench/workspace/use-pane-steady';

let steady = false;
let root: Root;
function Probe({ open }: { open: boolean }) {
  steady = usePaneSteady(open);
  return null;
}
const render = (open: boolean) => act(() => root.render(createElement(Probe, { open })));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('usePaneSteady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('lets the opening play, then holds through anything short of closing', () => {
    render(true);
    expect(steady).toBe(false);
    wait(PANE_ENTER_MS);
    expect(steady).toBe(true);
    render(true);
    expect(steady).toBe(true);
  });

  it('plays the next opening after a close', () => {
    render(true);
    wait(PANE_ENTER_MS);
    render(false);
    expect(steady).toBe(false);
    render(true);
    expect(steady).toBe(false);
    wait(PANE_ENTER_MS);
    expect(steady).toBe(true);
  });

  it('never goes steady when closed before the opening finishes', () => {
    render(true);
    render(false);
    wait(PANE_ENTER_MS * 2);
    expect(steady).toBe(false);
  });
});
