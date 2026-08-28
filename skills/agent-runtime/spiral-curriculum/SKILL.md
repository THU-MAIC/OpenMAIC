---
name: spiral-curriculum
title: "螺旋式课程设计"
description: "Design a multi-stage OpenMAIC course series around a small concept spine whose ideas return repeatedly at higher levels of complexity, abstraction, relationship density, representation, transfer distance, or boundary awareness. Use when the user explicitly wants a Bruner-style spiral curriculum, progressive conceptual revisits, or a series organized by how understanding develops rather than by a linear topic list. Do not use for a single standalone stage or a series that only needs sequential coverage."
---

# 螺旋式课程设计

设计一组系列课，让少数核心概念在整个系列中反复回来，并且每次都发生结构性升阶。最小设计对象是“概念脊柱 + 每个概念的遭遇史”，不是某一节课的目录。

先加载 `/stage-design` 获取单节课堂的创建基线，并加载 `/curriculum-planner` 获取多课堂文件夹、跨课堂读取和批量交付规则。本 Skill 在它们之上增加螺旋架构、升阶操作符和假螺旋检查。

## 适用范围

用于以下请求：

- 用布鲁纳螺旋式课程设计一个单元或系列课；
- 让同一批核心概念跨课重访并逐步深化；
- 以学习者理解如何发展为主线，而不是按教材章节线性排课。

不要用于：

- 单节独立课，此时使用 `/stage-design` 和相应主题 Skill；
- 只要求按顺序覆盖内容、没有概念升阶重访的系列，此时使用 `/curriculum-planner`；
- 风格复制或 PPT 直接导入，此时使用 `/style-clone` 或 `/pptx-import`。

## 第一原则：Revisit 不等于 Review

“第 1 课讲概念、第 3 课复习概念、第 6 课再复习”不是螺旋。每次重访必须明确回答：**这一次比上一次多了什么？**

每次重访至少在以下一个维度升级：

| 维度 | 初次接触 | 后续重访 |
|---|---|---|
| 复杂度 | 单一关系 | 多变量相互作用 |
| 抽象度 | 具体案例 | 一般模型 |
| 关系密度 | 孤立概念 | 与更多概念连接 |
| 表征方式 | 直观经验 | 图示、模型、符号 |
| 迁移距离 | 熟悉情境 | 陌生情境、跨领域 |
| 边界与反例 | 正例 | 反例、边界、局限 |

如果一次回来没有在任何维度更高，就只是重复，必须重写。

## 页面内容红线

`Concept Spine`、`encounter`、`growth operator`、`Spiral Contract`、`revisit`、`概念脊柱`、`遭遇史`、`●/▲/◆` 等属于教师侧规划语言。它们可以出现在对话、架构和页面 brief 中，不得出现在学生可见的标题、标签或正文。

“本次比上次多了什么”写进 brief，不写成学生页面上的“复杂度升级”标签。老师与代理的口述走 narration / actions，不写成“老师说”“学生说”的静态正文。

## 概念脊柱

不要先排课时清单。先回答：整个系列结束后，学生真正应该建立哪几个能够反复使用和迁移的核心观念？

- 每个核心概念写成一句可迁移的理解，而不是名词；
- 一个系列通常选择 3–6 个核心概念，避免过多导致每课浅尝辄止；
- 每个概念同时声明初始理解目标和最终理解目标，作为 Learner Progression 的两个端点；
- 可结合 `/understanding-by-design` 确定大概念、基本问题和表现性证据，再用本 Skill 安排跨课升阶重访。

## Spiral Map

为每个核心概念维护跨课遭遇史：直觉经验 → 机制解释 → 多变量关系 → 形式化模型 → 陌生情境迁移 → 与其他概念整合。

教师侧 Spiral Map 可以使用：

- `●`：首次接触；
- `▲`：深化；
- `◆`：综合与迁移。

每个标记旁边还必须写明本次新增结构。只有符号、没有升阶说明的表格没有价值。

## 规划一次重访

对每个 `concept + previous encounter + target growth` 决定四件事：

1. **保留什么**：哪些已有理解不需要重新教学；
2. **增加什么**：本轮新增的内容或条件；
3. **重组什么**：哪些孤立知识需要组成机制或关系；
4. **迁移到哪里**：用哪个新情境检验概念结构。

## 升阶操作符

- **ADD_COMPLEXITY**：增加变量或相互作用；
- **ADD_RELATION**：让当前概念与另一个概念形成必要关系；
- **ABSTRACT**：从案例上升到一般模型；
- **FORMALIZE**：引入符号、模型或专业语言；
- **CHANGE_REPRESENTATION**：在操作、图像模型和符号表征之间重构概念，不机械套成固定课次顺序；
- **INCREASE_TRANSFER_DISTANCE**：逐渐进入更陌生或跨领域的情境；
- **ADD_EXCEPTION**：加入反例、边界、约束或局限。

一次重访通常选择 1 个主操作符和少量辅助操作符。不要一次叠满所有操作符，那只会堆难度。

## 概念记忆

螺旋依赖跨 stage 的共享记忆。平台不会替本 Skill 自动维护概念模型，所以要在当前对话中保存教师侧运行记录，至少包含：

- concept id；
- encounter history；
- representation history；
- complexity level；
- known relations；
- misconceptions detected；
- examples used；
- transfer distance；
- mastery evidence；
- next revisit target。

开始下一课前，使用 `read_stage_outline` 回读前面课堂的持久化页面列表；需要核对真实内容时继续用 `read_stage`。不要只相信原计划，要依据已经落进课堂的内容调整本轮“保留、增加、重组、迁移”。

## 每课的 Spiral Contract

每个 stage 在教师侧规划中必须有一份 contract：

- `returning_concepts`：哪些旧概念回来；
- `new_concepts`：哪些概念第一次出现；
- `added_complexity`：比之前复杂或抽象在哪里；
- `new_relation`：新增了什么概念关系；
- `representation_shift`：是否更换表征；
- `transfer_target`：进入哪个新情境；
- `future_hook`：故意留下什么，供后续重访。

`future_hook` 允许 productive incompleteness：早期先建立可用但不完整的模型，后续再重组，不要求每课把概念彻底讲完。

## 两层设计

### 第一层：Spiral Architecture

先在对话中产出并请用户确认：

1. **Concept Spine**：每个核心概念的初始与最终理解目标；
2. **Course Timeline**：各课的主题和任务；
3. **Concept Spiral Map**：每个概念何时出现、何时回来、每次增加什么；
4. **Learner Progression**：学生理解应怎样逐课变化；
5. 每课的 Spiral Contract 和概念交叉点。

使用 `ask_user` 让用户能调整课时数、概念出现时机、深度与交叉关系。架构未确认前不要创建课堂。

### 第二层：Generate Lessons

架构确认后，默认把整个已批准系列持续建到完成，不在每课之间重复停下确认，除非用户明确要求分批验收：

1. `create_folder` 创建系列文件夹；
2. 每课调用 `create_stage`，传入该 `folderId`；
3. 每课先 `set_roster`，再按批准计划逐页 `generate_scene`；
4. 需要补写旁白时逐页 `generate_actions`，修改旁白后补 `generate_tts`；
5. 使用 `list_scenes`、`read_stage_outline` 和 `read_stage` 验收持久化结果；
6. 开始后续课堂前更新概念记忆。

架构本身只留在教师侧规划中，不生成成学生页面。

## 假螺旋检查

整套系列完成后逐概念检查：

- 同一概念多次出现但复杂度没有提升：Repeated, not spiraled；
- 后面只增加术语，没有增加结构理解：Vocabulary inflation；
- 每课都是新内容，旧概念不回来：Linear curriculum；
- 所谓回顾只发生在单元最后：Review curriculum；
- 概念回来时情境和表征完全相同：Context repetition；
- 后面只是题目更难，不是概念更深：Difficulty escalation without conceptual deepening。

命中任一项，回到对应 Spiral Contract 修改页面 brief 或课程安排，再重新验收。

## 完成标准

- 每个概念都有初始理解目标、最终理解目标和完整遭遇史；
- 每次重访都标明主升阶操作符及新增结构；
- 每课都有七字段 Spiral Contract；
- 架构先确认，确认后整个系列被持续持久化到文件夹中；
- 每课实际内容已回读，概念记忆不是只依赖原计划；
- 学生可见文字不包含螺旋元数据、规划黑话或角色台词；
- 每课仍满足 `/stage-design` 的页面、roster、持久化与音频完成标准；
- 系列通过假螺旋检查。

## 与其他教学法的关系

- `/understanding-by-design` 可先确定大概念、基本问题和表现性评估，本 Skill 负责让这些概念跨课升阶重访；
- `/feynman-learning` 在一节课堂内推动解释反复外化和重建，本 Skill 在整个系列中安排概念反复回来；
- `/learning-to-learn` 与 `/social-emotional-learning` 是平行目标，只有服务当前概念重访时才嵌入，不另起课程主线。
