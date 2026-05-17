import { describe, it, expect, vi } from 'vitest';
import {
  registerActiveTextEditor,
  runActiveTextCommand,
  hasActiveTextEditor,
} from '@/lib/prosemirror/active-editor-registry';
import { shouldPushAttrs } from '@/lib/prosemirror/selection-sync';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal transaction stub for unit test
    expect(
      shouldPushAttrs({ selectionSet: true, docChanged: false, storedMarksSet: false } as any),
    ).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal transaction stub for unit test
    expect(
      shouldPushAttrs({ selectionSet: false, docChanged: true, storedMarksSet: false } as any),
    ).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal transaction stub for unit test
    expect(
      shouldPushAttrs({ selectionSet: false, docChanged: false, storedMarksSet: true } as any),
    ).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal transaction stub for unit test
    expect(
      shouldPushAttrs({ selectionSet: false, docChanged: false, storedMarksSet: false } as any),
    ).toBe(false);
  });
});
