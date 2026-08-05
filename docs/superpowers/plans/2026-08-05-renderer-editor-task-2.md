# Renderer Editor Task 2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留旧 editor fallback 的前提下，对齐 renderer editor 的通用画布交互。

**Architecture:** renderer package 通过 `hiddenElementIds` 处理通用可见性；app host 通过共享命令层提供右键菜单和快捷键，并把每次命令折叠成一个 `EditIntent[]` 事务。timeline pick 和教学效果继续使用现有 `editable-element-` DOM 契约。

**Tech Stack:** TypeScript、React 19、Vitest、Radix Context Menu、Zustand、`@openmaic/renderer/editing`。

## Global Constraints

- 只使用 `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`，不增加新 feature flag。
- flag 关闭时旧 editor 行为不变。
- renderer 不读取 app store，不接管 undo、autosave、timeline 或产品菜单。
- 所有行为变更先写失败测试，再写最小实现。

---

### Task 1: 补齐 hidden/locked 可见性语义

**Files:**
- Modify: `packages/@openmaic/renderer/src/SlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/types.ts`
- Modify: `packages/@openmaic/renderer/src/editing/EditableSlideCanvas.tsx`
- Modify: `packages/@openmaic/renderer/src/editing/useMarqueeGesture.ts`
- Test: `packages/@openmaic/renderer/test/SlideCanvas.test.tsx`
- Test: `packages/@openmaic/renderer/test/editing/EditableSlideCanvas.multiselect.test.tsx`

**Interfaces:**
- Produces: `hiddenElementIds?: readonly string[]` on `SlideCanvasProps` and `EditableSlideCanvasProps`.

- [ ] 写失败测试：隐藏元素没有 DOM root、hit target、selection border 或 handles。
- [ ] 写失败测试：框选排除 hidden；点击 visible group 成员仍按完整源 group 选择。
- [ ] 运行 focused tests，确认因 `hiddenElementIds` 未实现而失败。
- [ ] 在渲染层、交互层、操作柄和 marquee 中使用同一 hidden id set。
- [ ] 运行 focused tests 和 renderer 全量测试。
- [ ] 提交 `feat: align renderer hidden element behavior`。

### Task 2: 建立 renderer host 命令层

**Files:**
- Create: `components/edit/surfaces/slide/renderer-canvas-commands.ts`
- Test: `tests/edit/surfaces/slide/renderer-canvas-commands.test.ts`

**Interfaces:**
- Produces: `createRendererCanvasCommands({ content, selection, hiddenElementIds, commit, setSelection })`。
- Commands: `deleteSelection`、`selectAll`、`lockSelection`、`unlockTarget`、`toggleGroup`、`reorderTarget`、`alignSelection`、`clearSelection`。

- [ ] 写失败测试：delete/select-all/lock/unlock/group/ungroup/reorder/align 的 intent 与 selection 结果。
- [ ] 确认测试因模块不存在而失败。
- [ ] 实现纯命令构造和单一 `commit(intents)` 边界。
- [ ] 验证 no-op 命令不提交，单个命令只提交一次。
- [ ] 提交 `feat: add renderer canvas host commands`。

### Task 3: 接入右键菜单

**Files:**
- Create: `components/edit/surfaces/slide/RendererCanvasContextMenu.tsx`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Test: `tests/edit/surfaces/slide/renderer-canvas-context-menu.test.tsx`

**Interfaces:**
- Consumes: Task 2 commands and renderer hit targets carrying `data-element-id`.

- [ ] 写失败组件测试：右键元素选择目标并显示元素菜单；右键空白显示画布菜单。
- [ ] 写失败组件测试：locked 目标只显示解锁；多选显示组合/取消组合。
- [ ] 实现 Radix Context Menu，复用旧 editor 中文菜单层级。
- [ ] 验证菜单命令调用 Task 2 命令层且不触发空白清选。
- [ ] 提交 `feat: add renderer canvas context menu`。

### Task 4: 接入画布快捷键

**Files:**
- Create: `components/edit/surfaces/slide/use-renderer-canvas-shortcuts.ts`
- Modify: `components/edit/surfaces/slide/SlideCanvas.tsx`
- Test: `tests/edit/surfaces/slide/renderer-canvas-shortcuts.test.tsx`

**Interfaces:**
- Handles: `Delete`、`Backspace`、`Mod+A`、`Mod+L`、`Mod+G`、`Escape`。

- [ ] 写失败测试：每个快捷键调用对应命令并 `preventDefault`。
- [ ] 写失败测试：editable target、flag 关闭、timeline pick 模式下不执行破坏性命令。
- [ ] 实现单个 document keydown listener 和 target guard。
- [ ] 验证快捷键和右键菜单共享 Task 2 命令层。
- [ ] 提交 `feat: add renderer canvas shortcuts`。

### Task 5: 验证 timeline pick 和教学效果定位

**Files:**
- Modify: `tests/edit/surfaces/slide/slide-canvas-renderer-flag.test.ts`
- Create or Modify: `tests/edit/surfaces/slide/element-pick-layer.test.tsx`

- [ ] 写 renderer 路径测试，确认 `hiddenElementIds` 和 `editable-element-` 传入。
- [ ] 测试 ElementPickLayer 能通过 renderer root id 测量和绑定目标。
- [ ] 测试 spotlight/laser overlays 在 renderer 路径保持挂载并使用相同前缀。
- [ ] 运行 app focused tests。
- [ ] 提交 `test: cover renderer canvas integrations`。

### Task 6: 全量验证

- [ ] 运行 `corepack pnpm --filter @openmaic/renderer test`。
- [ ] 运行 `corepack pnpm --filter @openmaic/renderer typecheck` 和 renderer build。
- [ ] 运行 Task 2 app focused tests、root TypeScript、ESLint、Prettier。
- [ ] 运行 `corepack pnpm build`。
- [ ] 确认 `http://localhost:3001/` 返回 200，并保留 PM2 dev 进程。
- [ ] 检查 `git diff --check` 和工作区状态。
