import { describe, expect, it } from 'vitest';
import { resolveEditorHost } from '../../src/ui/host';

describe('editor host capabilities', () => {
  it('provides distinct default element ids when the host omits a factory', () => {
    const host = resolveEditorHost();

    const first = host.createElementId('text');
    const second = host.createElementId('text');

    expect(first).toMatch(/^text-/);
    expect(second).toMatch(/^text-/);
    expect(second).not.toBe(first);
  });

  it('preserves generic host capabilities without element-specific branches', () => {
    const createElementId = (type: string) => `host-${type}`;
    const renderAssetPicker = () => null;
    const onError = () => undefined;

    const host = resolveEditorHost({
      locale: 'zh-CN',
      createElementId,
      renderAssetPicker,
      onError,
      shortcutsEnabled: false,
    });

    expect(host).toMatchObject({
      locale: 'zh-CN',
      createElementId,
      renderAssetPicker,
      onError,
      shortcutsEnabled: false,
    });
  });

  it('accepts arbitrary locales and preserves an external translator', () => {
    const translate = (key: string) => `translated:${key}`;
    const host = resolveEditorHost({ locale: 'ja-JP', translate });

    expect(host.locale).toBe('ja-JP');
    expect(host.translate).toBe(translate);
  });
});
