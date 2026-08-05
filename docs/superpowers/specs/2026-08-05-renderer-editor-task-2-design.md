# Renderer Editor Task 2 设计

## 背景

Task 1 已把专业模式画布接到 `@openmaic/renderer/editing`，并继续通过单一 feature flag 保留旧 editor。Task 2 不重做元素专项编辑，而是让 renderer 路径具备旧 editor 的通用画布交互。

## 当前能力盘点

renderer 已支持：

- 单选、修饰键多选、框选、空白清空。
- group 整组选中与整组拖动。
- locked 元素阻止选择和几何手势。
- 拖动、缩放、旋转、辅助线和吸附。
- `editable-element-` DOM id 前缀，供 timeline pick、spotlight、laser 定位。

仍需补齐：

- host 的 `hiddenElementIdList` 尚未传给 renderer，隐藏元素仍会渲染和参与命中。
- renderer 路径没有旧 editor 的画布/元素右键菜单。
- renderer 路径没有 Delete、全选、锁定、组合等画布快捷键。
- timeline pick、spotlight、laser 只有间接覆盖，没有 renderer 路径专项回归。

## 架构

`@openmaic/renderer/editing` 继续只负责通用渲染、命中和手势。它新增受控的 `hiddenElementIds` 输入，用于统一过滤渲染、交互层、操作柄和框选；不读取 app store，也不渲染产品菜单。

右键菜单、快捷键和命令执行属于 app host。`RendererEditorCanvas` 把 selection 和当前 slide 交给一个 host 命令层，命令层生成 `EditIntent[]` 并复用 Task 1 的 intent adapter，通过 `slide-edit-session.commitContent` 形成一次 undo 事务。菜单和快捷键只调用同一套命令，避免两条行为路径漂移。

timeline pick、spotlight、laser 继续依赖 `editable-element-<id>`。Task 2 只补验证，不迁移 ActionsBar 或效果状态到 renderer package。

## 行为约束

- hidden 元素不渲染、不创建 hit target、不显示 selection chrome、不参与框选。
- 点击可见 group 成员时，仍按源 slide 的完整 group 进行选择，与旧 editor 一致。
- locked 元素可通过右键菜单解锁，但不能通过普通点击、框选、拖动、缩放或旋转选中。
- Delete/Backspace 删除当前 selection；`Mod+A` 只选择可见且未锁定元素。
- `Mod+L` 锁定 selection 并清空选择；`Mod+G` 在可组合时组合，在同组选择时取消组合。
- 输入框、textarea、select、contenteditable 和 ProseMirror 内不处理画布快捷键。
- 右键元素时先把该元素或其 group 设为 selection，再显示元素菜单；右键空白显示画布菜单。
- copy/cut/paste 继续保持旧 editor 当前的未实现状态，不在 Task 2 新增剪贴板协议。
- feature flag 关闭时旧 editor 不变。

## 验收

- renderer 与旧 editor 对 hidden、locked、group、选择和几何手势行为一致。
- renderer 路径可使用右键菜单执行删除、锁定/解锁、组合/取消组合、层级和对齐。
- renderer 路径支持 Delete/Backspace、Mod+A、Mod+L、Mod+G、Escape。
- 每个命令最多提交一次 `slide-edit-session` 用户事务。
- timeline pick、spotlight、laser 能通过 renderer DOM id 找到目标。
- renderer 与 app 相关测试、类型检查、lint 和生产构建通过。
