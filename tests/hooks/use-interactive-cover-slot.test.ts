// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetInteractiveCoverSlotsForTesting,
  MAX_LIVE_INTERACTIVE_COVERS,
  useInteractiveCoverSlot,
} from '@/lib/hooks/use-interactive-cover-slot';

/** Mount a probe that reports its slot state through the given callback. */
function mount(key: string | null, onState: (holding: boolean) => void, root: Root) {
  function Probe() {
    const holding = useInteractiveCoverSlot(key);
    onState(holding);
    return createElement('div', { 'data-holding': String(holding) });
  }
  act(() => {
    root.render(createElement(Probe));
  });
}

/** The latest holding state a probe reported. */
const states = new Map<string, boolean>();

describe('useInteractiveCoverSlot', () => {
  const div = document.createElement('div');
  let roots: Root[] = [];

  function mountFresh(key: string | null, id: string) {
    const root = createRoot(div.appendChild(document.createElement('div')));
    roots.push(root);
    states.set(id, false);
    mount(key, (holding) => states.set(id, holding), root);
  }

  beforeEach(() => {
    __resetInteractiveCoverSlotsForTesting();
    roots = [];
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots = [];
    div.remove();
  });

  it('grants slots up to the cap and queues the rest first-come-first-served', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS + 2; i++) mountFresh(`stage-${i}`, `p${i}`);
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS; i++) {
      expect(states.get(`p${i}`)).toBe(true);
    }
    // The two late arrivals wait: their cards show the static placeholder.
    expect(states.get(`p${MAX_LIVE_INTERACTIVE_COVERS}`)).toBe(false);
    expect(states.get(`p${MAX_LIVE_INTERACTIVE_COVERS + 1}`)).toBe(false);
  });

  it('grants the earliest waiter when a holder unmounts', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS + 1; i++) mountFresh(`stage-${i}`, `p${i}`);
    expect(states.get(`p${MAX_LIVE_INTERACTIVE_COVERS}`)).toBe(false);

    act(() => roots[0]!.unmount());
    roots.shift();

    expect(states.get(`p${MAX_LIVE_INTERACTIVE_COVERS}`)).toBe(true);
  });

  it('a null key neither holds nor waits', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS; i++) mountFresh(`stage-${i}`, `p${i}`);
    mountFresh(null, 'off');
    expect(states.get('off')).toBe(false);
    // It took no slot: one more live course still fits up to the cap.
    mountFresh('stage-extra', 'extra');
    expect(states.get('extra')).toBe(false);
  });

  it('one course holds at most one slot however many surfaces show it', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS; i++) mountFresh(`stage-${i}`, `p${i}`);
    // A second surface of a holding course shares its slot…
    mountFresh('stage-0', 'dup');
    expect(states.get('dup')).toBe(true);
    // …so it takes none: the cap stays full for a new course.
    mountFresh('stage-new', 'fresh');
    expect(states.get('fresh')).toBe(false);
  });
});
