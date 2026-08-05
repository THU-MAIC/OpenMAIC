# Renderer Editing UI 文本工具栏设计

## 背景

`@openmaic/renderer/editing` 已具备 Text 元素选择、单击编辑、ProseMirror、格式命令、格式状态、内容提交和自动尺寸能力，但当前文本工具栏仍由 OpenMAIC app 提供。app 通过 active editor registry、命令映射和 canvas store，把 renderer 的编辑器连接到 `AnchoredTextBar`。

本设计在 renderer 中增加独立 UI 层，使 renderer editor 可以开箱即用地提供文本格式工具栏，同时继续允许宿主替换 UI。迁移采用现有 renderer editor feature flag；旧 editor 路径保持不变。

## 第一阶段范围

第一阶段只迁移文本工具栏，包含：

- 字体选择。
- 字号输入、增大和减小。
- 粗体、斜体和下划线。
- 文字颜色及默认颜色选择器。
- 左对齐、居中和右对齐。
- 无序列表。
- 置于顶层和置于底层。
- 删除文本元素。
- 跟随正在编辑的文本元素定位。
- 随光标、选区和格式变化更新控件状态。
- 中文和英文基础文案，并允许宿主覆盖。

第一阶段不包含：

- 图片、形状、线条等非文本元素工具栏。
- 右键菜单。
- 左侧插入工具栏。
- 页面导航、时间轴、AI 编辑等产品 UI。
- 删除或重构旧 editor 的文本工具栏。
- 从旧、新 editor 中抽取共享运行时代码。

## 架构决策

### 新增独立入口

renderer package 增加 `@openmaic/renderer/editing-ui` 子路径。`editing` 继续提供无界面的编辑内核，`editing-ui` 只依赖 renderer 公共编辑 API，不依赖 OpenMAIC app。

预期导出：

```ts
export { EditableSlideCanvasWithUI } from './EditableSlideCanvasWithUI';
export { TextFormatToolbar } from './text/TextFormatToolbar';
export type {
  EditableSlideCanvasWithUIProps,
  TextToolbarOptions,
  TextToolbarLabels,
  TextToolbarFont,
  TextFormatToolbarProps,
} from './types';
```

`package.json` 和 Rollup 增加 `./editing-ui` 构建入口。该入口保持 React client boundary，并可被 Next.js、Vite 等 ESM bundler 使用。

### 组合式入口

`EditableSlideCanvasWithUI` 是推荐入口。它组合现有 `EditableSlideCanvas` 和文本工具栏，不复制选择、几何操作或 ProseMirror 实现。

```tsx
<EditableSlideCanvasWithUI
  slide={slide}
  selection={selection}
  onSelectionChange={handleSelectionChange}
  onElementsChange={handleElementsChange}
  onTextContentChange={handleTextContentChange}
  onTextAutoSize={handleTextAutoSize}
  textToolbar={{
    locale: 'zh-CN',
    fonts,
    placement: 'top',
  }}
/>
```

该组件内部保存当前 `TextEditorController` 和 `TextFormatState`。这些状态只服务当前编辑会话，不写入 DSL，也不替代宿主受控的 `Selection`。

### 可独立使用的纯工具栏

`TextFormatToolbar` 作为受控组件单独导出，使宿主可以自行决定定位、容器和视觉外壳。它接收格式状态和命令回调，不读取全局 store：

```ts
interface TextFormatToolbarProps {
  elementId: string;
  format: TextFormatState;
  fonts?: readonly TextToolbarFont[];
  labels?: Partial<TextToolbarLabels>;
  onCommand: (command: TextEditCommand) => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onDelete?: () => void;
  renderColorPicker?: TextToolbarColorPickerRenderer;
}
```

省略元素操作回调时，对应按钮不显示。这样纯工具栏也能用于只允许富文本格式修改的宿主。

## 组件划分

```text
editing-ui/
├── index.ts
├── types.ts
├── EditableSlideCanvasWithUI.tsx
├── styles.ts
└── text/
    ├── TextToolbarOverlay.tsx
    ├── ToolbarAnchor.tsx
    ├── TextFormatToolbar.tsx
    ├── FontSelect.tsx
    ├── FontSizeControl.tsx
    ├── DefaultColorPicker.tsx
    └── ElementActions.tsx
```

- `EditableSlideCanvasWithUI`：接管 controller、format state 和 toolbar lifecycle，并将其他 canvas props 原样传给 `EditableSlideCanvas`。
- `TextToolbarOverlay`：决定工具栏是否显示，组合锚点和格式栏。
- `ToolbarAnchor`：跟踪元素屏幕矩形，处理上方/下方翻转及视口约束。
- `TextFormatToolbar`：纯受控工具栏，不访问 renderer 内部状态。
- `DefaultColorPicker`：提供无需宿主依赖的颜色面板和十六进制输入。
- `styles.ts`：提供默认 CSS，并公开 CSS 变量作为主题接口。

## 数据流

### 进入编辑

1. 用户单击 Text 元素。
2. `EditableSlideCanvas` 通过 `onSelectionChange` 请求把该元素写入 `selection.editingId`。
3. 宿主回传新的受控 selection。
4. renderer 挂载 `RendererTextEditor` 并通过 `onTextEditorChange` 上报 controller。
5. editor 通过 `onTextFormatChange` 上报当前光标或选区的格式状态。
6. `EditableSlideCanvasWithUI` 在 editing ID、controller、format state 和锚点均有效时显示工具栏。

### 执行文本命令

1. 用户点击格式控件。
2. 工具栏直接调用当前 controller 的 `execute(TextEditCommand)`。
3. ProseMirror transaction 更新文档和格式状态。
4. renderer 通过现有 `onTextContentChange` 输出 typed intent 和 history mode。
5. OpenMAIC app 继续负责写入 DSL、撤销历史和自动保存。

`editing-ui` 不再需要 app 的 active editor registry，也不需要把 app 命令转换为 renderer 命令。

### 元素操作

置顶、置底和删除不属于 ProseMirror 命令。组合组件通过现有 `onElementsChange` 输出 renderer `EditIntent`：

- 置顶：`element.reorder`，目标为最上层。
- 置底：`element.reorder`，目标为最下层。
- 删除：`element.delete`。

宿主仍决定如何提交这些 intent，以及是否创建 undo 记录。

## 生命周期与交互规则

- 只有单选、未锁定、可见且处于 `selection.editingId` 的 Text 才显示工具栏。
- editing ID 存在但 controller 尚未注册时不显示，避免命令落到空目标。
- controller 的 element ID 必须与 editing ID 相同；不匹配时不执行命令。
- 切换元素、退出编辑、删除元素、切换页面或组件卸载时清理 controller 和 format state。
- 工具栏普通按钮在 pointer down 阶段阻止默认聚焦，使 ProseMirror 保留光标和文字选区。
- 字体下拉框、字号输入框和颜色输入控件可以拥有自己的焦点，但不得结束文本编辑所有权。
- Escape 关闭文本编辑的既有语义保持不变。
- 工具栏打开、定位和选择格式均不得产生内容提交或历史记录。

## 定位

`ToolbarAnchor` 使用正在编辑元素的真实屏幕矩形定位，不依赖 OpenMAIC 的 DOM wrapper 或 canvas store。

- 默认显示在元素上方，间距 8px。
- 上方空间不足时翻转到下方。
- 水平方向限制在 viewport 内，保留 12px 边距。
- 监听元素矩形、窗口尺寸、滚动和画布缩放变化。
- 工具栏通过 portal 渲染到 `document.body`，避免被画布 `overflow: hidden` 截断。
- SSR 阶段不读取 `document`；客户端挂载后再创建 portal。
- 找不到锚点或元素不再连接到 DOM 时隐藏工具栏，不抛出异常。

元素定位优先使用 renderer 已知 element ID 和可注入的根容器引用，不把 OpenMAIC 的 `editable-element-*` 前缀写死在 UI 层。

## 样式和可定制性

默认 UI 不使用 OpenMAIC Tailwind class，也不依赖 Radix。组件复用 renderer 已有的 `lucide-react`，通过 React DOM portal 和包内 CSS 实现。

`EditableSlideCanvasWithUI` 注入一次默认样式，方式与 renderer 当前 `SLIDE_RENDERER_STYLES` 一致。主题使用带前缀的 CSS 变量，例如：

```css
--maic-editing-ui-bg
--maic-editing-ui-fg
--maic-editing-ui-muted
--maic-editing-ui-active-bg
--maic-editing-ui-active-fg
--maic-editing-ui-border
--maic-editing-ui-shadow
--maic-editing-ui-radius
--maic-editing-ui-z-index
```

默认样式需要覆盖浅色和深色宿主的可读性，但第一阶段不自动读取 OpenMAIC 主题 store。宿主可在 renderer 容器或 `:root` 覆盖变量。

默认提供 `zh-CN` 和 `en-US` 标签。`locale` 选择内置标签，`labels` 对单项文案进行覆盖。字体列表由宿主传入时使用宿主列表，否则使用 renderer 的安全默认列表。未知的现有字体名称必须原样显示，不能回退成错误标签。

## OpenMAIC 渐进迁移

迁移继续使用唯一的 renderer editor feature flag，不新增 UI 级 feature flag：

- flag 关闭：保留旧 `Canvas`、旧 `ProsemirrorEditor` 和 app `AnchoredTextBar`。
- flag 开启：使用 renderer 的 `EditableSlideCanvasWithUI`，app 不再为该路径渲染 `AnchoredTextBar`。

第一阶段保留以下 app 文件供旧路径使用：

- `components/edit/surfaces/slide/AnchoredTextBar.tsx`
- `components/edit/surfaces/slide/AnchoredBar.tsx`
- `components/edit/surfaces/slide/text-format-bar.tsx`
- `lib/prosemirror/active-editor-registry.ts`

renderer 路径完成迁移后，移除它对 `connectRendererTextController`、`mapToolbarCommand` 和 `mapRendererTextFormatState` 的调用。旧 editor 是否改用 renderer 工具栏属于后续任务，不在本设计中处理。

## 错误处理

- controller 缺失、过期或目标 ID 不一致：命令 no-op，工具栏隐藏。
- 锚点缺失或已经从 DOM 移除：工具栏隐藏，并在下一次 selection/rect 更新时恢复。
- 字号输入非法：恢复当前值；合法范围限制为 8 至 96。
- 非法颜色值：不派发命令，保留上一个有效颜色。
- 未识别字体：显示原始字体名，并允许宿主字体列表补充。
- 不支持的 locale：回退到 `en-US`；显式 labels 始终优先。
- portal、事件监听和尺寸观察器在卸载时全部清理。

## 测试

### renderer 单元测试

- `TextFormatToolbar` 渲染全部第一阶段控件。
- 控件激活状态正确映射 `TextFormatState`。
- 字号输入、增减和 8 至 96 边界。
- 字体、粗体、斜体、下划线、颜色、对齐和列表派发正确 typed command。
- 置顶、置底和删除只在提供回调时显示并调用对应回调。
- 按钮 pointer down 不夺取 ProseMirror 焦点。
- 内置 locale、labels override 和未知字体显示。
- 默认颜色选择器校验和提交颜色。

### renderer 集成测试

- 单击 Text 后 controller 注册、格式状态同步并显示工具栏。
- 退出编辑、切换元素、删除元素和卸载后关闭工具栏并清理 controller。
- 工具栏命令修改当前 editor，不影响其他 Text。
- 打开工具栏和选择文字不产生 `onTextContentChange`。
- 元素操作输出正确 `EditIntent`。
- 缩放、滚动和窗口尺寸变化后工具栏继续跟随。
- 顶部空间不足时翻转，窄 viewport 中不横向溢出。

### OpenMAIC 回归测试

- feature flag 开启时只显示 renderer 工具栏，不显示 app 工具栏。
- feature flag 关闭时旧 editor 和旧工具栏行为不变。
- renderer 文本格式提交继续进入 slide edit session、undo 和 autosave。
- 页面切换、关闭专业模式和刷新恢复不会残留浮层或 controller。

### 浏览器验收

- 在 3001 服务使用真实课程验证单击文本、选取部分文字和连续格式操作。
- 验证工具栏点击不会导致光标跳转、文字移动或元素拖拽。
- 验证桌面与窄屏视口中的定位、翻转、溢出和文字适配。
- 验证旧 editor feature flag 路径无视觉和行为回归。

## 完成标准

- `@openmaic/renderer/editing-ui` 可以独立导入并构建。
- OpenMAIC renderer editor 路径只通过该入口获得文本工具栏。
- renderer UI 不包含 OpenMAIC app import、store 或 Next.js 依赖。
- 第一阶段所有文本控件、元素操作和定位行为与当前工具栏能力一致。
- 仅聚焦、选择、打开或关闭工具栏不会修改 DSL 或新增历史记录。
- feature flag 关闭时旧 editor 保持原有行为。
- renderer/app 测试、TypeScript、ESLint、Prettier、production build 和浏览器验收全部通过。
