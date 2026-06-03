import { describe, it, expect, vi } from 'vitest';
import type { Transaction } from 'prosemirror-state';
import {
  registerActiveTextEditor,
  runActiveTextCommand,
  hasActiveTextEditor,
} from '@/lib/prosemirror/active-editor-registry';
import { shouldPushAttrs } from '@/lib/prosemirror/selection-sync';

/** Minimal transaction stub — only the three boolean fields shouldPushAttrs reads. */
const tx = (p: { selectionSet?: boolean; docChanged?: boolean; storedMarksSet?: boolean }) =>
  p as unknown as Transaction;

describe('active text editor registry', () => {
  it('routes a command to the registered element and clears on unregister', () => {
    const run = vi.fn();
    const off = registerActiveTextEditor('el-1', run);
    expect(hasActiveTextEditor('el-1')).toBe(true);
    runActiveTextCommand('el-1', { command: 'bold' });
    expect(run).toHaveBeenCalledWith({ command: 'bold' });
    off();
    expect(hasActiveTextEditor('el-1')).toBe(false);
    runActiveTextCommand('el-1', { command: 'bold' }); // no throw when absent
  });
});

describe('selection sync gate', () => {
  it('pushes on selection move, doc change, or stored-marks change', () => {
    expect(
      shouldPushAttrs(tx({ selectionSet: true, docChanged: false, storedMarksSet: false })),
    ).toBe(true);
    expect(
      shouldPushAttrs(tx({ selectionSet: false, docChanged: true, storedMarksSet: false })),
    ).toBe(true);
    expect(
      shouldPushAttrs(tx({ selectionSet: false, docChanged: false, storedMarksSet: true })),
    ).toBe(true);
    expect(
      shouldPushAttrs(tx({ selectionSet: false, docChanged: false, storedMarksSet: false })),
    ).toBe(false);
  });
});
