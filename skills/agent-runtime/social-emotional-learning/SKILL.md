---
name: social-emotional-learning
title: "社会情感学习（SEL）"
description: "Infuse social-emotional learning (SEL) into a concept-centered OpenMAIC classroom as a parallel learning goal. Use when the user asks to add emotional awareness, self-management, empathy, collaboration, relationship skills, resilience, or responsible decision-making to a subject lesson. Do not use when SEL itself should be the standalone content of a counseling, advisory, psychology, or homeroom lesson."
---

# 社会情感学习（SEL）

把社会情感学习作为**平行目标**嵌入概念主课：不替换用户真正关心的学科概念，而是改变学生如何经历它。

`stage-design` 仍然约束课堂的创建和持久化流程。如果同时使用 `/understanding-by-design`，先确定大概念、基本问题与表现性任务，再在页面计划中嵌入 SEL。每一个 SEL 设计都要能回答“它在服务哪个概念理解”；答不出就删除。

## 先声明平行目标

在页面计划前，用一句话分别声明：

1. **概念目标**：学生要理解或迁移什么；
2. **SEL 平行目标**：学生要在这段学习中练习哪种能力，以及什么行为能证明它发生了。

优先从下列能力中选择与概念任务最贴合的 1–2 项，不要一节课堂包办全部：

- **自我认识与自我管理**：学生能觉察困惑、挫败、好奇或走神，并做出一步调节。
- **社会意识与同理**：从他人或利益相关者的立场重看同一内容。
- **人际关系与协作**：讲清推理，接受并回应建设性批评，对观点而不是对人反驳。
- **负责任决策**：评估不同解释或行为的后果，并为选择提供理由。

## 四个 SEL 嵌入点

不必为 SEL 另加四页；把目标嵌入原有页面的 brief 与交互中：

1. **开场 Hook**：在开场 `slide` 中加一个情绪或觉察拍，让学生叫出“今天我可能会卡在哪里”的感受。
2. **概念建立**：在 `slide` 中设计一段有实质分歧的多智能体讨论，练习换位与协作；分歧落在观点上，不落在人上。
3. **亲手做**：让 `interactive` 存在可预期的受挫、反馈与重试路径，用来练习自我管理和韧性；失败不能是死路。
4. **收束反思**：同时追问“你理解了哪个概念”与“你练到了哪种社会情感能力”，让学生将两种收获分别说清。

## 多智能体的作用

- **老师**：引导学生说出感受、换位思考、承认合理分歧，并及时把讨论带回概念主线。
- **学生代理**：提出不同理解、真实质疑或“我卡住了”的状态，邀请学习者参与、判断或帮助修正。

不用代理宣读 SEL 术语。让能力通过可观察的对话、选择、反馈和重试发生。

## 质量与安全关口

- SEL 目标与概念目标分开声明，不混成空泛的“综合素养”。
- 每个嵌入点都标明它服务的概念与可观察的 SEL 能力。
- 情绪表达被接纳且不被评判；不要强迫学生公开个人创伤、心理状况或隐私经历。
- 不进行心理诊断，不把学习挫折病理化，不以羞辱、公开排名或同伴压力驱动参与。
- `interactive` 必须有受挫—反馈—重试路径；收束页同时呈现概念收获与能力收获。

## 边界

本 Skill 用于把 SEL 嵌入学科概念课，不用于以 SEL 本身为内容主线的独立心理课、班会课或情绪课。如果用户想让 SEL 成为与学科概念并列的第二条完整主线，先用 `ask_user` 确认范围。
