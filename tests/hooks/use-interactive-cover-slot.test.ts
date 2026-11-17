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

describe('useInteractiveCoverSlot: queued duplicates', () => {
  const div2 = document.createElement('div');
  let roots2: Root[] = [];

  function mount2(key: string | null, id: string) {
    const root = createRoot(div2.appendChild(document.createElement('div')));
    roots2.push(root);
    states.set(id, false);
    mount(key, (holding) => states.set(id, holding), root);
  }

  beforeEach(() => {
    __resetInteractiveCoverSlotsForTesting();
    roots2 = [];
  });

  afterEach(() => {
    for (const root of roots2) act(() => root.unmount());
    roots2 = [];
    div2.remove();
  });

  it('grants a queued duplicate as a shared holder instead of dropping it', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS; i++) mount2(`stage-${i}`, `p${i}`);
    // Both surfaces of a new course wait while the cap is full.
    mount2('stage-dup', 'dup1');
    mount2('stage-dup', 'dup2');
    expect(states.get('dup1')).toBe(false);
    expect(states.get('dup2')).toBe(false);

    act(() => roots2[0]!.unmount());
    roots2.shift();
    // The first duplicate takes the freed slot as a new holder…
    expect(states.get('dup1')).toBe(true);

    act(() => roots2[1]!.unmount());
    roots2.shift();
    // …and the second then shares it, rather than being discarded.
    expect(states.get('dup2')).toBe(true);
  });

  it('a shared grant consumes no slot, so one release serves two waiters', () => {
    for (let i = 0; i < MAX_LIVE_INTERACTIVE_COVERS; i++) mount2(`stage-${i}`, `p${i}`);
    mount2('stage-dup', 'dup1');
    mount2('stage-dup', 'dup2');
    mount2('stage-new', 'fresh');
    expect(states.get('dup1')).toBe(false);
    expect(states.get('dup2')).toBe(false);
    expect(states.get('fresh')).toBe(false);

    act(() => roots2[0]!.unmount());
    roots2.shift();
    // The freed slot goes to dup1 as a new holder, and dup2 then shares it
    // in the same pass (a shared grant consumes no slot)…
    expect(states.get('dup1')).toBe(true);
    expect(states.get('dup2')).toBe(true);
    // …but the cap is full again, so the new course still waits.
    expect(states.get('fresh')).toBe(false);

    act(() => roots2[1]!.unmount());
    roots2.shift();
    expect(states.get('fresh')).toBe(true);
  });
});
