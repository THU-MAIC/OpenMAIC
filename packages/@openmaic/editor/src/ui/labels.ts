import type {
  LineToolbarLabels,
  TextToolbarFont,
  TextToolbarLabels,
  TextToolbarLocale,
} from './types';
import { translateEditorLabel, type EditorTranslate } from './translation';

type BuiltInEditorLocale = 'zh-CN' | 'en-US';

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
    readonly linePresets: {
      readonly straight: string;
      readonly dashed: string;
      readonly arrow: string;
      readonly dashedArrow: string;
      readonly dottedEnd: string;
      readonly broken: string;
      readonly doubleBroken: string;
      readonly curve: string;
      readonly cubic: string;
    };
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
    readonly toolbar: string;
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

const BUILT_IN_EDITOR_LABELS: Record<BuiltInEditorLocale, EditorLabels> = {
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
      linePresets: {
        straight: '直线',
        dashed: '虚线',
        arrow: '箭头',
        dashedArrow: '虚线箭头',
        dottedEnd: '圆点终点',
        broken: '折线',
        doubleBroken: '双折线',
        curve: '曲线',
        cubic: '三次曲线',
      },
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
    image: {
      toolbar: '图片工具栏',
      replace: '替换图片',
      flipH: '水平翻转',
      flipV: '垂直翻转',
    },
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
      linePresets: {
        straight: 'Straight',
        dashed: 'Dashed',
        arrow: 'Arrow',
        dashedArrow: 'Dashed arrow',
        dottedEnd: 'Dotted end',
        broken: 'Elbow',
        doubleBroken: 'Double elbow',
        curve: 'Curve',
        cubic: 'Cubic curve',
      },
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
    image: {
      toolbar: 'Image toolbar',
      replace: 'Replace image',
      flipH: 'Flip horizontally',
      flipV: 'Flip vertically',
    },
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

export function resolveEditorLabels(
  locale: TextToolbarLocale = 'en-US',
  translate?: EditorTranslate,
): EditorLabels {
  const base =
    BUILT_IN_EDITOR_LABELS[locale as BuiltInEditorLocale] ?? BUILT_IN_EDITOR_LABELS['en-US'];
  const tx = (
    key: Parameters<typeof translateEditorLabel>[1],
    defaultMessage: string,
    params?: Parameters<typeof translateEditorLabel>[3],
  ) => translateEditorLabel(translate, key, defaultMessage, params);

  return {
    insert: {
      toolbar: tx('insert.toolbar', base.insert.toolbar),
      text: tx('insert.textBox', base.insert.text),
      image: tx('insert.image', base.insert.image),
      table: tx('insert.table', base.insert.table),
      tableDimensions: (rows, columns) =>
        tx('insert.tableDimensions', base.insert.tableDimensions(rows, columns), {
          rows,
          columns,
        }),
      chart: tx('insert.chart', base.insert.chart),
      chartBar: tx('insert.chartBar', base.insert.chartBar),
      chartLine: tx('insert.chartLine', base.insert.chartLine),
      chartPie: tx('insert.chartPie', base.insert.chartPie),
      line: tx('insert.line', base.insert.line),
      linePresets: {
        straight: tx('insert.linePresets.straight', base.insert.linePresets.straight),
        dashed: tx('insert.linePresets.dashed', base.insert.linePresets.dashed),
        arrow: tx('insert.linePresets.arrow', base.insert.linePresets.arrow),
        dashedArrow: tx('insert.linePresets.dashedArrow', base.insert.linePresets.dashedArrow),
        dottedEnd: tx('insert.linePresets.dottedEnd', base.insert.linePresets.dottedEnd),
        broken: tx('insert.linePresets.broken', base.insert.linePresets.broken),
        doubleBroken: tx('insert.linePresets.doubleBroken', base.insert.linePresets.doubleBroken),
        curve: tx('insert.linePresets.curve', base.insert.linePresets.curve),
        cubic: tx('insert.linePresets.cubic', base.insert.linePresets.cubic),
      },
      formula: tx('insert.formula', base.insert.formula),
      video: tx('insert.video', base.insert.video),
      audio: tx('insert.audio', base.insert.audio),
    },
    asset: {
      drop: tx('asset.drop', base.asset.drop),
      orUrl: tx('asset.orUrl', base.asset.orUrl),
      urlPlaceholder: tx('asset.urlPlaceholder', base.asset.urlPlaceholder),
      insert: tx('asset.insert', base.asset.insert),
      invalidType: tx('asset.invalidType', base.asset.invalidType),
      readFailed: tx('asset.readFailed', base.asset.readFailed),
    },
    element: {
      toolbar: tx('element.toolbar', base.element.toolbar),
      bringToFront: tx('zorder.toFront', base.element.bringToFront),
      sendToBack: tx('zorder.toBack', base.element.sendToBack),
      delete: tx('delete', base.element.delete),
    },
    image: {
      toolbar: tx('image.toolbar', base.image.toolbar),
      replace: tx('image.replace', base.image.replace),
      flipH: tx('image.flipH', base.image.flipH),
      flipV: tx('image.flipV', base.image.flipV),
    },
    latex: {
      toolbar: tx('latex.toolbar', base.latex.toolbar),
      edit: tx('latex.editFormula', base.latex.edit),
      dialog: tx('latex.dialog', base.latex.dialog),
      source: tx('latex.source', base.latex.source),
      preview: tx('latex.preview', base.latex.preview),
      symbols: tx('latex.symbols', base.latex.symbols),
      presets: tx('latex.presets', base.latex.presets),
      invalidSource: tx('latex.invalidSource', base.latex.invalidSource),
    },
    video: {
      toolbar: tx('video.toolbar', base.video.toolbar),
      poster: tx('video.poster', base.video.poster),
    },
    audio: {
      toolbar: tx('audio.toolbar', base.audio.toolbar),
      preview: tx('audio.preview', base.audio.preview),
      pause: tx('audio.pause', base.audio.pause),
      loop: tx('audio.loop', base.audio.loop),
    },
    background: {
      label: tx('background.label', base.background.label),
      solid: tx('background.solid', base.background.solid),
      image: tx('background.image', base.background.image),
      color: tx('background.color', base.background.color),
    },
    table: {
      doubleClickToEdit: tx('table.doubleClickToEdit', base.table.doubleClickToEdit),
    },
    common: {
      cancel: tx('common.cancel', base.common.cancel),
      confirm: tx('common.confirm', base.common.confirm),
    },
    contextMenu: {
      horizontalAlignment: tx(
        'contextMenu.horizontalAlignment',
        base.contextMenu.horizontalAlignment,
      ),
      verticalAlignment: tx('contextMenu.verticalAlignment', base.contextMenu.verticalAlignment),
      selectAll: tx('contextMenu.selectAll', base.contextMenu.selectAll),
      copy: tx('contextMenu.copy', base.contextMenu.copy),
      cut: tx('contextMenu.cut', base.contextMenu.cut),
      paste: tx('contextMenu.paste', base.contextMenu.paste),
      unlock: tx('contextMenu.unlock', base.contextMenu.unlock),
      lock: tx('contextMenu.lock', base.contextMenu.lock),
      delete: tx('delete', base.contextMenu.delete),
      group: tx('contextMenu.group', base.contextMenu.group),
      ungroup: tx('contextMenu.ungroup', base.contextMenu.ungroup),
      bringToFront: tx('zorder.toFront', base.contextMenu.bringToFront),
      bringForward: tx('contextMenu.bringForward', base.contextMenu.bringForward),
      sendToBack: tx('zorder.toBack', base.contextMenu.sendToBack),
      sendBackward: tx('contextMenu.sendBackward', base.contextMenu.sendBackward),
      alignLeft: tx('text.alignLeft', base.contextMenu.alignLeft),
      alignCenter: tx('text.alignCenter', base.contextMenu.alignCenter),
      alignRight: tx('text.alignRight', base.contextMenu.alignRight),
      alignTop: tx('contextMenu.alignTop', base.contextMenu.alignTop),
      alignMiddle: tx('contextMenu.alignMiddle', base.contextMenu.alignMiddle),
      alignBottom: tx('contextMenu.alignBottom', base.contextMenu.alignBottom),
    },
  };
}

const BUILT_IN_LABELS: Record<BuiltInEditorLocale, TextToolbarLabels> = {
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

const BUILT_IN_LINE_LABELS: Record<BuiltInEditorLocale, LineToolbarLabels> = {
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
  translate?: EditorTranslate,
): TextToolbarLabels {
  const base = BUILT_IN_LABELS[locale as BuiltInEditorLocale] ?? BUILT_IN_LABELS['en-US'];
  const tx = (key: Parameters<typeof translateEditorLabel>[1], defaultMessage: string) =>
    translateEditorLabel(translate, key, defaultMessage);
  return {
    toolbar: tx('text.toolbar', base.toolbar),
    font: tx('text.font', base.font),
    fontDefault: tx('text.fontDefault', base.fontDefault),
    fontSize: tx('text.fontSize', base.fontSize),
    sizeDown: tx('text.sizeDown', base.sizeDown),
    sizeUp: tx('text.sizeUp', base.sizeUp),
    bold: tx('text.bold', base.bold),
    italic: tx('text.italic', base.italic),
    underline: tx('text.underline', base.underline),
    color: tx('text.color', base.color),
    alignLeft: tx('text.alignLeft', base.alignLeft),
    alignCenter: tx('text.alignCenter', base.alignCenter),
    alignRight: tx('text.alignRight', base.alignRight),
    bullet: tx('text.bullet', base.bullet),
    bringToFront: tx('zorder.toFront', base.bringToFront),
    sendToBack: tx('zorder.toBack', base.sendToBack),
    delete: tx('delete', base.delete),
    colorHex: tx('text.colorHex', base.colorHex),
    ...overrides,
  };
}

export function resolveLineToolbarLabels(
  locale: TextToolbarLocale = 'en-US',
  overrides?: Partial<LineToolbarLabels>,
  translate?: EditorTranslate,
): LineToolbarLabels {
  const base = BUILT_IN_LINE_LABELS[locale as BuiltInEditorLocale] ?? BUILT_IN_LINE_LABELS['en-US'];
  const tx = (key: Parameters<typeof translateEditorLabel>[1], defaultMessage: string) =>
    translateEditorLabel(translate, key, defaultMessage);
  return {
    toolbar: tx('line.toolbar', base.toolbar),
    kind: tx('line.kind', base.kind),
    color: tx('line.color', base.color),
    width: tx('line.width', base.width),
    style: tx('line.style', base.style),
    start: tx('line.start', base.start),
    end: tx('line.end', base.end),
    straight: tx('line.straight', base.straight),
    broken: tx('line.broken', base.broken),
    broken2: tx('line.broken2', base.broken2),
    curve: tx('line.curve', base.curve),
    cubic: tx('line.cubic', base.cubic),
    solid: tx('line.solid', base.solid),
    dashed: tx('line.dashed', base.dashed),
    dotted: tx('line.dotted', base.dotted),
    none: tx('line.none', base.none),
    arrow: tx('line.arrow', base.arrow),
    dot: tx('line.dot', base.dot),
    bringToFront: tx('zorder.toFront', base.bringToFront),
    sendToBack: tx('zorder.toBack', base.sendToBack),
    delete: tx('delete', base.delete),
    ...overrides,
  };
}
