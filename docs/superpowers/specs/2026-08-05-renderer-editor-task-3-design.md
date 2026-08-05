# Renderer Editor Task 3 设计

## 背景与范围

Task 1 已把专业模式画布接到 `@openmaic/renderer/editing`，Task 2 已补齐通用选择、几何手势、辅助线、右键菜单和快捷键。Task 3 让 renderer editor 完整承接**已有 Text 元素**的渲染和富文本编辑。

本任务包含：

- Text 静态渲染专项对齐。
- 单击进入富文本编辑，同时保留按下后拖动的几何手势。
- renderer 包内独立实现完整 ProseMirror 编辑器。
- 完整富文本命令、格式状态和悬浮格式栏连接。
- 内容提交、自动尺寸、退出编辑和空文本清理。

本任务不包含：

- 插入新文本框；Task 3 完成后单独设计和实现。
- Shape label 富文本编辑；归 Task 5。
- 删除旧 editor 或旧 `ProsemirrorEditor`；feature flag 关闭时旧路径保持不变。
- 元素复制、剪切、粘贴；已作为主 Issue 的 Task 13。

## 核心决策

### renderer 自己拥有 ProseMirror

`@openmaic/renderer/editing` 新增 package-native 的 ProseMirror 实现。它拥有 schema、plugins、input rules、commands、selection formatting state、focus 和内部 history，不从 OpenMAIC app 导入 store、emitter、toolbar 或 `@/` 路径。

迁移期有两套实现：

- flag 关闭：旧 editor 继续使用 app 内现有 `ProsemirrorEditor`。
- flag 开启：`EditableSlideCanvas` 使用 renderer 内的新编辑器。

两套实现共享 DSL 中的 HTML content 数据契约，但不在本任务中抽取跨包运行时代码。这样可避免 renderer 反向依赖 app，也不会改变旧路径行为。

renderer package 增加与现有版本一致的 ProseMirror dependencies：`prosemirror-model`、`prosemirror-state`、`prosemirror-view`、`prosemirror-commands`、`prosemirror-history`、`prosemirror-keymap`、`prosemirror-inputrules`、`prosemirror-dropcursor`、`prosemirror-gapcursor` 和 `prosemirror-schema-list`。

## 编辑状态与手势

`Selection.editingId` 是 renderer editor 的受控文本编辑状态：

- `elementIds` 表示画布选择。
- `editingId` 仅能指向当前单选、未锁定、可见的 Text 元素。
- app host 保存并回传 `editingId`；renderer 不把编辑状态写入任何 app store。

Text 命中层继续先进入现有 pointer gesture：

- pointer 移动超过拖拽阈值：执行移动，不进入 ProseMirror。
- 未超过阈值的主按钮单击：选择该 Text，并设置 `editingId`，随后聚焦 ProseMirror。
- 单击另一个元素或空白画布：清除原 `editingId`，按现有规则更新选择。
- Escape：结束文本编辑但保留 Text 单选；再次 Escape 可由画布快捷键清空选择。
- locked、hidden Text 不可进入编辑。
- 编辑状态下不渲染覆盖 ProseMirror 的元素移动 hit target；编辑前的首次按下仍可直接拖动。

单击进入编辑后，文本内容区属于 ProseMirror。几何 resize/rotate handles 继续可用；移动可通过结束编辑后的直接拖动完成。本任务不新增单独的文本移动手柄。

## renderer 文本编辑器

renderer 新编辑器复刻现有 `ProsemirrorEditor` 的完整能力：

- paragraph、heading、blockquote、text、hard break、ordered list、bullet list、list item 等 schema nodes。
- strong、em、underline、strikethrough、subscript、superscript、code、link、font name、font size、foreground color、background color 等 marks。
- history、base keymap、list keymap、drop cursor、gap cursor、placeholder 和输入规则。
- 粗体、斜体、下划线、删除线、上下标、行内代码、引用、链接、清除格式。
- 字体、字号、字号增减、前景色、背景色。
- 左/中/右对齐、缩进、首行缩进。
- 无序列表、有序列表及 list style。
- 插入文本、替换文本。
- 单命令、批量命令和格式刷应用。
- 编辑器内部 undo/redo 键盘行为。

公共 API 使用明确的 union types，不延续旧 emitter 的任意 `command: string`：

- `TextEditCommand`：完整命令 union，可单条或批量执行。
- `TextFormatState`：光标/选区当前 marks、block、list、alignment 和字体状态。
- `TextEditorController`：`focus()`、`flush()`、`execute(command | command[])`、`getHTML()`。

`EditableSlideCanvas` 通过回调把当前 controller 和 format state 暴露给 host。controller 只在对应 `editingId` 活跃时存在，退出编辑或卸载时必须注销，避免格式栏命令落到旧元素。

## 渲染结构

`BaseTextElement` 仍是 Text 布局和视觉样式的唯一实现。静态和编辑状态共用同一层：位置、尺寸、旋转、垂直对齐、fill、opacity、shadow、outline、font、line height、paragraph spacing、letter spacing 和 writing mode 不复制到第二套 wrapper。

静态状态渲染 `dangerouslySetInnerHTML`；编辑状态只替换内部文字内容节点为 renderer ProseMirror DOM。这样编辑切换不会改变 Text 外框和排版坐标。

专项测试逐项验证：

- `defaultFontName`、`defaultColor`。
- `lineHeight`、`paragraphSpace`、`wordSpace`。
- `vertical`、`vAlign`。
- `shadow`、`fill`、`opacity`、`outline`。
- 静态 HTML 与编辑器 HTML 使用同一 prose reset。

只修复测试证明存在的 renderer 差异，不改 DSL 数据，也不重写 playback 的其他元素。

## app host 连接

`RendererEditorCanvas` 负责把 renderer 的公开事件连接到现有产品层：

- selection 回调同步 `activeElementIdList` 和 `editingElementId`。
- format state 回调同步现有 `richTextAttrs`，悬浮格式栏继续显示实时状态。
- controller 激活回调注册到 app 的 active text editor registry；格式栏和旧 emitter 入口都转换为 renderer 的 typed command。
- focus/blur 回调设置 `disableHotkeys`，防止画布 Delete、Mod+A 等快捷键抢占文本输入。
- content 变化使用 `text.updateContent` intent，通过既有 renderer intent adapter、`slide-edit-session` 和 stage store 写入。

现有悬浮栏可以继续只显示当前产品已提供的控件，但 renderer controller 必须支持旧 `ProsemirrorEditor` 的完整命令集合，确保其他现有入口和后续 UI 不丢能力。

## 内容提交与历史

编辑器以 300ms trailing debounce 输出 HTML，行为与旧 editor 一致。以下边界强制 flush：

- blur。
- Escape 结束编辑。
- selection 切换。
- 组件卸载。

普通输入和格式命令发出 `text.updateContent` intent，并形成 host undo 历史。ProseMirror 内部 Mod+Z/Mod+Y 发出的同步内容标记为 history-neutral：app 写回当前内容并清空无效 redo 分支，但不额外创建一条反向 undo 记录，保持 renderer 内部 history 与 host history不互相递归。

为此，Text content 事件除 intent 外还携带 `history: 'record' | 'neutral'` 提交元数据。元数据属于 editing callback，不写入 DSL 或持久化文档。

## 自动尺寸与空文本

renderer 编辑器使用 `ResizeObserver` 观察实际 prose content：

- 水平文本根据内容更新 `height`。
- 竖排文本根据内容更新 `width`。
- resize 手势进行中只缓存测量值，手势结束后应用，避免与用户 resize 竞争。
- 自动尺寸通过 host normalization 提交通道写回，不增加独立 undo 条目。

退出编辑所有权时，renderer 先 flush 最新 HTML，再用 ProseMirror document 的 `textContent` 判断语义内容。只有空白、空 paragraph、`<br>`、`&nbsp;` 等无可见文本的 Text 会发出 `element.delete` intent。切换到格式栏导致的临时 DOM blur 不结束编辑所有权，也不会误删元素。

删除后清空 selection/editingId，并通过同一 host transaction 进入 undo/autosave。

## 错误和生命周期

- 外部 content 在编辑器未聚焦时更新，重建 ProseMirror document；聚焦时不覆盖本地尚未 flush 的输入。
- 外部删除当前 Text 时立即销毁 editor/controller 并清空 editingId。
- command 的目标 ID 与当前 controller 不一致时 no-op。
- 不可解析 HTML 使用 schema parser 的安全 fallback，编辑器保持可用并输出规范化 HTML。
- debounce timer、ResizeObserver、controller 注册和 DOM listeners 在卸载时全部清理。

## 测试与验收

renderer package：

- schema 对旧 HTML fixture 的 parse/serialize round-trip。
- 每类完整 command 的行为测试。
- format state 随 selection/marks/block/list 变化。
- 单击 Text 进入编辑；拖动 Text 不进入编辑。
- locked/hidden/non-text 不进入编辑。
- 编辑状态正确切换静态 DOM 与 ProseMirror DOM。
- content intent 的 record/neutral 元数据。
- blur/Escape/switch/unmount flush。
- 水平自动高度、竖排自动宽度。
- 语义空文本检测和删除。
- Text 静态样式专项渲染测试。

app：

- `editingId` 与 canvas store 同步。
- controller 注册、注销和悬浮格式栏命令路由。
- `richTextAttrs` 实时同步。
- content、自动尺寸、空文本删除分别进入正确的 session 提交通道。
- renderer flag 开启时使用新 editor；关闭时旧 editor 和旧 `ProsemirrorEditor` 不变。
- undo/redo/autosave 回归。

最终必须通过 renderer/app 全量测试、TypeScript、ESLint、Prettier 和 Next production build，并在本地 3001 服务完成一次真实页面 smoke test。
