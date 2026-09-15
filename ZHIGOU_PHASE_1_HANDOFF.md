# 知构 AI UI 重构：第一阶段完成与第二阶段交接

## 1. 文档用途

本文档用于在 Codex 任务之间交接知构 AI UI 重构工作。

- 第一阶段已经完成并通过验收；
- 第二阶段应以本文档、当前代码和 `feature/ui-redesign` 分支为基线；
- 不重新讨论已经确定的品牌名称、Logo、配色和第一阶段技术边界；
- 遇到代码冲突、现有改动重叠、测试失败、资源问题或工具异常时，立即停止，不继续扩大修改范围。

## 2. 项目定位与开发原则

本项目基于 OpenMAIC 开源项目进行大学生创新创业项目二次开发，后续用于大创、挑战杯等项目展示与比赛。

当前策略：

> 核心能力继承，产品表现重做。

保留 OpenMAIC 的课程生成、课程大纲、Slide、Quiz、Interactive、PBL、AI Classroom、多智能体、Whiteboard、Playback、AI 编辑、导入导出、LLM、TTS、ASR 和 Workspace 等核心能力。

当前阶段不重写 Agent、generation、orchestration、playback、action、DSL、数据库协议或 `@openmaic/*` 包，不新增完整登录权限、教师学生双端、班级、成绩、学习画像或 LMS。

禁止对仓库执行无差别的 `OpenMAIC -> 知构 AI` 全局替换。内部包名、存储键、请求头、数据库名称、Schema、Cookie、导出格式和测试技术数据应保持不变。

正式材料、README、关于页面和许可证中必须如实保留 OpenMAIC 开源归属。

## 3. 已确定品牌规范

- 中文名称：`知构 AI`
- 英文名称：`ZhiGou AI`
- 中文简称：`知构`
- 产品全称：`知构 AI——生成式互动课程学习平台`
- 中文主口号：`让知识，成为一堂会互动的课`
- 英文主口号：`Turn knowledge into an interactive course.`

核心配色：

| Token | 浅色模式 | 深色模式 |
|---|---|---|
| Primary | `#176B87` | `#4FB6C5` |
| Accent | `#14A99A` | `#45D0BD` |
| Background | `#F4F8FA` | `#071B23` |
| Surface | `#FFFFFF` | `#102E39` |
| Text | `#102A43` | `#EEF7F8` |

品牌资源位于 `public/brand/`，正式页面优先使用 SVG：

- `mark.svg`
- `logo-horizontal.svg`
- `logo-horizontal-dark.svg`
- 对应 PNG、192px 和 512px 图标
- `zhigou-logo-horizontal-v1.png` 为概念稿，不作为网页首选资源

## 4. 第一阶段完成内容

第一阶段目标：完成知构 AI 品牌接入和基础视觉统一，使首页、Workspace、课堂与特殊场景不再直接呈现 OpenMAIC 原品牌，同时保持业务逻辑不变。

已完成：

1. 品牌配置
   - 更新 `lib/brand/brand-config.ts`；
   - 接入浅色横版 Logo、深色横版 Logo 和独立 Mark；
   - 同步品牌配置测试。

2. Metadata 与应用图标
   - 页面标题与描述改为知构 AI；
   - 新增 `app/icon.svg`；
   - 更新 favicon 和 Apple Touch Icon；
   - 新增品牌应用图标生成脚本。

3. 全局基础视觉
   - 应用外壳主色由紫色切换为青蓝/青绿；
   - 同步浅色、深色变量；
   - 保留课程内容、PBL 和图表的功能状态色。

4. 首页
   - 使用品牌配置渲染 Logo；
   - 接入中英文口号、课程生成文案和“关于项目”入口；
   - 更新首页焦点、背景光晕和按钮颜色；
   - 保留上传、联网搜索、语音输入、深度互动、课程管理和生成流程。

5. Workspace
   - 展开导航使用横版 Logo，折叠导航使用 Mark；
   - 可见 `Pro` 文案改为“AI 工作台”；
   - 同步 Workspace 浅色与深色品牌色；
   - 未修改三栏布局、URL 参数、面板状态和课程 Tab 逻辑。

6. 课堂与特殊场景
   - 课堂侧栏、编辑导航、PBL 工作区和访问码弹窗接入知构品牌；
   - 清理用户可见的旧 Logo 穿帮点；
   - 保留 OpenMAIC 内部技术标识和开源归属。

7. 中英文产品术语

| 原表达 | 当前表达 |
|---|---|
| Current Scene | 当前环节 / Current Activity |
| Slide | 课程讲解 / Course Explanation |
| Quiz | 理解检测 / Knowledge Check |
| Interactive | 互动探索 / Interactive Exploration |
| Whiteboard | 智能白板 / Smart Whiteboard |
| PBL | 项目实践 / Project Practice |
| Pro Workspace | AI 工作台 / AI Workspace |

8. 移动端首页修复
   - `<640px` 时 AgentBar 使用自适应宽度；
   - 首页底部工具区分行显示，消除控件重叠；
   - 用户称呼保持单行并允许截断；
   - `>=640px` 继续使用原桌面布局。

## 5. 第一阶段 Git 状态

- 仓库：`D:\eduProjects\OpenMAIC`
- 开发分支：`feature/ui-redesign`
- 第一阶段提交：`5a9e8ae3`
- 提交信息：`feat(ui): complete Zhigou AI brand redesign phase one`
- `main` 尚未合并第一阶段修改；
- 第一阶段验收结束时工作区干净；
- 后续 UI 工作继续提交到 `feature/ui-redesign`，完整 UI 重构验收后再合并到 `main`。

## 6. 已完成验证

- TypeScript：`pnpm exec tsc --noEmit --incremental false` 通过；
- i18n 键一致性：`pnpm run check:i18n-keys` 通过；
- 术语相关 Vitest：通过；
- 品牌、Workspace、PBL/课堂相关局部测试：通过；
- Chromium E2E：5/5 通过；
- `git diff --check`：通过；
- 390px、768px、1440px 浅色和 1440px 深色视觉检查通过；
- Playwright Chromium 已安装在本机；
- 当前没有运行中的 3000 或 3002 开发服务器。

已知但未在第一阶段处理的既有警告：

- `app/page.tsx` 的 `loadClassrooms` Hook 依赖警告；
- `components/agent/agent-bar.tsx` 的 `agent` Hook 依赖警告；
- `instrumentation.ts` 在 Next.js Edge Runtime 下使用 `process.once` 的开发期警告；
- Next.js 提示 `middleware` 文件约定将弃用。

这些警告不是第一阶段 UI 修改引入，不应在第二阶段未经评估顺带修改。

## 7. 第二阶段建议目标

第二阶段聚焦“页面结构和主要操作体验”，在第一阶段品牌外壳之上形成更明显的独立产品形态。

建议按节点执行：

1. 代码与页面现状复核
   - 检查首页、Workspace、课程列表和创建课程流程；
   - 形成第二阶段文件清单、复用组件清单和风险边界；
   - 先确认方案，再开始大范围页面调整。

2. 首页信息层级深化
   - 优化 Hero、课程生成框、最近课程和空状态；
   - 减少原版 OpenMAIC 的布局识别特征；
   - 保留所有现有入口和生成能力。

3. 我的课程体验
   - 统一课程卡片、搜索、文件夹、重命名、删除和空状态；
   - 优化课程列表在桌面、平板和移动端的层级；
   - 不改变课程数据结构和持久化逻辑。

4. Workspace 结构深化
   - 优化导航、会话区、课程区和 AI 工作台的视觉层级；
   - 统一按钮、卡片、标签、空状态和 Loading；
   - 不改变面板折叠、拖拽、URL 参数、会话和课程 Tab 行为。

5. 创建与生成流程
   - 统一需求输入、材料上传、大纲审阅、生成进度和异常状态；
   - 使用“课程讲解、理解检测、互动探索、项目实践、智能白板”产品术语；
   - 不修改 generation 和 orchestration 核心逻辑。

6. 响应式和主题验收
   - 检查 390px、768px、1440px；
   - 检查浅色与深色模式；
   - 执行局部测试、TypeScript、Lint、E2E 和视觉截图。

## 8. 第二阶段执行规则

- 每个节点开始前先检查工作区状态和相关代码；
- 每个节点只修改明确范围内的文件；
- 每个节点完成后执行局部验证；
- 不覆盖用户已有或来源不明的修改；
- 不擅自合并到 `main`；
- 不擅自推送远程仓库；
- 不在未验证状态下提交；
- 遇到冲突、测试失败、工具异常或资源问题立即停止并报告；
- 第二阶段完成并经用户验收后，再创建独立提交。

## 9. 第二阶段任务启动提示

```text
请阅读 D:\eduProjects\OpenMAIC\ZHIGOU_PHASE_1_HANDOFF.md，并以 D:\eduProjects\OpenMAIC 的 feature/ui-redesign 分支为工作基线，开始知构 AI UI 重构第二阶段。先复核当前工作区、第一阶段提交和现有页面代码，再给出第二阶段节点计划；按节点逐步执行并局部验证。保留 OpenMAIC 核心逻辑、内部技术标识和开源归属，不合并 main、不推送远程。遇到代码冲突、现有改动重叠、测试失败、资源问题或工具异常时立即停止。
```
