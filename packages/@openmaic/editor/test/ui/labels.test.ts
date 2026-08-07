import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_TOOLBAR_FONTS,
  resolveEditorLabels,
  resolveTextToolbarLabels,
} from '../../src/ui/labels';

describe('editing-ui labels', () => {
  it('provides Chinese and English defaults with overrides taking precedence', () => {
    expect(resolveTextToolbarLabels('zh-CN').bold).toBe('粗体');
    expect(resolveTextToolbarLabels('en-US').bold).toBe('Bold');
    expect(resolveTextToolbarLabels('zh-CN', { bold: '加粗' }).bold).toBe('加粗');
  });

  it('falls back to English for an unsupported runtime locale', () => {
    expect(resolveTextToolbarLabels('fr-FR' as 'en-US').delete).toBe('Delete');
  });

  it('ships a default-font option and stable font values', () => {
    expect(DEFAULT_TEXT_TOOLBAR_FONTS[0]).toEqual({ label: 'Default', value: '' });
    expect(DEFAULT_TEXT_TOOLBAR_FONTS.some((font) => font.value === 'Microsoft YaHei')).toBe(true);
    expect(DEFAULT_TEXT_TOOLBAR_FONTS.some((font) => font.value === 'Noto Sans SC')).toBe(true);
    expect(DEFAULT_TEXT_TOOLBAR_FONTS.some((font) => font.value === 'JetBrains Mono')).toBe(true);
  });

  it('provides all built-in editor labels without host translations', () => {
    expect(resolveEditorLabels('zh-CN').insert.video).toBe('插入视频');
    expect(resolveEditorLabels('en-US').element.delete).toBe('Delete');
    expect(resolveEditorLabels().insert.image).toBe('Insert image');
  });

  it('falls back to English built-in editor labels for unsupported locales', () => {
    expect(resolveEditorLabels('fr-FR' as 'en-US').insert.audio).toBe('Insert audio');
  });
});
