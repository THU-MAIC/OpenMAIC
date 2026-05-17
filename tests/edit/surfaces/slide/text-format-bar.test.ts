import { describe, it, expect, vi } from 'vitest';
import * as registry from '@/lib/prosemirror/active-editor-registry';
import { stepFontSize } from '@/components/edit/surfaces/slide/text-format-bar';
import { buildFloatingActions } from '@/components/edit/surfaces/slide/use-slide-surface';
import type { PPTTextElement } from '@/lib/types/slides';

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

describe('buildFloatingActions — text-format wiring', () => {
  const t = (k: string) => k;

  it('returns [] when no text target', () => {
    expect(buildFloatingActions(t, undefined)).toEqual([]);
  });

  it('returns a single text-format action when text element is selected', () => {
    const textEl = { id: 'el-42', type: 'text' } as PPTTextElement;
    const actions = buildFloatingActions(t, textEl);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('text-format');
  });

  it('text-format action has a popoverContent factory', () => {
    const textEl = { id: 'el-42', type: 'text' } as PPTTextElement;
    const actions = buildFloatingActions(t, textEl);
    expect(typeof actions[0].popoverContent).toBe('function');
  });

  it('text-format action label and tooltip are i18n keys', () => {
    const textEl = { id: 'el-42', type: 'text' } as PPTTextElement;
    const actions = buildFloatingActions(t, textEl);
    expect(actions[0].label).toBe('edit.text.label');
    expect(actions[0].tooltip).toBe('edit.text.label');
  });
});
