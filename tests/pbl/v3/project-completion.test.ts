// @vitest-environment jsdom
import { act, createElement, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProjectCompletion } from '@/components/scene-renderers/pbl/v3/use-project-completion';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type View = Parameters<typeof useProjectCompletion>[0];
const active = { id: 'study', reportAvailable: false, busy: false };
const completed = { ...active, reportAvailable: true };

describe('project completion invitation', () => {
  let root: Root;
  let invitation: ReturnType<typeof useProjectCompletion>;
  function Harness(props: { view: View; blocked: boolean; reportOpen: boolean }) {
    const result = useProjectCompletion(props.view, props);
    useEffect(() => {
      invitation = result;
    });
    return null;
  }
  async function observe(view: View, { blocked = false, reportOpen = false } = {}) {
    await act(() =>
      root.render(
        createElement(StrictMode, null, createElement(Harness, { view, blocked, reportOpen })),
      ),
    );
    return invitation.open;
  }
  beforeEach(() => {
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(() => root.unmount());
  });

  it('waits for both the final run and the narration playhead, then dismisses once per visit', async () => {
    expect(await observe(null)).toBe(false);
    expect(await observe(active)).toBe(false);
    expect(await observe({ ...active, busy: true })).toBe(false);
    expect(await observe({ ...completed, busy: true })).toBe(false);
    // The run is now settled, but the last sentence is still being read aloud or silently.
    expect(await observe(completed, { blocked: true })).toBe(false);
    expect(await observe(completed)).toBe(true);
    await act(() => invitation.dismiss());
    expect(await observe({ ...completed })).toBe(false);
  });

  it('keeps a completed study quiet on entry, refresh, and historical replay', async () => {
    expect(await observe(null)).toBe(false);
    expect(await observe({ ...completed, busy: true }, { blocked: true })).toBe(false);
    expect(await observe(completed)).toBe(false);
    expect(await observe(completed, { blocked: true })).toBe(false);
    expect(await observe(completed)).toBe(false);
  });

  it('consumes a pending invitation when the learner opens the report themselves', async () => {
    expect(await observe(active)).toBe(false);
    expect(await observe(completed, { blocked: true })).toBe(false);
    expect(await observe(completed, { blocked: true, reportOpen: true })).toBe(false);
    expect(await observe(completed)).toBe(false);
  });

  it('tracks each new study independently, including a late dismissal from a previous study', async () => {
    expect(await observe(active)).toBe(false);
    const previousDismiss = invitation.dismiss;
    expect(await observe({ ...completed, id: 'old-classroom' })).toBe(false);
    expect(await observe({ ...active, id: 'new-classroom' })).toBe(false);
    expect(await observe({ ...completed, id: 'new-classroom' })).toBe(true);
    await act(previousDismiss);
    expect(invitation.open).toBe(true);
  });
});
