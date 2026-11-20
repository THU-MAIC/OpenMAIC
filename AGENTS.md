# Agent Guidance

Guidance for coding agents working in this repository, including the automated Codex review that runs on every non-draft pull request. The contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Code Review Rules

### Severity

- P1 is only for problems that produce wrong behavior at runtime: user-visible breakage, data loss, data exposed across owners, an authentication or access-control bypass, a storage migration that fails on an existing database, a published package that ships broken, or a leaked secret.
- Inaccuracies that only affect documentation, comments, skill text or the PR description are at most P2. Do not report wording that cannot cause a failure or a wrong action.
- Do not report pure style, naming or readability preferences.

### Context and scope

- Read the PR description before reviewing. Do not raise an issue the description already accounts for (handled in another PR or issue, or a deliberate trade-off with its reason) unless you can show that explanation is wrong.
- Do not raise again an issue whose thread already has a reply explaining why it stays.
- When reviewing new commits, report only problems introduced or exposed by the new or changed code. Do not add edge cases on code the push did not touch.
- Do not report pre-existing behavior that the PR does not change.
- When a fix needs changes outside the PR (callers, documentation, other packages), name the file paths.

### Focus areas

- Owner scoping: reads and writes of courses, sessions, materials and settings stay within the requesting owner.
- Storage schema changes (`packages/@openmaic/storage`): compatible with databases that are already deployed.
- Published packages (`packages/@openmaic/*`): a change to published behavior comes with the version bump described in [Changing a Published Package](CONTRIBUTING.md#changing-a-published-package).
- Provider neutrality: shared layers do not hard-code a specific model or service vendor; vendor-specific behavior stays in that provider's module.
- Server-side requests to user-supplied URLs go through the existing URL guard.

<!-- openmaic-staging:private BEGIN — this section exists only in the private staging repo and must never reach the public repo -->

## Staging review: leak prevention (private, P1)

This repository is the private pre-review stage for contributions to the public OpenMAIC repository. After review, every PR here is published to the public repo verbatim: its final diff (as one squashed commit), file names, the PR title (as the commit message), the PR body, and the Co-Authored-By trailers of its commits. Review the commit messages too, since they are visible here and may be reused. A PR that only adds `drafts/issue-<slug>.md` is an issue draft; the whole file becomes a public issue.

In addition to the normal Code Review Rules above, review every PR here against the policy below.

- Report **every** leak as **P1**, including ones in commit messages, file names, the PR title or body, and content that a later commit in the same PR removes (history is published too).
- Judge by meaning, not by keywords. The examples are not exhaustive.
- For each finding, quote the text, name the category, and suggest an English rewrite.
- Do not mention this staging repository in suggested rewrites.

Policy (maintained in Chinese by the team; apply it as written):

### 判断方法

按**意思**判断，不按词表判断。下面的例子只用于说明每一类，并不完整；换个写法、缩写、下划线或驼峰拼写、翻译成英文，都同样算泄露。

对每一处新增内容问一句：**一个只看得到公开仓库的陌生人，读到这里会不会知道我们内部组织、部署、用户、业务或工具链的某件事？** 如果会，就是泄露。这个陌生人读到时，内容如果已经出现在公开仓库 main 上，就不算新泄露。

### 泄露类别

1. **内部仓库、组织、路径和编号**：私有 monorepo 及其组织名（MAIC-Mono、CogEvol）、内部子项目（openmaic-live 的任何拼写，例如 `openmaic_live`、`OpenMAIC Live`；maic-algo、services/backend、apps/maic-*、olive）、私有预审仓本身及其 PR 编号、指向私有仓库的 `#数字` 或链接、内部分支和 worktree 名。
2. **在运营线上服务这件事本身**：production、prod、线上、真实用户、DAU、遥测、用户数、学习者数、课程数、调用量、时间窗口、成本或耗时统计、线上日志、线上数据库的表名或库名、线上用的模型、从线上数据得到的评测或缓存结果。即使是公开 live demo 的运营数字也不能写。验证过程要写成通用说法，例如「一组能复现问题的 prompt」「a small offline eval」。
3. **内部基础设施、供应商和域名**：maic.chat、cogevol.com、平台或管理后台域名、飞书或 Lark 链接、Nacos、ACK、ESA、SLS、MSE、MaaS、ops 网关（maic-ops-*）、百炼（bailian）、内部 IP、主机名、集群和命名空间、任何凭据或 key。
4. **业务和策略**：计费、额度、credit、配额、付费墙、Token Plan、客户、合作方、-live 的产品路线和灰度方案、品牌（如紫育）、内部人员姓名或飞书账号、Mono 层面的架构或整合计划。
5. **agent 和工具链残留**：Claude 会话链接（`claude.ai/code/session_…`）和 `Claude-Session:` trailer（署名只保留 `Co-Authored-By` 和 `Generated with Claude Code` 那一行）、本机绝对路径（`/Users/…`）、`_` 开头的临时报告、`.log`、调试输出、内部 skill 名或流程名。
6. **数据产物**：`eval/`、`cache/`、fixture、截图、录屏里来自线上或内部系统的数据、账号、界面。评测证据只放在私有侧，公开 PR 里用文字给出结论。评审人要求作者补的验证截图、录屏，如果是本地运行、用虚构数据，而且画面里没有其他各类内容，可以公开。
7. **语言**：公开仓库只用英文。代码注释、commit message、PR 和 issue 正文里不能出现中文；需要引用中文界面文案时翻译成英文，测试 fixture 本身是多语言数据的除外，但要逐条确认。截图、录屏里出现的产品界面文案，如果已经在公开仓库 main 上，不算。

### 要读的范围

必须全部读完，不能只看最终 diff：

- `base..HEAD` 中**每个 commit** 相对其父提交的完整 diff：中间 commit 加入、后来又删掉的内容，也会随 git 历史公开；
- 每个 commit 的 message 和 trailer；
- 新增或改名的文件路径和文件名，包括二进制文件，二进制文件至少要确认文件名和来源；
- PR 或 issue 的标题和正文，以及要发的评论、评审回复。

### 输出

结论只有两种：`PASS`，或者 `FAIL`。只要有一处泄露就是 `FAIL`。

每一处发现都要写清：位置（commit 和文件行、正文第几段）、原文摘录、属于哪一类、为什么算泄露、建议的改写。拿不准的也要列出来，标成「需确认」，由发起人改写或说明理由。

### 发现以后

- 还没公开：改写；已经 commit 的，在推送前改写历史（rebase 或 amend），然后从头再审一遍。
- 已经公开：停下来报告维护者，不要自行 force-push 公开分支，也不要删帖。正文和评论的一般性改写由维护者决定。

<!-- openmaic-staging:private END -->
