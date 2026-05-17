import { describe, it, expect, vi } from 'vitest';
import {
  registerActiveTextEditor,
  runActiveTextCommand,
  hasActiveTextEditor,
} from '@/lib/prosemirror/active-editor-registry';

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
