import { describe, expect, it } from 'vitest';
import {
  clampRailWidth,
  currentPageIndex,
  parseRailWidth,
  presentWorkspaceSession,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
} from '@/lib/workbench/workspace-navigation';

describe('workspace navigation projection', () => {
  it('keeps active agent states visually live and failures explicit', () => {
    expect(presentWorkspaceSession('running')).toEqual({
      labelKey: 'workspace.sessionStatus.running',
      tone: 'live',
    });
    expect(presentWorkspaceSession('queued')).toEqual({
      labelKey: 'workspace.sessionStatus.queued',
      tone: 'live',
    });
    expect(presentWorkspaceSession('failed')).toEqual({
      labelKey: 'workspace.sessionStatus.failed',
      tone: 'error',
    });
  });

  it('renders terminal sessions as idle rather than pretending a run is active', () => {
    expect(presentWorkspaceSession('succeeded').tone).toBe('idle');
    expect(presentWorkspaceSession('cancelled').tone).toBe('idle');
  });

  it('names a locale key rather than baked-in copy, so the rail can be translated', () => {
    for (const status of [
      'connecting',
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
    ] as const) {
      expect(presentWorkspaceSession(status).labelKey).toBe(`workspace.sessionStatus.${status}`);
    }
  });

  it('derives the selected page from the same scene ids as the editor', () => {
    expect(currentPageIndex(['scene-a', 'scene-b'], 'scene-b')).toBe(1);
    expect(currentPageIndex(['scene-a'], null)).toBe(-1);
    expect(currentPageIndex(['scene-a'], 'missing')).toBe(-1);
  });
});

describe('resizable rail width', () => {
  it('keeps a dragged width inside the supported range', () => {
    expect(clampRailWidth(280)).toBe(280);
    expect(clampRailWidth(40)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(9999)).toBe(RAIL_WIDTH_MAX);
  });

  it('rounds to whole pixels so the rail never lands on a half-pixel seam', () => {
    expect(clampRailWidth(263.4)).toBe(263);
    expect(clampRailWidth(263.6)).toBe(264);
  });

  it('falls back to the default for a non-finite width', () => {
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_WIDTH_DEFAULT);
    // Infinity is not a width the user could have dragged to — it is a broken
    // read, so it gets the shipped layout rather than being clamped to the max.
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('reads a persisted width, degrading to the default rather than throwing', () => {
    // A stored width is untrusted: it outlives releases and can be hand-edited.
    expect(parseRailWidth('300')).toBe(300);
    expect(parseRailWidth(null)).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('nonsense')).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('')).toBe(RAIL_WIDTH_DEFAULT);
    expect(parseRailWidth('-500')).toBe(RAIL_WIDTH_MIN);
    expect(parseRailWidth('100000')).toBe(RAIL_WIDTH_MAX);
  });
});
