import type {
  LineToolbarLabels,
  TextToolbarFont,
  TextToolbarLabels,
  TextToolbarLocale,
} from './types';

export interface EditorLabels {
  readonly insert: {
    readonly toolbar: string;
    readonly text: string;
    readonly image: string;
    readonly table: string;
    readonly tableDimensions: (rows: number, columns: number) => string;
    readonly chart: string;
    readonly chartBar: string;
    readonly chartLine: string;
    readonly chartPie: string;
    readonly line: string;
    readonly formula: string;
    readonly video: string;
    readonly audio: string;
  };
  readonly asset: {
    readonly drop: string;
    readonly orUrl: string;
    readonly urlPlaceholder: string;
    readonly insert: string;
    readonly invalidType: string;
    readonly readFailed: string;
  };
  readonly element: {
    readonly toolbar: string;
    readonly bringToFront: string;
    readonly sendToBack: string;
    readonly delete: string;
  };
  readonly image: {
    readonly replace: string;
    readonly flipH: string;
    readonly flipV: string;
  };
  readonly latex: {
    readonly toolbar: string;
    readonly edit: string;
    readonly dialog: string;
    readonly source: string;
    readonly preview: string;
    readonly symbols: string;
    readonly presets: string;
    readonly invalidSource: string;
  };
  readonly video: {
    readonly toolbar: string;
    readonly poster: string;
  };
  readonly audio: {
    readonly toolbar: string;
    readonly preview: string;
    readonly pause: string;
    readonly loop: string;
  };
  readonly background: {
    readonly label: string;
    readonly solid: string;
    readonly image: string;
    readonly color: string;
  };
  readonly table: { readonly doubleClickToEdit: string };
  readonly common: { readonly cancel: string; readonly confirm: string };
  readonly contextMenu: {
    readonly horizontalAlignment: string;
    readonly verticalAlignment: string;
    readonly selectAll: string;
    readonly copy: string;
    readonly cut: string;
    readonly paste: string;
    readonly unlock: string;
    readonly lock: string;
    readonly delete: string;
    readonly group: string;
    readonly ungroup: string;
    readonly bringToFront: string;
    readonly bringForward: string;
    readonly sendToBack: string;
    readonly sendBackward: string;
    readonly alignLeft: string;
    readonly alignCenter: string;
    readonly alignRight: string;
    readonly alignTop: string;
    readonly alignMiddle: string;
    readonly alignBottom: string;
  };
}

const BUILT_IN_EDITOR_LABELS: Record<TextToolbarLocale, EditorLabels> = {
  'zh-CN': {
    insert: {
      toolbar: '插入工具栏',
      text: '插入文本框',
      image: '插入图片',
      table: '插入表格',
      tableDimensions: (rows, columns) => `${rows} 行 × ${columns} 列`,
      chart: '插入图表',
      chartBar: '柱状图',
      chartLine: '折线图',
      chartPie: '饼图',
      line: '插入线条',
      formula: '插入公式',
      video: '插入视频',
      audio: '插入音频',
    },
    asset: {
      drop: '拖入文件或点击选择',
      orUrl: '或粘贴文件 URL',
      urlPlaceholder: 'https://...',
      insert: '插入',
      invalidType: '文件类型不受支持',
      readFailed: '无法读取文件',
    },
    element: {
      toolbar: '元素工具栏',
      bringToFront: '置于顶层',
      sendToBack: '置于底层',
      delete: '删除',
    },
    image: { replace: '替换图片', flipH: '水平翻转', flipV: '垂直翻转' },
    latex: {
      toolbar: '公式工具栏',
      edit: '编辑公式',
      dialog: '公式编辑器',
      source: 'LaTeX 源码',
      preview: '公式预览',
      symbols: '常用符号',
      presets: '预置公式',
      invalidSource: '请输入有效的 LaTeX 公式',
    },
    video: { toolbar: '视频工具栏', poster: '设置封面' },
    audio: { toolbar: '音频工具栏', preview: '试听音频', pause: '暂停试听', loop: '循环播放' },
    background: { label: '页面背景', solid: '纯色', image: '图片', color: '颜色' },
    table: { doubleClickToEdit: '双击编辑' },
    common: { cancel: '取消', confirm: '确定' },
    contextMenu: {
      horizontalAlignment: '水平对齐',
      verticalAlignment: '垂直对齐',
      selectAll: '全选',
      copy: '复制',
      cut: '剪切',
      paste: '粘贴',
      unlock: '解锁',
      lock: '锁定',
      delete: '删除',
      group: '组合',
      ungroup: '取消组合',
      bringToFront: '置于顶层',
      bringForward: '上移一层',
      sendToBack: '置于底层',
      sendBackward: '下移一层',
      alignLeft: '左对齐',
      alignCenter: '水平居中',
      alignRight: '右对齐',
      alignTop: '顶部对齐',
      alignMiddle: '垂直居中',
      alignBottom: '底部对齐',
    },
  },
  'en-US': {
    insert: {
      toolbar: 'Insert toolbar',
      text: 'Insert text box',
      image: 'Insert image',
      table: 'Insert table',
      tableDimensions: (rows, columns) => `${rows} rows × ${columns} columns`,
      chart: 'Insert chart',
      chartBar: 'Bar chart',
      chartLine: 'Line chart',
      chartPie: 'Pie chart',
      line: 'Insert line',
      formula: 'Insert formula',
      video: 'Insert video',
      audio: 'Insert audio',
    },
    asset: {
      drop: 'Drop a file or click to choose',
      orUrl: 'or paste a file URL',
      urlPlaceholder: 'https://...',
      insert: 'Insert',
      invalidType: 'Unsupported file type',
      readFailed: 'Unable to read file',
    },
    element: {
      toolbar: 'Element toolbar',
      bringToFront: 'Bring to front',
      sendToBack: 'Send to back',
      delete: 'Delete',
    },
    image: { replace: 'Replace image', flipH: 'Flip horizontally', flipV: 'Flip vertically' },
    latex: {
      toolbar: 'Formula toolbar',
      edit: 'Edit formula',
      dialog: 'Formula editor',
      source: 'LaTeX source',
      preview: 'Formula preview',
      symbols: 'Symbols',
      presets: 'Presets',
      invalidSource: 'Enter valid LaTeX',
    },
    video: { toolbar: 'Video toolbar', poster: 'Set poster' },
    audio: {
      toolbar: 'Audio toolbar',
      preview: 'Preview audio',
      pause: 'Pause preview',
      loop: 'Loop',
    },
    background: { label: 'Slide background', solid: 'Solid', image: 'Image', color: 'Color' },
    table: { doubleClickToEdit: 'Double-click to edit' },
    common: { cancel: 'Cancel', confirm: 'Confirm' },
    contextMenu: {
      horizontalAlignment: 'Horizontal alignment',
      verticalAlignment: 'Vertical alignment',
      selectAll: 'Select all',
      copy: 'Copy',
      cut: 'Cut',
      paste: 'Paste',
      unlock: 'Unlock',
      lock: 'Lock',
      delete: 'Delete',
      group: 'Group',
      ungroup: 'Ungroup',
      bringToFront: 'Bring to front',
      bringForward: 'Bring forward',
      sendToBack: 'Send to back',
      sendBackward: 'Send backward',
      alignLeft: 'Align left',
      alignCenter: 'Align center',
      alignRight: 'Align right',
      alignTop: 'Align top',
      alignMiddle: 'Align middle',
      alignBottom: 'Align bottom',
    },
  },
};

export function resolveEditorLabels(locale: TextToolbarLocale = 'en-US'): EditorLabels {
  return BUILT_IN_EDITOR_LABELS[locale] ?? BUILT_IN_EDITOR_LABELS['en-US'];
}

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

const BUILT_IN_LINE_LABELS: Record<TextToolbarLocale, LineToolbarLabels> = {
  'zh-CN': Object.freeze({
    toolbar: '线条工具栏',
    kind: '线条类型',
    color: '线条颜色',
    width: '线宽',
    style: '线条样式',
    start: '起点样式',
    end: '终点样式',
    straight: '直线',
    broken: '折线',
    broken2: '双折线',
    curve: '曲线',
    cubic: '三次曲线',
    solid: '实线',
    dashed: '虚线',
    dotted: '点线',
    none: '无',
    arrow: '箭头',
    dot: '圆点',
    bringToFront: '置于顶层',
    sendToBack: '置于底层',
    delete: '删除',
  }),
  'en-US': Object.freeze({
    toolbar: 'Line toolbar',
    kind: 'Line type',
    color: 'Line color',
    width: 'Line width',
    style: 'Line style',
    start: 'Start marker',
    end: 'End marker',
    straight: 'Straight',
    broken: 'Elbow',
    broken2: 'Double elbow',
    curve: 'Curve',
    cubic: 'Cubic curve',
    solid: 'Solid',
    dashed: 'Dashed',
    dotted: 'Dotted',
    none: 'None',
    arrow: 'Arrow',
    dot: 'Dot',
    bringToFront: 'Bring to front',
    sendToBack: 'Send to back',
    delete: 'Delete',
  }),
};

export const DEFAULT_TEXT_TOOLBAR_FONTS: readonly TextToolbarFont[] = Object.freeze([
  { label: 'Default', value: '' },
  { label: 'Microsoft YaHei', value: 'Microsoft YaHei' },
  { label: '思源黑体', value: 'Noto Sans SC' },
  { label: '思源宋体', value: 'Noto Serif SC' },
  { label: '霞鹜文楷', value: 'LXGW WenKai' },
  { label: '站酷快乐体', value: 'ZCOOL KuaiLe' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Open Sans', value: 'Open Sans' },
  { label: 'Montserrat', value: 'Montserrat' },
  { label: 'Source Sans 3', value: 'Source Sans 3' },
  { label: 'Merriweather', value: 'Merriweather' },
  { label: 'Literata', value: 'Literata' },
  { label: 'Source Serif 4', value: 'Source Serif 4' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
]);

export function resolveTextToolbarLabels(
  locale: TextToolbarLocale = 'en-US',
  overrides?: Partial<TextToolbarLabels>,
): TextToolbarLabels {
  return { ...(BUILT_IN_LABELS[locale] ?? BUILT_IN_LABELS['en-US']), ...overrides };
}

export function resolveLineToolbarLabels(
  locale: TextToolbarLocale = 'en-US',
  overrides?: Partial<LineToolbarLabels>,
): LineToolbarLabels {
  return { ...(BUILT_IN_LINE_LABELS[locale] ?? BUILT_IN_LINE_LABELS['en-US']), ...overrides };
}
