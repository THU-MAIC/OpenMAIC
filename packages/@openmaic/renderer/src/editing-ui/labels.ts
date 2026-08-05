import type { TextToolbarFont, TextToolbarLabels, TextToolbarLocale } from './types';

const BUILT_IN_LABELS: Record<TextToolbarLocale, TextToolbarLabels> = {
  'zh-CN': Object.freeze({
    toolbar: '文本工具栏',
    font: '字体',
    fontDefault: '默认',
    fontSize: '字号',
    sizeDown: '减小字号',
    sizeUp: '增大字号',
    bold: '粗体',
    italic: '斜体',
    underline: '下划线',
    color: '文字颜色',
    alignLeft: '左对齐',
    alignCenter: '居中对齐',
    alignRight: '右对齐',
    bullet: '无序列表',
    bringToFront: '置于顶层',
    sendToBack: '置于底层',
    delete: '删除',
    colorHex: '颜色值',
  }),
  'en-US': Object.freeze({
    toolbar: 'Text toolbar',
    font: 'Font',
    fontDefault: 'Default',
    fontSize: 'Font size',
    sizeDown: 'Decrease font size',
    sizeUp: 'Increase font size',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    color: 'Text color',
    alignLeft: 'Align left',
    alignCenter: 'Align center',
    alignRight: 'Align right',
    bullet: 'Bullet list',
    bringToFront: 'Bring to front',
    sendToBack: 'Send to back',
    delete: 'Delete',
    colorHex: 'Color hex',
  }),
};

export const DEFAULT_TEXT_TOOLBAR_FONTS: readonly TextToolbarFont[] = Object.freeze([
  { label: 'Default', value: '' },
  { label: 'Microsoft YaHei', value: 'Microsoft YaHei' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Inter', value: 'Inter' },
]);

export function resolveTextToolbarLabels(
  locale: TextToolbarLocale = 'en-US',
  overrides?: Partial<TextToolbarLabels>,
): TextToolbarLabels {
  return { ...(BUILT_IN_LABELS[locale] ?? BUILT_IN_LABELS['en-US']), ...overrides };
}
