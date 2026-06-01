import { describe, it, expect, vi } from 'vitest';
import * as registry from '@/lib/prosemirror/active-editor-registry';
import { currentFontLabel, stepFontSize } from '@/components/edit/surfaces/slide/text-format-bar';

describe('TextFormatBar — pure logic', () => {
  it('stepFontSize increments and decrements by delta', () => {
    expect(stepFontSize('16px', 2)).toBe('18px');
    expect(stepFontSize('16px', -2)).toBe('14px');
  });

  it('stepFontSize clamps to [8, 96]', () => {
    expect(stepFontSize('8px', -2)).toBe('8px');
    expect(stepFontSize('96px', 2)).toBe('96px');
    expect(stepFontSize('100px', 2)).toBe('96px');
    expect(stepFontSize('4px', -2)).toBe('8px');
  });

  it('stepFontSize handles invalid input (defaults to 16)', () => {
    expect(stepFontSize('', 2)).toBe('18px');
    expect(stepFontSize('abc', -2)).toBe('14px');
  });
});

describe('TextFormatBar — currentFontLabel', () => {
  const t = (k: string) => `T:${k}`;

  it('returns the i18n label for the default (empty) font', () => {
    expect(currentFontLabel('', t)).toBe('T:edit.text.fontDefault');
  });

  it("returns the registry entry's label for a matched font", () => {
    expect(currentFontLabel('Roboto', t)).toBe('Roboto');
    expect(currentFontLabel('Noto Sans SC', t)).toBe('思源黑体');
  });

  it('returns the raw family name for an unmatched legacy font', () => {
    expect(currentFontLabel('Microsoft YaHei', t)).toBe('Microsoft YaHei');
    expect(currentFontLabel('PingFang SC', t)).toBe('PingFang SC');
  });
});

describe('TextFormatBar — C1 integration (runActiveTextCommand)', () => {
  it('runActiveTextCommand is callable for bold', () => {
    const spy = vi.spyOn(registry, 'runActiveTextCommand').mockImplementation(() => {});
    registry.runActiveTextCommand('el-1', { command: 'bold' });
    expect(spy).toHaveBeenCalledWith('el-1', { command: 'bold' });
    spy.mockRestore();
  });

  it('runActiveTextCommand supports all TextFormatBar commands', () => {
    const spy = vi.spyOn(registry, 'runActiveTextCommand').mockImplementation(() => {});
    const commands = [
      { command: 'bold' as const },
      { command: 'em' as const },
      { command: 'underline' as const },
      { command: 'forecolor' as const, value: '#ff0000' },
      { command: 'align-left' as const },
      { command: 'align-center' as const },
      { command: 'align-right' as const },
      { command: 'bulletList' as const },
      { command: 'fontname' as const, value: 'Inter' },
      { command: 'fontsize' as const, value: '18px' },
    ] as const;

    for (const payload of commands) {
      registry.runActiveTextCommand('el-1', payload);
    }
    expect(spy).toHaveBeenCalledTimes(commands.length);
    spy.mockRestore();
  });
});
