# Renderer Text Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@openmaic/renderer/editing` 内完整实现 ProseMirror，并让专业模式中的已有 Text 元素支持单击编辑、完整富文本命令、格式栏同步、自动尺寸和空文本清理。

**Architecture:** renderer package 独立拥有 ProseMirror schema、plugins、commands 和 editor controller，通过受控 `Selection.editingId` 管理编辑目标，并通过 typed callbacks 向 app host 提交 content intent、format state 和 normalization。app 继续拥有 selection store、悬浮格式栏、undo/redo、autosave；feature flag 关闭路径完全保留旧 `ProsemirrorEditor`。

**Tech Stack:** React 19、TypeScript、ProseMirror、Vitest、Testing Library、Zustand、`@openmaic/renderer/editing`、`slide-edit-session`。

## Global Constraints

- 只支持已有 Text 元素；不实现文本插入。
- 单击 Text 进入编辑；同一次 pointer 手势超过 2px 时执行拖动且不进入编辑。
- renderer 不允许导入 app 的 `@/` 模块、store、emitter 或 UI 组件。
- 迁移完整 schema、plugins、input rules、commands、format painter 和内部 undo/redo 能力。
- 所有文档变更继续通过 `EditIntent`，app host 拥有 canonical content、undo/redo 和 autosave。
- `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED=false` 时旧 editor 行为不变。
- 普通输入记录 host history；ProseMirror 内部 undo/redo 使用 history-neutral 写回。
- 自动高度/宽度使用 normalization 写回，不增加独立 undo。
- 实现代码必须遵循 TDD：先观察目标测试失败，再写 production code。

---

## 文件结构

- `packages/@openmaic/renderer/src/editing/text/types.ts`：公开 command、format state、controller 和 content change 类型。
- `packages/@openmaic/renderer/src/editing/text/prosemirror/`：renderer 独立 schema、plugins、commands、parse/serialize 和 selection helpers。
- `packages/@openmaic/renderer/src/editing/text/RendererTextEditor.tsx`：package-native ProseMirror React 生命周期和完整 command executor。
- `packages/@openmaic/renderer/src/editing/text/richText.ts`：语义空文本和 HTML 规范化纯函数。
- `packages/@openmaic/renderer/src/editing/text/TextAutoSize.tsx`：content ResizeObserver 和 normalization 事件。
- `packages/@openmaic/renderer/src/elements/text/BaseTextElement.tsx`：静态/编辑状态共用的 Text 视觉 wrapper。
- `packages/@openmaic/renderer/src/editing/EditableSlideCanvas.tsx`：把 editingId、editor controller、format/content/size callbacks 组合到画布。
- `components/edit/surfaces/slide/renderer-text-editing.ts`：renderer format/controller 到 app registry/store 的适配。
- `components/edit/surfaces/slide/SlideCanvas.tsx`：受控 editingId 和 session commit wiring。

---

### Task 1: 建立 renderer ProseMirror 核心和公开类型

**Files:**

- Modify: `packages/@openmaic/renderer/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/@openmaic/renderer/src/editing/text/types.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/schema/index.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/schema/nodes.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/schema/marks.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/plugins/index.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/plugins/keymap.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/plugins/inputrules.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/plugins/placeholder.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/commands/setTextAlign.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/commands/setTextIndent.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/commands/toggleList.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/commands/setListStyle.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/commands/replaceText.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/document.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/prosemirror/utils.ts`
- Test: `packages/@openmaic/renderer/test/editing/text/prosemirror-schema.test.ts`

**Interfaces:**

- Produces: `TextEditCommand`, `TextFormatState`, `TextEditorController`, `TextContentChange`, `createTextDocument(html)`, `serializeTextDocument(doc)` and `createTextEditorPlugins(schema)`.
- Consumes: DSL HTML in `PPTTextElement.content` and ProseMirror packages at the same versions used by the app root.

- [ ] **Step 1: 写公开类型和 schema 的失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { createTextDocument, serializeTextDocument } from '../../../src/editing/text/prosemirror/document';

describe('renderer ProseMirror schema', () => {
  it('round-trips all legacy rich-text nodes and marks', () => {
    const html = '<blockquote><p style="text-align: center"><a href="https://maic.chat"><strong><u><span style="font-size: 28px; color: #ff0000">MAIC</span></u></strong></a></p></blockquote><ol><li><p>One</p></li></ol>';
    const output = serializeTextDocument(createTextDocument(html));
    expect(output).toContain('<blockquote>');
    expect(output).toContain('<ol>');
    expect(output).toContain('font-size: 28px');
    expect(output).toContain('color: #ff0000');
    expect(output).toContain('href="https://maic.chat"');
  });
});
```

- [ ] **Step 2: 运行测试并确认因 renderer text schema 尚不存在而失败**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/prosemirror-schema.test.ts`

Expected: FAIL，模块 `src/editing/text/prosemirror/document` 不存在。

- [ ] **Step 3: 定义完整 typed command API**

```ts
export type TextEditCommand =
  | { command: 'bold' | 'em' | 'underline' | 'strikethrough' | 'subscript' | 'superscript' | 'blockquote' | 'code' | 'clear' }
  | { command: 'fontname' | 'fontsize' | 'forecolor' | 'backcolor' | 'align' | 'indent' | 'textIndent' | 'insert' | 'replace'; value: string }
  | { command: 'fontsize-add' | 'fontsize-reduce' | 'bulletList' | 'orderedList' | 'link'; value?: string };

export interface TextFormatState {
  bold: boolean;
  em: boolean;
  underline: boolean;
  strikethrough: boolean;
  subscript: boolean;
  superscript: boolean;
  code: boolean;
  blockquote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  color: string;
  backcolor: string;
  fontsize: string;
  fontname: string;
  align: 'left' | 'center' | 'right';
  link: string;
}

export interface TextEditorController {
  readonly elementId: string;
  focus(): void;
  flush(): void;
  execute(command: TextEditCommand | readonly TextEditCommand[]): void;
  getHTML(): string;
}

export interface TextContentChange {
  intent: { type: 'text.updateContent'; id: string; content: string; target: 'text' };
  history: 'record' | 'neutral';
}
```

- [ ] **Step 4: 迁移 schema、plugins、input rules 和 pure commands**

以 `lib/prosemirror/` 的现有行为为兼容基线，把 schema/commands/plugins 复制到 renderer 命名空间，删除所有 `@/` import，并由 `document.ts` 提供 DOM parse/serialize：

```ts
export function createTextDocument(html: string): ProseMirrorNode {
  const template = document.createElement('template');
  template.innerHTML = html;
  return DOMParser.fromSchema(textSchema).parse(template.content);
}

export function serializeTextDocument(doc: ProseMirrorNode): string {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(textSchema).serializeFragment(doc.content));
  return host.innerHTML;
}
```

- [ ] **Step 5: 安装 renderer 自有 ProseMirror dependencies 并刷新 lockfile**

Run:

```bash
pnpm --filter @openmaic/renderer add prosemirror-commands@^1.7.1 prosemirror-dropcursor@^1.8.2 prosemirror-gapcursor@^1.4.0 prosemirror-history@^1.5.0 prosemirror-inputrules@^1.5.1 prosemirror-keymap@^1.2.3 prosemirror-model@^1.25.4 prosemirror-schema-basic@^1.2.4 prosemirror-schema-list@^1.5.1 prosemirror-state@^1.4.4 prosemirror-view@^1.41.5
```

- [ ] **Step 6: 运行 schema 测试、renderer typecheck 和 dependency boundary 检查**

Run:

```bash
pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/prosemirror-schema.test.ts
pnpm --dir packages/@openmaic/renderer typecheck
rg -n "from ['\"]@/" packages/@openmaic/renderer/src/editing/text
```

Expected: 测试和 typecheck PASS；`rg` 无输出。

- [ ] **Step 7: 提交 ProseMirror 核心**

```bash
git add packages/@openmaic/renderer/package.json pnpm-lock.yaml packages/@openmaic/renderer/src/editing/text packages/@openmaic/renderer/test/editing/text/prosemirror-schema.test.ts
git commit -m "feat(renderer): add ProseMirror text core"
```

---

### Task 2: 实现完整 RendererTextEditor controller、commands 和 format state

**Files:**

- Create: `packages/@openmaic/renderer/src/editing/text/RendererTextEditor.tsx`
- Create: `packages/@openmaic/renderer/src/editing/text/commandExecutor.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/formatState.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/index.ts`
- Modify: `packages/@openmaic/renderer/src/editing/index.ts`
- Test: `packages/@openmaic/renderer/test/editing/text/RendererTextEditor.test.tsx`
- Test: `packages/@openmaic/renderer/test/editing/text/commandExecutor.test.ts`

**Interfaces:**

- Consumes: Task 1 的 schema/plugins/types。
- Produces: `<RendererTextEditor>`, complete `TextEditorController`, `onContentChange`, `onFormatChange`, `onControllerChange`, `onFocusChange`。

- [ ] **Step 1: 写 command 和 React 生命周期失败测试**

```tsx
it.each([
  [{ command: 'bold' }],
  [{ command: 'strikethrough' }],
  [{ command: 'superscript' }],
  [{ command: 'blockquote' }],
  [{ command: 'orderedList', value: 'decimal' }],
  [{ command: 'link', value: 'https://maic.chat' }],
] satisfies TextEditCommand[][])('executes %o and emits normalized HTML', async (command) => {
  const onContentChange = vi.fn();
  const controller = await renderActiveEditor({ onContentChange });
  act(() => controller.execute(command));
  vi.advanceTimersByTime(300);
  expect(onContentChange).toHaveBeenCalledWith(
    expect.objectContaining({ intent: expect.objectContaining({ type: 'text.updateContent' }) }),
  );
});
```

同时覆盖：controller 注册/注销、autoFocus、external value 非 focus 时同步、selection transaction 推送 format state、blur/Escape/unmount flush、Mod+Z/Mod+Y 输出 `history: 'neutral'`。

- [ ] **Step 2: 运行测试并确认缺少 RendererTextEditor/command executor**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/RendererTextEditor.test.tsx test/editing/text/commandExecutor.test.ts`

Expected: FAIL，目标模块不存在。

- [ ] **Step 3: 实现 command executor 的完整 switch**

`executeTextCommand(view, command)` 必须穷举 `TextEditCommand`，复用 Task 1 pure commands，并在 default 分支使用 `never`。完整映射如下：

```ts
export function executeTextCommand(view: EditorView, command: TextEditCommand): void {
  switch (command.command) {
    case 'bold': {
      autoSelectAll(view);
      toggleMark(view.state.schema.marks.strong)(view.state, view.dispatch);
      return;
    }
    case 'em':
    case 'underline':
    case 'strikethrough': {
      autoSelectAll(view);
      toggleMark(view.state.schema.marks[command.command])(view.state, view.dispatch);
      return;
    }
    case 'subscript':
    case 'superscript':
    case 'code': {
      toggleMark(view.state.schema.marks[command.command])(view.state, view.dispatch);
      return;
    }
    case 'blockquote': {
      if (isActiveOfParentNodeType('blockquote', view.state)) {
        lift(view.state, view.dispatch);
      } else {
        wrapIn(view.state.schema.nodes.blockquote)(view.state, view.dispatch);
      }
      return;
    }
    case 'fontname':
    case 'fontsize':
    case 'forecolor':
    case 'backcolor': {
      const attrName = command.command === 'forecolor' ? 'color' : command.command;
      const mark = view.state.schema.marks[command.command].create({
        [attrName]: command.value,
      });
      autoSelectAll(view);
      addMark(view, mark);
      if (command.command === 'fontsize') {
        setListStyle(view, { key: 'fontsize', value: command.value });
      }
      if (command.command === 'forecolor') {
        setListStyle(view, { key: 'color', value: command.value });
      }
      return;
    }
    case 'fontsize-add':
    case 'fontsize-reduce': {
      const direction = command.command === 'fontsize-add' ? 1 : -1;
      const step = command.value ? Number(command.value) : 2;
      const next = Math.max(12, getFontsize(view) + direction * step);
      executeTextCommand(view, { command: 'fontsize', value: `${next}px` });
      return;
    }
    case 'align':
      alignmentCommand(view, command.value);
      return;
    case 'indent':
      indentCommand(view, Number(command.value));
      return;
    case 'textIndent':
      textIndentCommand(view, Number(command.value));
      return;
    case 'bulletList':
      toggleList(
        view.state.schema.nodes.bullet_list,
        view.state.schema.nodes.list_item,
        command.value ?? '',
        currentListTextStyle(view),
      )(view.state, view.dispatch);
      return;
    case 'orderedList':
      toggleList(
        view.state.schema.nodes.ordered_list,
        view.state.schema.nodes.list_item,
        command.value ?? '',
        currentListTextStyle(view),
      )(view.state, view.dispatch);
      return;
    case 'clear':
      clearTextFormatting(view);
      return;
    case 'link':
      setTextLink(view, command.value ?? '');
      return;
    case 'insert':
      view.dispatch(view.state.tr.insertText(command.value));
      return;
    case 'replace':
      replaceText(view, command.value);
      return;
    default: {
      const unsupported: never = command.command;
      throw new Error(`Unsupported text command: ${unsupported}`);
    }
  }
}
```

- [ ] **Step 4: 实现 RendererTextEditor 生命周期**

```tsx
export interface RendererTextEditorProps {
  elementId: string;
  value: string;
  defaultColor: string;
  defaultFontName: string;
  autoFocus?: boolean;
  onContentChange?: (change: TextContentChange) => void;
  onFormatChange?: (elementId: string, state: TextFormatState) => void;
  onControllerChange?: (controller: TextEditorController | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onEscape?: () => void;
}
```

内部只初始化一个 `EditorView`；dispatchTransaction 应用 transaction 后，在 doc/selection/marks 变化时推送 format state，并用 300ms timer 合并普通 HTML 更新。blur、Escape 和 cleanup 调用同一个 `flush()`；cleanup 先 flush，再销毁 view、timer 和 controller。

- [ ] **Step 5: 导出公开 API 并保持包边界**

`src/editing/index.ts` 导出组件和 Task 1 types；不得导出 raw `EditorView`。

- [ ] **Step 6: 运行 Task 2 测试、renderer 全量测试和 typecheck**

Run:

```bash
pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/RendererTextEditor.test.tsx test/editing/text/commandExecutor.test.ts
pnpm --dir packages/@openmaic/renderer test
pnpm --dir packages/@openmaic/renderer typecheck
```

- [ ] **Step 7: 提交 renderer 文本编辑器**

```bash
git add packages/@openmaic/renderer/src/editing packages/@openmaic/renderer/test/editing/text
git commit -m "feat(renderer): add rich text editor controller"
```

---

### Task 3: 让 Text 静态和编辑状态共用渲染结构

**Files:**

- Modify: `packages/@openmaic/renderer/src/elements/text/BaseTextElement.tsx`
- Modify: `packages/@openmaic/renderer/src/SlideElement.tsx`
- Modify: `packages/@openmaic/renderer/src/SlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/EditableSlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/types.ts`
- Test: `packages/@openmaic/renderer/test/elements/text/BaseTextElement.test.ts`
- Test: `packages/@openmaic/renderer/test/editing/EditableSlideCanvas.text.test.tsx`

**Interfaces:**

- Consumes: `<RendererTextEditor>` 和受控 `Selection.editingId`。
- Produces: editing Text 内部 DOM 替换、content/format/controller/focus callbacks。

- [ ] **Step 1: 写静态样式和编辑 DOM 失败测试**

```ts
it('shares text paint styles between static and editor content', () => {
  const markup = renderToStaticMarkup(
    <BaseTextElement
      elementInfo={{ ...textElement, fill: '#ffeeaa', opacity: 0.8, lineHeight: 1.8, paragraphSpace: 6, wordSpace: 3, vertical: true }}
      renderContent={() => <div data-renderer-text-editor="" />}
    />,
  );
  expect(markup).toContain('background-color:#ffeeaa');
  expect(markup).toContain('line-height:1.8');
  expect(markup).toContain('letter-spacing:3px');
  expect(markup).toContain('writing-mode:vertical-rl');
  expect(markup).toContain('data-renderer-text-editor=""');
  expect(markup).not.toContain('ProseMirror-static');
});
```

Editable 测试断言只有 `selection.editingId` 对应的 Text 挂载 editor；锁定、隐藏、非 Text 不挂载。

- [ ] **Step 2: 运行测试并确认 `renderContent`/editing props 不存在**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/elements/text/BaseTextElement.test.ts test/editing/EditableSlideCanvas.text.test.tsx`

- [ ] **Step 3: 增加 Text content render slot**

```ts
export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
  renderContent?: (element: PPTTextElement, defaultContent: ReactNode) => ReactNode;
}
```

`BaseTextElement` 构造一次 static content，再以 `renderContent?.(elementInfo, staticContent) ?? staticContent` 替换内部节点；所有 paint style 保留在共同 wrapper。

- [ ] **Step 4: 从 EditableSlideCanvas 挂载 active RendererTextEditor**

扩展 `EditableSlideCanvasProps`：

```ts
onTextContentChange?: (change: TextContentChange) => void;
onTextFormatChange?: (elementId: string, state: TextFormatState) => void;
onTextEditorChange?: (controller: TextEditorController | null) => void;
onTextFocusChange?: (focused: boolean) => void;
```

只在 `selection.editingId === element.id && !element.lock && !hidden.has(element.id)` 时传入 editor slot。

- [ ] **Step 5: 运行 Text 专项、SlideCanvas 和 renderer 全量测试**

Run:

```bash
pnpm --dir packages/@openmaic/renderer exec vitest run test/elements/text/BaseTextElement.test.ts test/editing/EditableSlideCanvas.text.test.tsx test/SlideCanvas.test.tsx
pnpm --dir packages/@openmaic/renderer test
```

- [ ] **Step 6: 提交共享 Text 渲染结构**

```bash
git add packages/@openmaic/renderer/src packages/@openmaic/renderer/test
git commit -m "feat(renderer): render editable text in place"
```

---

### Task 4: 实现单击进入编辑且不破坏拖动

**Files:**

- Modify: `packages/@openmaic/renderer/src/editing/useEditGesture.ts`
- Modify: `packages/@openmaic/renderer/src/editing/layers/ElementInteractionLayer.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/EditableSlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/useMarqueeGesture.ts`
- Test: `packages/@openmaic/renderer/test/editing/useEditGesture.test.tsx`
- Test: `packages/@openmaic/renderer/test/editing/EditableSlideCanvas.text.test.tsx`

**Interfaces:**

- Produces: sub-threshold Text click 更新 `{ elementIds: [id], primaryId: id, editingId: id }`；drag intent 不设置 editingId。

- [ ] **Step 1: 写 click-vs-drag 失败测试**

```tsx
it('enters text editing on one click but a drag only moves the text', () => {
  const onSelectionChange = vi.fn();
  const onElementsChange = vi.fn();
  const { target } = renderTextGesture({ onSelectionChange, onElementsChange });

  firePointer(target, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
  firePointer(window, 'pointerup', { pointerId: 1, clientX: 10, clientY: 10 });
  expect(onSelectionChange).toHaveBeenLastCalledWith({ elementIds: ['txt'], primaryId: 'txt', editingId: 'txt' });

  onSelectionChange.mockClear();
  firePointer(target, 'pointerdown', { pointerId: 2, clientX: 10, clientY: 10 });
  firePointer(window, 'pointerup', { pointerId: 2, clientX: 30, clientY: 20 });
  expect(onElementsChange).toHaveBeenCalledWith([expect.objectContaining({ type: 'element.update' })]);
  expect(onSelectionChange).not.toHaveBeenCalledWith(expect.objectContaining({ editingId: 'txt' }));
});
```

另测 locked/hidden Text、非主按钮、modifier multi-select 不进入编辑；Escape 保留单选并清除 editingId。

- [ ] **Step 2: 运行测试并确认当前 click 只选择、不设置 editingId**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/useEditGesture.test.tsx test/editing/EditableSlideCanvas.text.test.tsx`

- [ ] **Step 3: 在 pointer-up 的 sub-threshold 分支发布 Text editing selection**

给 `useEditGesture` 增加 `onElementClick`，只在主 pointer、未移动、无 modifier 时调用。`EditableSlideCanvas` 对 Text 生成受控 editing selection；其他类型沿用 Task 2 selection。

- [ ] **Step 4: 编辑时开放 ProseMirror pointer path**

`ElementInteractionLayer` 对 active editing Text 不渲染 box hit target。`EditableSlideCanvas` 在 active editing 时关闭全屏 marquee surface 的 pointer events，并在 outer capture 中识别 ProseMirror 外部 pointer-down：空白清 selection，其他元素交由自身 hit target 切换 selection。

- [ ] **Step 5: 实现 Escape 两阶段行为**

Renderer editor 首次 Escape 调用：

```ts
onSelectionChange?.({
  elementIds: selection.elementIds,
  primaryId: selection.primaryId,
});
```

画布 shortcut listener 仅在 `editingId` 已为空后处理下一次 Escape。

- [ ] **Step 6: 运行 gesture、marquee、selection 和 renderer 全量测试**

Run:

```bash
pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/useEditGesture.test.tsx test/editing/EditableSlideCanvas.text.test.tsx test/editing/useMarqueeGesture.test.tsx
pnpm --dir packages/@openmaic/renderer test
```

- [ ] **Step 7: 提交单击编辑交互**

```bash
git add packages/@openmaic/renderer/src/editing packages/@openmaic/renderer/test/editing
git commit -m "feat(renderer): enter text editing on click"
```

---

### Task 5: 连接 app selection、格式栏、history 和 autosave

**Files:**

- Create: `components/edit/surfaces/slide/renderer-text-editing.ts`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Modify: `components/edit/surfaces/slide/editing-state.ts`
- Modify: `components/edit/surfaces/slide/use-slide-surface.ts`
- Modify: `components/edit/surfaces/slide/use-renderer-canvas-shortcuts.ts`
- Modify: `lib/prosemirror/active-editor-registry.ts`
- Test: `tests/edit/surfaces/slide/renderer-text-editing.test.ts`
- Test: `tests/edit/surfaces/slide/editing-state.test.ts`
- Test: `tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`

**Interfaces:**

- Consumes: renderer controller/format/content callbacks。
- Produces: canvas store editingId/richTextAttrs/disableHotkeys 同步和正确 session commit mode。

- [ ] **Step 1: 写 app adapter 失败测试**

```ts
it('routes format-bar commands to the active renderer controller and unregisters on exit', () => {
  const controller = fakeController('txt');
  const detach = connectRendererTextController(controller);
  runActiveTextCommand('txt', { command: 'bold' });
  expect(controller.execute).toHaveBeenCalledWith({ command: 'bold' });
  detach();
  runActiveTextCommand('txt', { command: 'bold' });
  expect(controller.execute).toHaveBeenCalledTimes(1);
});
```

补充测试：format state 映射到 `richTextAttrs`；`record` 调 `commitContent(next, true)`；`neutral` 调 `commitContent(next, false)`；selection 回调同时写 active IDs 和 editing ID。

- [ ] **Step 2: 运行测试并确认 adapter/renderer props 尚不存在**

Run: `pnpm exec vitest run tests/edit/surfaces/slide/renderer-text-editing.test.ts tests/edit/surfaces/slide/editing-state.test.ts tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`

- [ ] **Step 3: 实现 renderer text app adapter**

```ts
export function connectRendererTextController(controller: TextEditorController): () => void {
  return registerActiveTextEditor(controller.elementId, (command) =>
    controller.execute(mapToolbarCommand(command)),
  );
}

export function mapToolbarCommand(command: TextCommandPayload): TextEditCommand {
  switch (command.command) {
    case 'align-left':
      return { command: 'align', value: 'left' };
    case 'align-center':
      return { command: 'align', value: 'center' };
    case 'align-right':
      return { command: 'align', value: 'right' };
    case 'bold':
    case 'em':
    case 'underline':
      return { command: command.command };
    case 'fontname':
    case 'fontsize':
    case 'forecolor':
      return { command: command.command, value: command.value ?? '' };
    case 'bulletList':
      return { command: 'bulletList', value: command.value };
    default: {
      const unsupported: never = command.command;
      throw new Error(`Unsupported toolbar command: ${unsupported}`);
    }
  }
}

export function commitRendererTextChange(content: SlideContent, change: TextContentChange): void {
  const next = applyRendererEditIntents(content, [change.intent]);
  useSlideEditSession.getState().commitContent(next, change.history === 'record');
}
```

format state mapper 必须逐字段映射到现有 `TextAttrs`，不使用宽泛 cast。

- [ ] **Step 4: 将 RendererEditorCanvas selection 改为受控 editingId**

`selection` 包含 canvas store 当前 `editingElementId`；`handleSelectionChange` 同时调用 `setActiveElementIdList` 和 `setEditingElementId(next.editingId ?? '')`。renderer 路径不再用“单选 Text 自动视为 editing”的旧 policy。

- [ ] **Step 5: 保留 legacy policy**

`resolveEditingElementId` 增加显式模式：

```ts
export function resolveEditingElementId(
  activeIds: readonly string[],
  elements: readonly PPTElement[],
  requestedId?: string,
): string {
  if (requestedId === undefined) return legacySingleTextSelectionPolicy(activeIds, elements);
  const selected = resolveSelectedElement(activeIds, elements);
  return selected?.type === 'text' && selected.id === requestedId && !selected.lock ? requestedId : '';
}
```

flag 关闭传 `undefined`；flag 开启传 store editing ID。

- [ ] **Step 6: 连接 controller、format、focus 和 content callbacks**

`RendererEditorCanvas` 把新 callbacks 传给 `EditableSlideCanvas`；controller cleanup 注销 registry，format 更新 `richTextAttrs`，focus 设置 `disableHotkeys`，content 进入对应 history mode。`AnchoredTextBar` 只接收验证后的 renderer editing ID。

- [ ] **Step 7: 运行 app 专项、session 和 root typecheck**

Run:

```bash
pnpm exec vitest run tests/edit/surfaces/slide/renderer-text-editing.test.ts tests/edit/surfaces/slide/editing-state.test.ts tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts tests/edit/slide-edit-session.test.ts
pnpm exec tsc --noEmit
```

- [ ] **Step 8: 提交 app host 连接**

```bash
git add components/edit/surfaces/slide lib/prosemirror/active-editor-registry.ts tests/edit/surfaces/slide
git commit -m "feat: connect renderer rich text editing"
```

---

### Task 6: 自动尺寸、flush 和空文本清理

**Files:**

- Create: `packages/@openmaic/renderer/src/editing/text/richText.ts`
- Create: `packages/@openmaic/renderer/src/editing/text/TextAutoSize.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/text/RendererTextEditor.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/EditableSlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/types.ts`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Test: `packages/@openmaic/renderer/test/editing/text/richText.test.ts`
- Test: `packages/@openmaic/renderer/test/editing/text/TextAutoSize.test.tsx`
- Test: `packages/@openmaic/renderer/test/editing/EditableSlideCanvas.text.test.tsx`
- Test: `tests/edit/surfaces/slide/renderer-text-editing.test.ts`

**Interfaces:**

- Produces: `isSemanticallyEmptyText(docOrHtml)`, `onTextAutoSize(intent)`, exit-time flush/delete transaction。

- [ ] **Step 1: 写语义空文本和尺寸失败测试**

```ts
it.each(['', '<p></p>', '<p><br></p>', '<p>&nbsp;</p>', '<p> \n </p>'])(
  'treats %j as empty',
  (html) => expect(isSemanticallyEmptyText(html)).toBe(true),
);

it.each(['<p>A</p>', '<p><strong>中</strong></p>', '<ul><li><p>One</p></li></ul>'])(
  'keeps visible content %j',
  (html) => expect(isSemanticallyEmptyText(html)).toBe(false),
);
```

ResizeObserver 测试：水平 contentRect 高度变化只发 `{ height }`；竖排只发 `{ width }`；重复相同测量 no-op；resize active 时缓存并在结束时发一次。

- [ ] **Step 2: 运行测试并确认 richText/TextAutoSize 模块不存在**

Run: `pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/richText.test.ts test/editing/text/TextAutoSize.test.tsx test/editing/EditableSlideCanvas.text.test.tsx`

- [ ] **Step 3: 实现语义空文本判断**

```ts
export function isSemanticallyEmptyText(html: string): boolean {
  const doc = createTextDocument(html);
  return doc.textContent.replace(/\u00a0/g, ' ').trim().length === 0;
}
```

- [ ] **Step 4: 实现 TextAutoSize normalization**

`TextAutoSize` 观察 ProseMirror content host；水平输出测量高度加共同 wrapper padding，竖排输出测量宽度加 padding。公开 callback：

```ts
onTextAutoSize?: (intent: {
  type: 'element.update';
  id: string;
  props: { width?: number; height?: number };
}) => void;
```

app 应用 intent 后调用 `commitContent(next, false)`。

- [ ] **Step 5: 在编辑所有权结束时 flush 并删除语义空 Text**

退出顺序固定为：`controller.flush()` → 读取最新 HTML → 若空则一次 `element.delete` intent → host 清除 selection/editingId。格式栏临时 focus 不改变 editingId，因此不会触发删除。

- [ ] **Step 6: 运行 Task 6 专项、renderer/app 全量相关测试**

Run:

```bash
pnpm --dir packages/@openmaic/renderer exec vitest run test/editing/text/richText.test.ts test/editing/text/TextAutoSize.test.tsx test/editing/EditableSlideCanvas.text.test.tsx
pnpm exec vitest run tests/edit/surfaces/slide/renderer-text-editing.test.ts tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts tests/edit/slide-edit-session.test.ts
```

- [ ] **Step 7: 提交尺寸与清理行为**

```bash
git add packages/@openmaic/renderer/src/editing packages/@openmaic/renderer/test/editing components/edit/surfaces/slide/SlideCanvas.tsx tests/edit/surfaces/slide
git commit -m "feat: finalize renderer text edit lifecycle"
```

---

### Task 7: 完整回归、独立 review 和本地验收

**Files:**

- Modify only files required by concrete verification failures.

**Interfaces:**

- Produces: verified Task 3 branch and running local service on port 3001.

- [ ] **Step 1: 运行格式、lint 和类型检查**

```bash
git diff --check
pnpm exec prettier --check packages/@openmaic/renderer/src packages/@openmaic/renderer/test components/edit/surfaces/slide tests/edit/surfaces/slide docs/superpowers
pnpm exec eslint packages/@openmaic/renderer/src components/edit/surfaces/slide lib/prosemirror/active-editor-registry.ts tests/edit/surfaces/slide
pnpm --dir packages/@openmaic/renderer typecheck
pnpm exec tsc --noEmit
```

- [ ] **Step 2: 串行运行 renderer 全量测试和构建**

```bash
pnpm --dir packages/@openmaic/renderer test
pnpm --dir packages/@openmaic/renderer build
```

- [ ] **Step 3: renderer build 完成后再运行 root 全量测试**

Run: `pnpm test`

Expected: 全部目标测试 PASS；不要与 renderer build 并发，因为 build 会重建 `dist`。

- [ ] **Step 4: 运行 Next production build**

Run: `pnpm build`

- [ ] **Step 5: 进行独立 code review**

Review checklist：package boundary、command completeness、controller cleanup、history record/neutral、single-click-vs-drag、legacy flag、empty delete、ResizeObserver loop、测试是否覆盖真实 ProseMirror DOM。

- [ ] **Step 6: 修复 review finding 时逐项执行新的 red-green cycle**

每个 finding 先新增能复现问题的测试并观察失败，再修改 production code；修复后重新执行 Steps 1-4。

- [ ] **Step 7: 重启 PM2 托管的 3001 dev process 并验证**

```bash
pid=$(ps -ax -o pid=,ppid=,command= | awk '/corepack pnpm exec next dev -p 3001/ && $0 !~ /awk/ {print $1; exit}')
test -n "$pid" && kill "$pid"
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3001/
```

Expected: PM2 拉起新 PID，HTTP `200`。

- [ ] **Step 8: 浏览器 smoke test**

在 renderer flag 开启的专业模式中验证：单击 Text 聚焦光标、直接拖动不进入编辑、输入中文/英文、完整格式命令、格式栏状态、内部 undo/redo、切换元素 flush、空文本删除、水平/竖排自动尺寸。再关闭 flag 验证旧 editor 可编辑 Text。

- [ ] **Step 9: 提交 verification finding 修复并确认 worktree clean**

```bash
git status --short
git log --oneline -8
```
