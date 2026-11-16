// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { isExportBusy, setExportBusy, useExportBusy } from '@/lib/store/export-busy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const seen: Record<string, boolean> = {};
const report = (id: string, busy: boolean) => {
  seen[id] = busy;
};
function Probe({ id, onValue }: { id: string; onValue: typeof report }) {
  onValue(id, useExportBusy('pptx'));
  return null;
}

const roots: Root[] = [];
function mount(id: string) {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(createElement(Probe, { id, onValue: report })));
  return root;
}

afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  setExportBusy('pptx', false);
});

/**
 * The workspace mounts the classroom export menu in the split header and in
 * the full-screen header, swapping one for the other. An export started in one
 * must stay visible (and guarded) in the other.
 */
describe('export busy store', () => {
  it('shares an in-flight export with every mounted menu, including one mounted later', () => {
    const split = mount('split');
    expect(seen.split).toBe(false);

    act(() => setExportBusy('pptx', true));
    expect(seen.split).toBe(true);

    // Full screen: the split menu unmounts and a fresh one mounts.
    act(() => split.unmount());
    mount('fullscreen');
    expect(seen.fullscreen).toBe(true);
    expect(isExportBusy('pptx')).toBe(true);

    act(() => setExportBusy('pptx', false));
    expect(seen.fullscreen).toBe(false);
  });

  it('tracks each export kind separately', () => {
    setExportBusy('html', true);
    expect(isExportBusy('html')).toBe(true);
    expect(isExportBusy('pptx')).toBe(false);
    setExportBusy('html', false);
  });
});
