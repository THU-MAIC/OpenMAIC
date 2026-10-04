<!-- <p align="center">
  <img src="assets/logo-horizontal.png" alt="OpenMAIC" width="420"/>
</p> -->

<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC Banner" width="680"/>
</p>

<p align="center">
  一键生成沉浸式多智能体互动课堂。
</p>

<p align="center">
  <a href="https://my.feishu.cn/wiki/UIfKw9Knti0LcKkTxDNcqlUrnzh"><img src="https://img.shields.io/badge/%F0%9F%93%99%20%E4%BD%93%E9%AA%8C%E6%8C%87%E5%8D%97-v1.0.0%20%C2%B7%20%E4%B8%AD%E6%96%87-FF6B35?style=for-the-badge" alt="v1.0.0 体验指南（中文）"/></a>
  &nbsp;&nbsp;
  <a href="https://lcn6dqn3m0yr.feishu.cn/wiki/CkQSwHFdzibQFvkGzwPcmUOfnXg"><img src="https://img.shields.io/badge/%F0%9F%93%98%20User%20Guide-v1.0.0%20%C2%B7%20English-4F8EF7?style=for-the-badge" alt="v1.0.0 User Guide (English)"/></a>
</p>

<p align="center">
  <a href="https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0"><img src="https://img.shields.io/badge/Paper-JCST'26-blue?style=flat-square" alt="Paper"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License: MIT"/></a>
  <a href="https://open.maic.chat/"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=flat-square" alt="Live Demo"/></a>
  <a href="#-agent-工作台集成"><img src="https://img.shields.io/badge/OpenClaw-集成-F4511E?style=flat-square" alt="OpenClaw 集成"/></a>
  <a href="#lemonade-local-ai"><img src="https://img.shields.io/badge/Lemonade-Local_AI-FFD43B?style=flat-square" alt="Lemonade Local AI"/></a>
  <a href="https://github.com/THU-MAIC/OpenMAIC/stargazers"><img src="https://img.shields.io/github/stars/THU-MAIC/OpenMAIC?style=flat-square" alt="Stars"/></a>
  <br/>
  <a href="https://discord.gg/p8Pf2r3SaG"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"/></a>
  &nbsp;
  <a href="community/feishu.md"><img src="https://img.shields.io/badge/Feishu-飞书交流群-00D6B9?style=for-the-badge&logo=bytedance&logoColor=white" alt="飞书群"/></a>
  <br/>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/LangGraph-1.1-purple?style=flat-square" alt="LangGraph"/>
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"/>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README-zh.md">简体中文</a>
  <br/>
  <a href="https://open.maic.chat/">在线体验</a> · <a href="#-快速开始">快速开始</a> · <a href="#lemonade-local-ai">Lemonade</a> · <a href="#funasr-local-asr">FunASR</a> · <a href="#-功能特性">功能特性</a> · <a href="#-使用场景">使用场景</a> · <a href="#-agent-工作台集成">OpenClaw</a>
</p>


## 🗞️ 动态

- **2026-10-04** — [v1.2.0-rc.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.2.0-rc.1)（预发布）：**服务端优先。** 1.1.x 及以前，课程生成由浏览器一步步驱动，课程、密钥和模型设置也都存在浏览器里：关掉页面课程就停在半路，每个浏览器都要单独配置，无头 API 还是另一套流水线。1.2.0 把这些都交给服务端：生成在服务端运行，关页面、重启都不中断；模型在 `openmaic.yml` 里统一配置（默认值、锁定、可禁止用户自带密钥）；资料添加即解析；网页端和 API 共用同一条流水线。需要 PostgreSQL 和常驻的 Node 服务，Vercel 部署请继续使用 1.1.x。升级前请先阅读[更新日志](CHANGELOG.md)。
- **2026-09-28** — [v1.1.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.2)：安全更新——provider 请求只连接已校验地址并拒绝重定向（[GHSA-g87c-cm4q-cw5x](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-g87c-cm4q-cw5x)）。
- **2026-09-27** — [v1.1.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.1)：安全更新——加固 MinerU Cloud 文档解析（[GHSA-cpjc-vgjh-c5jp](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-cpjc-vgjh-c5jp)）。
- **2026-09-24** — [v1.1.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.0)：课堂对话改为 Agent 循环（可针对幻灯片元素、交互组件、白板内容提问）；设置按课程流程重构；Token Plan 一键接入。
- **2026-09-15** — [v1.0.3](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.3)：安全更新——访问码令牌过期、渲染服务网络策略、音频连接固定、修复 Next.js RCE。
- **2026-09-14** — [v1.0.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.2)：安全更新——修复 SSRF、DNS 重绑定与课堂覆盖问题。
- **2026-09-06** — [v1.0.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1)：安全与稳定性更新，收紧两项默认配置。
- **2026-08-27** — **v1.0.0**：Agent 工作台、持久会话、可复用技能、会话资料、厂商中立的服务端能力。

<details>
<summary>更早版本</summary>

- **2026-08-14** — [v0.3.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.2)：视频导出加固、服务端持久化与资产注册中心、`@openmaic/generation`、四种新语言、FunASR。
- **2026-07-21** — [v0.3.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.1)：一键导出 MP4、直接编辑幻灯片元素、“Edit with AI”升级、文档解析扩展。
- **2026-06-28** — [v0.3.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.0)：PBL v2、“Edit with AI”编辑智能体、`@openmaic/*` SDK 发布到 npm、协议改为 MIT。
- **2026-06-02** — [v0.2.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.2.2)：MAIC Editor 专业模式、可编辑大纲、课堂离线导出。
- **2026-04-26** — [v0.2.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.2.1)：VoxCPM2 TTS 与音色克隆、按模型思考配置、课程完成页。
- **2026-04-20** — **v0.2.0**：深度交互模式——3D、模拟实验、游戏、思维导图、在线编程。
- **2026-04-14** — [v0.1.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.1.1)：自动语言推断、ACCESS_CODE、课堂 ZIP 导入导出、Ollama。
- **2026-03-26** — [v0.1.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.1.0)：讨论语音、沉浸模式、键盘快捷键。

</details>

完整历史见[更新日志](CHANGELOG.md)。

## 📖 项目简介

**OpenMAIC**（Open Multi-Agent Interactive Classroom）是一个开源的 AI 互动课堂平台，能够将任何主题或文档转化为丰富的互动学习体验。基于多智能体协作引擎，它可以自动生成演示幻灯片、测验、交互式模拟实验和项目制学习活动——由 AI 教师和 AI 同学进行语音讲解、白板绘图，并与你展开实时讨论。内置 OpenMAIC Skill，可以在 [OpenClaw](https://github.com/openclaw/openclaw) 以及 Codex、DeepSeek、WorkBuddy 等 Agent 工作台中使用，直接在飞书、Slack、Telegram 等聊天应用或 IDE 里生成课堂。

https://github.com/user-attachments/assets/f4a2f1be-6615-4330-aea1-b86ccf42045e

### 核心亮点

- **一键生成课堂** — 描述一个主题或附上学习材料，AI 几分钟内构建完整课堂
- **多智能体课堂** — AI 老师和智能体同学实时授课、讨论、互动
- **丰富的场景类型** — 幻灯片、测验、HTML 交互式模拟、项目制学习（PBL）
- **白板 & 语音** — 智能体实时绘制图表、书写公式、语音讲解
- **灵活导出** — 下载可编辑的 `.pptx` 幻灯片或交互式 `.html` 网页
- **[Agent 工作台集成](#-agent-工作台集成)** — OpenMAIC Skill 支持 OpenClaw、Codex、DeepSeek、WorkBuddy 等，在飞书、Slack、Telegram 等 20+ 聊天应用或 IDE 里直接生成课堂

## 🚀 快速开始

### 环境要求

- **Node.js** >= 22.19
- **pnpm** >= 10
- **PostgreSQL** 16——课程保存在服务端。本地开发可用 `pnpm db:up` 在 Docker 中启动一个。

### 1. 克隆 & 安装

```bash
git clone https://github.com/THU-MAIC/OpenMAIC.git
cd OpenMAIC
pnpm install
```

### 2. 配置

```bash
cp .env.example .env.local            # API Key 与服务端选项
cp openmaic.example.yml openmaic.yml  # 服务端使用哪些模型
```

复制出的示例只需要在 `.env.local` 中设置 `OPENAI_API_KEY`（也可以把其中的服务商换成你有 key 的那家）；其余内容都已注释，需要时再打开。`openmaic.yml` 声明服务端可以调用的**服务商**（账号），并为每个**槽位**（一处用到 AI 的地方：大纲、幻灯片内容、语音合成、联网搜索……）指定模型。Key 留在 `.env.local` 里，通过 `${VAR}` 引用：

```yaml
providers:
  openai:
    preset: openai
    apiKey: ${OPENAI_API_KEY}      # 在 .env.local 里写 OPENAI_API_KEY=sk-...
  anthropic:
    preset: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

slots:
  llm: openai:gpt-5.5              # 默认对话模型
  course.outline: anthropic:claude-sonnet-4-6
  video: null                      # 关闭某项能力
```

写进文件的槽位是服务端默认值；除非用 `lock` 锁定或设置 `allowUserKeys: false`，用户可以在 Web 端的模型设置里修改它们，或接入自己的服务。服务启动时会校验该文件，出错时会指出出错的字段（YAML 语法错误则指出行号）。

| 想了解 | 阅读 |
| --- | --- |
| 槽位、预设、回退模型、`lock`、`allowUserKeys`、`OPENMAIC_SECRET_KEY` | [配置说明](packages/docs/content/docs/configuration.zh-cn.mdx) |
| 所有服务商预设与模型 ID | [支持的模型](packages/docs/content/docs/supported-models.zh-cn.mdx) |
| 升级：没有 `openmaic.yml` 时，服务商环境变量、`server-providers.yml`、`DEFAULT_MODEL` 和 `MODEL_FALLBACK` 仍然有效；`MODEL_ROUTES` 需改写为槽位 | [从旧配置迁移](packages/docs/content/docs/configuration.zh-cn.mdx#从旧配置迁移) |

**支持的服务商：** OpenAI、Azure OpenAI、Anthropic、Amazon Bedrock、Google Gemini、DeepSeek、通义千问 Qwen、Kimi、MiniMax、Grok (xAI)、OpenRouter、TokenDance、豆包、腾讯混元 / TokenHub、小米 MiMo、智谱 GLM、Ollama、[Lemonade](#lemonade-local-ai) 与 [FunASR](#funasr-local-asr)（本地），以及任何兼容 OpenAI API 的服务。

> [!TIP]
> **推荐配置：** 打开全部模态时 OpenMAIC 效果最好——配图、语音讲解、视频片段与联网检索都会参与生成。最省事的方式是用一个 Key 覆盖全部模态（见下方的 Token Plan 示例），默认模型选 `deepseek-v4.1-flash` 这类速度快、长上下文的模型即可。

<details>
<summary><b>更多示例</b>：Token Plan、小米 MiMo 与智谱 GLM、Amazon Bedrock</summary>

Token Plan 快速示例（一个 Key 同时覆盖对话、图像、视频、TTS 与联网搜索；`tokendance` 用法相同）：

```yaml
providers:
  minimax:
    preset: minimax
    apiKey: ${MINIMAX_API_KEY}

slots:
  llm: minimax:MiniMax-M3
  image: minimax                   # 只写服务商 ID：使用该套餐的默认模型
  video: minimax
  tts: minimax
  webSearch: minimax
```

TokenDance 快速示例（默认模型选速度快、长上下文的模型）：

```yaml
providers:
  tokendance:
    preset: tokendance
    apiKey: ${TOKENDANCE_API_KEY}

slots:
  llm: tokendance:deepseek-v4.1-flash
  image: tokendance
  video: tokendance
  tts: tokendance
  webSearch: tokendance
```

小米 MiMo Token Plan 与智谱 GLM 快速示例：

```yaml
providers:
  mimo:
    preset: xiaomi
    apiKey: ${MIMO_API_KEY}
    baseUrl: https://token-plan-cn.xiaomimimo.com/v1
  glm:
    preset: glm
    apiKey: ${GLM_API_KEY}
    baseUrl: https://open.bigmodel.cn/api/paas/v4   # 国际站用 https://api.z.ai/api/paas/v4

slots:
  llm: mimo:mimo-v2.5-pro
  course.content: glm:glm-5.1
```

新加坡或欧洲 Token Plan 集群可分别使用 `https://token-plan-sgp.xiaomimimo.com/v1`、`https://token-plan-ams.xiaomimimo.com/v1`。

Amazon Bedrock 快速示例：

```yaml
providers:
  bedrock:
    preset: bedrock
    models: [us.anthropic.claude-sonnet-5, us.anthropic.claude-opus-4-8]

slots:
  llm: bedrock:us.anthropic.claude-sonnet-5
```

Bedrock 使用 AWS 环境凭证或 AWS SDK 凭证链，区域取自 `BEDROCK_REGION`（例如在 `.env.local` 中设置 `BEDROCK_REGION=us-east-1`）。临时凭证可设置 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` 和 `AWS_SESSION_TOKEN`，也可以使用运行环境可用的 AWS profile / role。

</details>

### 3. 启动数据库

```bash
pnpm db:up
```

然后取消 `.env.local` 中本地 `DATABASE_URL` 那一行的注释：

```env
DATABASE_URL=postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic
```

`pnpm db:up` 会在 `127.0.0.1:5432` 上启动一个开发用 PostgreSQL（可用 `OPENMAIC_DB_PORT` 换端口）。它是单独的 Compose 项目 `openmaic-dev-db`（本机所有检出共用），有自己的容器和数据卷，不会影响 `docker compose up` 栈的数据库。`pnpm db:down` 停止它并保留数据。也可以使用任何其他 PostgreSQL。

### 4. 启动

```bash
pnpm dev
```

打开 **http://localhost:3000** 开始学习！未设置 `DATABASE_URL` 时服务会拒绝启动，并提示如何提供（见[服务端持久化](#服务端持久化postgresql)）。

### 5. 生产环境构建

```bash
pnpm build && DATABASE_URL=postgres://... pnpm start
```

请让服务作为常驻进程运行（进程管理器或容器）：课程生成在其中进行，浏览器离开页面后仍会继续。必需配置和从 1.1.x 升级的步骤见[部署指南](packages/docs/content/docs/deployment.zh-cn.mdx)。

### Docker 部署

```bash
cp .env.example .env.local
# 编辑 .env.local 填入你的 API Key，然后：
docker compose up --build
```

打开 **http://localhost:3000**。整套服务是两个容器：应用和 PostgreSQL。课程、生成的媒体和运行时会话保存在命名卷 `openmaic-postgres` 与 `openmaic-data` 中，`docker compose down` 和重新构建后依然保留；`docker compose down -v` 会删除它们。如需用 `openmaic.yml` 配置模型，请从 `openmaic.example.yml` 复制出该文件，并取消 `docker-compose.yml` 中对应挂载行的注释；否则启动后在模型设置里接入模型服务即可。

Compose 文件默认是**个人安装**：以[单用户模式](#服务端持久化postgresql)运行（所有浏览器看到同一个课程库），且只监听 `127.0.0.1:3000`。要让其他机器访问，请先加上保护：

1. 在 `.env.local` 中设置足够长的随机 `ACCESS_CODE`（[详情](#可选access_code共享部署)）。没有它时，任何能访问该端口的人都拥有整个课程库，可以编辑甚至删除。
2. 首次启动前，把 `PERSISTENCE_POSTGRES_PASSWORD` 设为只含字母和数字的随机值。
3. 发布到网络地址：

   ```bash
   OPENMAIC_PUBLISH_ADDRESS=0.0.0.0 docker compose up -d --build
   ```

`OPENMAIC_PUBLISH_ADDRESS`、`OPENMAIC_PORT` 和 `PERSISTENCE_POSTGRES_PASSWORD` 来自 shell 或 `docker-compose.yml` 旁边的 `.env` 文件，而不是 `.env.local`。覆盖 Compose 默认值、轮换数据库密码以及完整的升级说明见 [Hosting and identity](packages/docs/content/docs/hosting.mdx#docker-compose-as-a-personal-installation)（英文）。

> [!IMPORTANT]
> **升级已有的 Compose 部署？** 现在总会启动 PostgreSQL，应用只发布在 `127.0.0.1` 上，所有访客都是同一个所有者。如果 `.env.local` 设置了 `PERSISTENCE_SHARED_OWNER_ID`，请同时设置 `OWNER_SINGLE_USER=false`，否则应用拒绝启动。升级前请先阅读 [Upgrading a Compose deployment](packages/docs/content/docs/hosting.mdx#upgrading-a-compose-deployment)（英文）。

<details>
<summary><b>慢速网络 / 中国大陆构建加速</b></summary>

Docker 构建支持两个可选参数。两者默认均为空，因此上面的标准命令仍会使用
Alpine 和 npm 的上游软件源。

- `ALPINE_MIRROR` 接收不带 `https://` 的 Alpine 镜像站主机名。
- `NPM_REGISTRY` 接收完整的 npm registry URL。

这些构建参数仅用于公共镜像地址。请勿在其中嵌入用户名、密码或访问令牌，因为
Docker 可能把构建参数记录到镜像元数据或构建证明中。

使用 Docker Compose：

```bash
ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up --build
```

直接构建镜像：

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t openmaic:local .
```

这些参数不会加速 Docker Hub 拉取，包括 Dockerfile frontend 和
`node:22-alpine` 基础镜像。若这些步骤较慢，需要单独配置 Docker daemon 的
registry mirror。同一个 BuildKit builder 会在常规缓存清理前跨构建复用 pnpm
store；缓存只用于提升性能，不是正确完成构建的必要条件。

</details>

### Vercel 部署（1.1.x 及以前）

Serverless 部署支持到 OpenMAIC 1.1.x。从 1.2.0 起，课程生成在服务端一个比请求存活更久的进程中运行，因此 OpenMAIC 需要常驻的 Node.js 进程和 PostgreSQL（[Docker 部署](#docker-部署)或 `pnpm start`）；不再支持 Vercel 等 Serverless 平台，仓库中也不再提供 `vercel.json`。在 Vercel 上部署 1.1.x：

1. 在 GitHub 上 fork 本仓库，取消勾选 **Copy the `main` branch only**。
2. 在 fork 中把默认分支设为 `release/1.1.x`（**Settings → General → Default branch**）。
3. 在 Vercel 中 **Add New → Project** 导入这个 fork。Vercel 构建它的默认分支；按该分支的 [`.env.example`](https://github.com/THU-MAIC/OpenMAIC/blob/release/1.1.x/.env.example) 至少配置一个 LLM 服务的 key。

这样的部署之后可以迁移到常驻主机而不丢失数据：把新主机的 `DATABASE_URL` 指向原来使用的数据库（如果用过），并沿用同一个访问地址（浏览器按站点保存数据）；访客浏览器中的课程会在每个浏览器首次打开升级后的应用时导入。各类部署的升级步骤见[从 1.1.x 升级](packages/docs/content/docs/deployment.zh-cn.mdx)。

### 服务端持久化（PostgreSQL）

OpenMAIC 把课程保存在服务端。课程文档、文件夹、对话历史、学习者会话和生成的媒体保存在 PostgreSQL 中（媒体也可放在 S3），由应用自身在 `/api/persistence` 提供服务。浏览器只保留属于该设备的数据，如设置、播放进度和缓存；**设置 → 清除本地缓存**不会动服务端的任何数据。

- **必须提供 `DATABASE_URL`。** 没有它服务会输出修复方法并以退出码 `1` 退出。Compose 会自动设置；本地开发可用 [`pnpm db:up`](#3-启动数据库) 启动数据库。
- **旧版本保存在浏览器中的课程**会在每个浏览器首次打开升级后的应用时自动导入一次，浏览器中的原始数据保持不变。
- **配置无效时服务不会启动**，会输出一行 `[boot]` 原因，而不是留下一个对每个请求都返回 `500` 的进程。

**课程归谁所有。** 每个请求都会解析为一个所有者，每个所有者有自己的课程库。请选择一种身份模式：

| 模式 | 设置 | 课程库 |
| --- | --- | --- |
| 单用户（Compose 默认） | `OWNER_SINGLE_USER=true` | 所有能访问服务的人共用一个；请用 `ACCESS_CODE` 或回环地址保护 |
| 共享团队 | `PERSISTENCE_SHARED_OWNER_ID=<id>`，并同时设置 `ACCESS_CODE` | 访问码背后的团队共用一个 |
| 匿名（两者都不设置时的默认） | 无 | 每个浏览器 cookie 一个；换一个浏览器看到的是空课程库 |
| 自有账号 | 在 `instrumentation.ts` 中注册所有者认证方法 | 每个登录账号一个 |

请在首次启动 1.2.0 之前设置好身份模式：1.1.x 以文件形式保存的课堂会导入给届时配置的所有者。各类部署的升级步骤见[从 1.1.x 升级](packages/docs/content/docs/deployment.zh-cn.mdx)。

为他人运行 OpenMAIC，或把它嵌入自己的产品？[Hosting and identity](packages/docs/content/docs/hosting.mdx)（英文）介绍了：

- [谁能读写存储的数据](packages/docs/content/docs/hosting.mdx#who-can-read-and-write-stored-data)，以及已移除的 `PERSISTENCE_DEV_TOKEN`；
- [资产回收、配额与 S3 出站](packages/docs/content/docs/hosting.mdx#asset-storage)（`ASSET_*`）；
- [全部启动检查](packages/docs/content/docs/hosting.mdx#startup-checks)；
- [所有者身份](packages/docs/content/docs/hosting.mdx#owner-identity)：[单用户模式](packages/docs/content/docs/hosting.mdx#single-user-mode)、[注册认证方法](packages/docs/content/docs/hosting.mdx#registering-owner-auth-methods)、[签名 JWT 网关示例](packages/docs/content/docs/hosting.mdx#recipe-accounts-through-an-identity-gateway-signed-jwt)和[认领匿名工作](packages/docs/content/docs/hosting.mdx#claiming-anonymous-work)；
- [宿主扩展钩子](packages/docs/content/docs/hosting.mdx#host-extension-hooks)：课程创建、课程库、上传和资产字节存储。

### 可选：ACCESS_CODE（共享部署）

为部署添加站点级密码保护，在 `.env.local` 中设置：

```env
ACCESS_CODE=your-secret-code
```

请使用足够长的随机值（至少 16 个字符）：它是保护部署的唯一密钥。设置后，访客需要输入密码才能使用，所有 API 路由也会受到保护。未设置时（`.env.example` 的默认），`middleware.ts` 不校验任何凭证，所有路由（包括 API）均可访问：未配置的部署没有门禁，也没有第二道校验。验证结果以签名令牌保存在 HTTP-only cookie 中，有效期 7 天；只有在可信反向代理之后并设置 `TRUST_PROXY_HEADERS=true` 时才会限流。详见[配置说明 → ACCESS_CODE](packages/docs/content/docs/configuration.zh-cn.mdx#access_code--站点级访问密码)。

<a id="lemonade-local-ai"></a>

### 可选：Lemonade（本地 AI 服务商）

OpenMAIC 支持将 Lemonade 作为本地 OpenAI 兼容服务商使用，可用于 LLM、图像生成、TTS 和 ASR，不需要 API Key。

本地启动 Lemonade 后，在 OpenMAIC 中配置：

```yaml
providers:
  lemonade:
    preset: lemonade
    baseUrl: http://localhost:13305/v1
  lemonade-tts:
    preset: lemonade-tts
    baseUrl: http://localhost:13305/v1
  lemonade-asr:
    preset: lemonade-asr
    baseUrl: http://localhost:13305/v1
  lemonade-image:
    preset: lemonade-image
    baseUrl: http://localhost:13305/v1

slots:
  llm: lemonade:Gemma-4-26B-A4B-it-GGUF
  tts: lemonade-tts
  asr: lemonade-asr
  image: lemonade-image
```

旧版环境变量的等价写法是 `LEMONADE_BASE_URL`、`TTS_LEMONADE_BASE_URL`、`ASR_LEMONADE_BASE_URL` 和 `IMAGE_LEMONADE_BASE_URL`。

<a id="funasr-local-asr"></a>

### 可选：FunASR（本地语音识别）

OpenMAIC 可以通过 FunASR 的 OpenAI 兼容服务完成本地转写。内置 provider 支持 SenseVoiceSmall、Paraformer 和 Fun-ASR-Nano，无需 API Key。

```bash
python -m pip install torch torchaudio
python -m pip install "funasr==1.4.0" fastapi uvicorn python-multipart
# NVIDIA GPU 上运行 Fun-ASR-Nano 时再安装 vLLM
python -m pip install vllm
funasr-server --device cuda --model fun-asr-nano
```

将 OpenMAIC 指向该服务：

```yaml
providers:
  funasr:
    preset: funasr-asr
    baseUrl: http://localhost:8000/v1

slots:
  asr: funasr
```

（旧版环境变量写法：`ASR_FUNASR_BASE_URL=http://localhost:8000/v1`。）

纯 CPU 环境可运行 `funasr-server --device cpu --model sensevoice`。生产部署方式参见 [FunASR 部署指南](https://github.com/modelscope/FunASR#deploy)。

### 可选：MP4 视频导出（渲染服务）

“导出视频”菜单在浏览器内构建一个自包含的 [Hyperframes](https://www.npmjs.com/package/@hyperframes/producer) 项目。要把它变成 MP4 需要 Chromium + FFmpeg（Node 22），因此运行在独立的 `render-service` 容器中，而不在应用内。

它是可选的，通过 `video-export` compose profile 启动：

```bash
docker compose --profile video-export up --build
```


### 可选：MinerU（增强文档解析）

[MinerU](https://github.com/opendatalab/MinerU) 提供更强的表格、公式和 OCR 解析能力。你可以使用 [MinerU 官方 API](https://mineru.net/) 或[自行部署](https://opendatalab.github.io/MinerU/quick_start/docker_deployment/)。

在 `openmaic.yml` 中声明它并分配给 `document` 槽位：官方 API 使用 `mineru-cloud`，自行部署的实例使用 `mineru` 并填写其 `baseUrl`。

```yaml
providers:
  mineru:
    preset: mineru-cloud
    apiKey: ${PDF_MINERU_CLOUD_API_KEY}

slots:
  document: mineru
```

没有 `openmaic.yml` 时，在 `.env.local` 中设置旧版变量 `PDF_MINERU_CLOUD_API_KEY` 或 `PDF_MINERU_BASE_URL` 仍然有效。

### 可选：VoxCPM2（自托管 TTS，支持音色克隆）

[VoxCPM2](https://github.com/OpenBMB/VoxCPM) 是 OpenBMB 开源的 TTS 模型，支持声音克隆。OpenMAIC 自带适配器，把 VoxCPM 跑在自己机器上即可对接。

**1. 部署 VoxCPM 后端。** 三种部署形态，背后是同一套 OpenMAIC 适配器，在 `openmaic.yml` 中用 `options.backend` 选择（见第 2 步）。

| 后端 | 接口 | 适用场景 |
| --- | --- | --- |
| **vLLM-Omni** | `/v1/audio/speech` | OpenAI 兼容的语音接口，适合 GPU 服务器 |
| **Python API** | `/tts/upload` | 官方 VoxCPM Python 运行时（FastAPI） |
| **Nano-vLLM** | `/generate` | 轻量级 Nano-vLLM FastAPI 部署 |

每种后端的具体启动步骤见 [VoxCPM 仓库](https://github.com/OpenBMB/VoxCPM)。

**2. 在 OpenMAIC 中配置。** VoxCPM2 运行在你自己的网络中，因此由部署在 `openmaic.yml` 中配置（不需要 API Key）；工作区不能在 **设置 → 模型服务** 中添加它：

```yaml
providers:
  voxcpm:
    preset: voxcpm-tts
    baseUrl: http://localhost:8000/v1
    options:
      backend: vllm-omni          # vllm-omni（默认）| python-api | nano-vllm

slots:
  tts: voxcpm
```

音色注册只在 `vllm-omni` 后端可用；`python-api` 和 `nano-vllm` 会随每次请求发送音色提示。

没有 `openmaic.yml` 时，旧版的 `TTS_VOXCPM_BASE_URL=http://localhost:8000/v1` 可以设置端点，但无法选择后端。

**3. 管理音色。** 把 VoxCPM2 分配给 `tts` 槽位后，打开 **设置 → 模型服务 → 语音合成 → VoxCPM2**（只有 `tts` 解析到 `voxcpm-tts` 服务商时才会出现音色管理）。三种音色模式：

<img src="assets/voxcpm/voxcpm-voice-manager.png" width="85%" alt="VoxCPM2 音色管理：Auto / Prompt / Clone 三种模式" />

- **Auto Voice**（默认）：合成时根据每个智能体的人设动态生成 voice prompt，零配置。
- **Prompt 音色**：用自然语言描述音色，例如 *"温暖的女性教师嗓音，平静而鼓励，中等音调"*。
- **Clone 音色**：上传一段参考音频或在浏览器里录一段。音频保存在当前浏览器（IndexedDB）中，每次合成时发给后端。

---

## ✨ 功能特性

### 深度交互模式（新功能）

**被动听讲？❌  动手探索！✅**

爱因斯坦说过：*"玩耍是最高形式的研究。"*

**标准模式**快速生成课堂内容，而**深度交互模式**更进一步——创建交互式、可探索、动手的学习体验。学生不只是观看知识，而是调整实验、观察模拟、主动探索原理。

#### 五种交互界面

<table>
<tr>
<td width="50%" valign="top">

**🌐 3D 可视化**

三维可视化呈现，让抽象结构更直观。

<img src="assets/interactive_mode/3D_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**⚙️ 模拟实验**

流程模拟和实验环境，观察动态变化和结果。

<img src="assets/interactive_mode/simulation_interactive.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🎮 游戏**

知识小游戏，通过交互挑战加深理解和记忆。

<img src="assets/interactive_mode/game_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🧭 思维导图**

结构化知识组织，帮助学习者建立整体概念框架。

<img src="assets/interactive_mode/mindmap_interactive.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**💻 在线编程**

浏览器内编码和即时运行，边写边学边迭代。

<img src="assets/interactive_mode/code_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

</td>
</tr>
</table>

#### AI 教师引导

AI 教师可以主动操作界面引导学生——高亮关键区域、设置条件、提供提示、在恰当时机引导注意力。

<img src="assets/interactive_mode/teacher_action_interative.gif" width="100%"/>

#### 多设备适配

所有生成的交互界面完全响应式——桌面、平板、手机均可使用。

<table>
<tr>
<td width="50%" align="center">

**桌面**

<img src="assets/interactive_mode/desktop_interactive.png" width="90%"/>

</td>
<td width="50%" align="center" rowspan="2">

**手机**

<img src="assets/interactive_mode/phone_interactive.png" width="45%"/>

</td>
</tr>
<tr>
<td width="50%" align="center">

**iPad**

<img src="assets/interactive_mode/ipad_interactive.png" width="90%"/>

</td>
</tr>
</table>

#### 需要更完整、更专业的 UI 生成体验？
如果你希望获得功能维度更丰富、交互能力更强，并面向高质量教育界面生产进行深度优化的完整版本，欢迎访问 [MAIC-UI](https://github.com/THU-MAIC/MAIC-UI)。

### 课堂生成

描述你想学习的内容，或附上参考材料。OpenMAIC 的两阶段流水线自动完成剩余工作：

| 阶段 | 说明 |
|------|------|
| **大纲生成** | AI 分析你的输入，生成结构化的课堂大纲 |
| **场景生成** | 每个大纲条目生成为丰富的场景——幻灯片、测验、交互模块或 PBL 活动 |

<!-- PLACEHOLDER: 生成流水线 GIF -->
<!-- <img src="assets/generation-pipeline.gif" width="100%"/> -->

### 课堂组件

<table>
<tr>
<td width="50%" valign="top">

**🎓 幻灯片（Slides）**

AI 老师配合聚光灯和激光笔动作进行语音讲解——如同真实课堂。

<img src="assets/slides.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🧪 测验（Quiz）**

交互式测验（单选 / 多选 / 简答），支持 AI 实时判分和反馈。

<img src="assets/quiz.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🔬 交互式模拟（Interactive）**

基于 HTML 的交互实验，用于可视化、动手学习——物理模拟器、流程图等。

<img src="assets/interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🏗️ 项目制学习（PBL）**

选择一个角色，与 AI 智能体协作完成结构化项目，包含里程碑和交付物。

<img src="assets/pbl.gif" width="100%"/>

</td>
</tr>
</table>

### 多智能体互动

<table>
<tr>
<td valign="top">

- **课堂讨论** — 智能体主动发起讨论话题，你可以随时加入或被点名互动
- **圆桌辩论** — 多个不同人设的智能体围绕话题展开讨论，配合白板讲解
- **自由问答** — 随时提问，AI 老师通过幻灯片、图表或白板进行解答
- **白板** — AI 智能体在共享白板上实时绘图——逐步推导方程、绘制流程图、直观讲解概念

</td>
<td width="360" valign="top">

<img src="assets/discussion.gif" width="340"/>

</td>
</tr>
</table>

### <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/openclaw.png" height="22" align="top"/> Agent 工作台集成

<table>
<tr>
<td valign="top">

OpenMAIC 的技能包（`skills/openmaic/`）采用标准 SKILL.md 格式，可被各类 Agent 工作台加载——除了 OpenClaw，也包括 **Codex**、**DeepSeek**、**WorkBuddy** 等。它是一份引导式 SOP：覆盖在线体验、本地部署、课堂生成和基于 `@openmaic/*` SDK 的二次开发。

其中 [OpenClaw](https://github.com/openclaw/openclaw) 是一个连接你日常使用的消息平台（飞书、Slack、Discord、Telegram、WhatsApp 等）的个人 AI 助手。通过这个集成，你可以**直接在聊天应用中生成和查看互动课堂**，无需碰命令行。

</td>
<td width="360" valign="top">

<img src="assets/openclaw-feishu-demo.gif" width="340"/>

</td>
</tr>
</table>

只需告诉你的 Agent 助手你想学什么——剩下的它来搞定：

- **托管模式** — 在 [open.maic.chat](https://open.maic.chat/) 获取访问码，保存到配置文件，即可直接生成课堂——无需本地部署
- **本地部署模式** — clone、安装依赖、配置 API Key、启动服务——Skill 逐步引导你完成
- **跟踪进度** — 自动轮询异步生成任务，完成后把链接发给你
- **二次开发** — 引导你在 OpenMAIC 基础上做二开：基于 `@openmaic/*` SDK 构建自己的应用（详见 skill 内的 extend 系列文档）

每一步都会先征求你的确认，不会黑盒执行。

<table><tr><td>

**已上架 ClawHub** — 一行命令安装：

```bash
clawhub install openmaic
```

或在 Codex、DeepSeek、WorkBuddy 等其他 Agent 工作台中，把仓库中的 `skills/openmaic/` 文件夹（或打包后的 zip）导入对应智能体工作台即可使用：

</td></tr></table>

<details>
<summary>配置与详情</summary>

| 阶段 | skill 会做什么 |
|------|------|
| **Clone** | 检测现有仓库，或在执行 clone / 安装依赖前征求确认 |
| **启动** | 在 `pnpm dev`、`pnpm build && pnpm start`、Docker 之间选择 |
| **Provider Key** | 推荐配置路径，引导你自己编辑 `.env.local` |
| **生成** | 提交异步生成任务，轮询进度直到完成 |

可选配置 `~/.openclaw/openclaw.json`：

```jsonc
{
  "skills": {
    "entries": {
      "openmaic": {
        "config": {
          // 托管模式：粘贴从 open.maic.chat 获取的访问码
          "accessCode": "sk-xxx",
          // 本地部署模式：本地仓库路径和地址
          "repoDir": "/path/to/OpenMAIC",
          "url": "http://localhost:3000"
        }
      }
    }
  }
}
```

</details>

### 导出

| 格式 | 说明 |
|------|------|
| **PowerPoint (.pptx)** | 可编辑的幻灯片，包含图片、图表和 LaTeX 公式 |
| **交互式 HTML** | 自包含的网页，包含交互式模拟实验 |
| **课堂 ZIP** | 完整课堂导出（课程结构 + 媒体文件），可备份或分享 |

导入课堂 ZIP 会先将包内音频、图片、视频及封面保存到服务器资源池，再保存课程，因此其他浏览器无需导入端的本地缓存即可读取这些资源。ZIP 也可用于在部署之间迁移课程：从一处导出，在另一处导入。

**离线 / 内网课堂：** 导出课堂（`.maic.zip`）或资源包时，OpenMAIC 会把互动场景引用的外部资源（KaTeX、Three.js 含 `three/addons`、Tailwind CDN、Google Fonts、图片）以 `data:` URI 形式内联进导出的 HTML。导出的课程在导入到内网/离线实例后即可完全离线播放，播放时不再访问任何公网 CDN。导出时无法抓取的资源（如开启了 CORS 限制的图床）会被记录并保留为原始 URL。本功能上线*之前*导出的课堂仍引用 CDN，需要重新导出才能离线播放。

### 更多功能

- **语音合成（TTS）** — 多种语音服务商，支持自定义音色
- **语音识别** — 通过麦克风与 AI 老师对话
- **网络搜索** — 智能体在课堂中搜索网络获取最新信息
- **国际化** — 界面支持 11 种语言、12 个区域设置：简体中文、繁体中文、英文、日文、韩文、俄文、阿拉伯文、葡萄牙文（巴西）、西班牙文（墨西哥）、法文、越南文、德文
- **暗色模式** — 深夜学习更护眼

---

## 💡 使用场景

<table>
<tr>
<td width="50%" valign="top">

> *"零基础文科生，30 分钟学会 Python"*

<img src="assets/python.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"如何上手阿瓦隆桌游"*

<img src="assets/avalon.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

> *"分析一下智谱和 MiniMax 的股价"*

<img src="assets/zhipu-minimax.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"DeepSeek 最新论文解析"*

<img src="assets/deepseek.gif" width="100%"/>

</td>
</tr>
</table>

---

## 🤝 参与贡献

我们欢迎社区的贡献！无论是 Bug 报告、功能建议还是 Pull Request，都非常感谢。

### 项目结构

```
OpenMAIC/
├── app/                        # Next.js App Router
│   ├── api/                    #   服务端 API 路由（26 个端点组）
│   │   ├── generate/           #     图片、视频、TTS 与音色注册
│   │   ├── generate-classroom/ #     异步课堂生成提交与轮询
│   │   ├── chat/               #     多智能体讨论（SSE 流式传输）
│   │   ├── pbl/                #     项目制学习端点
│   │   ├── persistence/        #     内嵌持久化服务（Runtime/Document Store HTTP 契约）
│   │   ├── export-video/       #     MP4 视频导出（对接 render-service）
│   │   └── ...                 #     generation-runs, materials, quiz-grade, parse-pdf, transcription 等
│   ├── classroom/[id]/         #   课堂回放页面
│   └── page.tsx                #   首页（生成输入）
│
├── lib/                        # 核心业务逻辑
│   ├── generation/             #   两阶段课堂生成流水线
│   ├── orchestration/          #   LangGraph 多智能体编排（导演图）
│   ├── playback/               #   回放状态机（idle → playing → live）
│   ├── action/                 #   动作执行引擎（语音、白板、特效）
│   ├── ai/                     #   LLM 服务商抽象层
│   ├── api/                    #   Stage API 门面（幻灯片/画布/场景操作）
│   ├── store/                  #   Zustand 状态管理
│   ├── types/                  #   集中式 TypeScript 类型定义
│   ├── audio/                  #   TTS & ASR 服务商
│   ├── media/                  #   图片 & 视频生成服务商
│   ├── export/                 #   PPTX & HTML 导出
│   ├── hooks/                  #   React 自定义 Hooks（55+）
│   ├── i18n/                   #   国际化（zh-CN, zh-TW, en-US, ja-JP, ko-KR, ru-RU, ar-SA, pt-BR, es-MX, fr-FR, vi-VN, de-DE）
│   └── ...                     #   prosemirror, storage, pdf, web-search, utils
│
├── components/                 # React UI 组件
│   ├── slide-renderer/         #   基于 Canvas 的幻灯片编辑器和渲染器
│   │   ├── Editor/Canvas/      #     交互式编辑画布
│   │   └── components/element/ #     元素渲染器（文本、图片、形状、表格、图表…）
│   ├── scene-renderers/        #   测验、交互、PBL 场景渲染器
│   ├── generation/             #   课堂生成工具栏和进度
│   ├── chat/                   #   聊天区域和会话管理
│   ├── settings/               #   设置面板（服务商、TTS、ASR、媒体…）
│   ├── whiteboard/             #   基于 SVG 的白板绘图
│   ├── agent/                  #   智能体头像、配置、信息栏
│   ├── ui/                     #   基础 UI 组件（shadcn/ui + Radix）
│   └── ...                     #   audio, roundtable, stage, ai-elements
│
├── packages/                   # 工作区子包
│   ├── @openmaic/              #   OpenMAIC SDK 系列（已发布至 npm）
│   │   ├── dsl/                #     课程 DSL 定义与资产清单
│   │   ├── generation/         #     两阶段课堂生成流水线
│   │   ├── renderer/           #     课程渲染
│   │   ├── importer/           #     课堂导入
│   │   ├── editor/             #     幻灯片编辑
│   │   └── storage/            #     Runtime/Document/资产存储层（Postgres、S3 等）
│   ├── pptxgenjs/              #   定制化 PowerPoint 生成
│   └── mathml2omml/            #   MathML → Office Math 转换
│
├── render-service/             # MP4 视频导出渲染服务（Chromium + FFmpeg，独立容器）
│
├── skills/                     # OpenClaw / ClawHub skills
│   └── openmaic/               #   OpenMAIC 引导式 SOP skill
│       ├── SKILL.md            #   轻量路由层 + 确认规则
│       └── references/         #   按需加载的 SOP 分段（生成、部署、二开等）
│
├── configs/                    # 共享常量（形状、字体、快捷键、主题…）
└── public/                     # 静态资源（logo、头像）
```

### 核心架构

- **生成流水线** (`@openmaic/generation`) — 两阶段：大纲生成 → 场景内容生成
- **多智能体编排** (`lib/orchestration/`) — 基于 LangGraph 的状态机，管理智能体轮次和讨论
- **回放引擎** (`lib/playback/`) — 驱动课堂回放和实时互动的状态机
- **动作引擎** (`lib/action/`) — 执行 21 种动作类型（语音、白板绘图/文字/形状/图表、聚光灯、激光笔…）
- **存储层** (`@openmaic/storage`) — Runtime/Document/资产存储抽象，附 Postgres 参考实现，HTTP 契约可对接任意外部存储服务

### 贡献流程

1. Fork 本仓库
2. 创建你的功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交你的更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 💼 商业合作

本项目基于 MIT 协议开源，可免费商用。商业合作或共建请联系：**thu_maic@mail.tsinghua.edu.cn**

---

## 📝 引用

如果 OpenMAIC 对您的研究有帮助，请考虑引用：

```bibtex
@Article{JCST-2509-16000,
  title = {From MOOC to MAIC: Reimagine Online Teaching and Learning through LLM-driven Agents},
  journal = {Journal of Computer Science and Technology},
  volume = {},
  number = {},
  pages = {},
  year = {2026},
  issn = {1000-9000(Print) /1860-4749(Online)},
  doi = {10.1007/s11390-025-6000-0},
  url = {https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0},
  author = {Ji-Fan Yu and Daniel Zhang-Li and Zhe-Yuan Zhang and Yu-Cheng Wang and Hao-Xuan Li and Joy Jia Yin Lim and Zhan-Xin Hao and Shang-Qing Tu and Lu Zhang and Xu-Sheng Dai and Jian-Xiao Jiang and Shen Yang and Fei Qin and Ze-Kun Li and Xin Cong and Bin Xu and Lei Hou and Man-Li Li and Juan-Zi Li and Hui-Qin Liu and Yu Zhang and Zhi-Yuan Liu and Mao-Song Sun}
}
```

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=THU-MAIC/OpenMAIC&type=Date)](https://star-history.com/#THU-MAIC/OpenMAIC&Date)

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

### 第三方组件

仓库内置的以下工作区子包**不**受根目录 MIT 许可证覆盖，各自保留原有协议：

- `packages/mathml2omml` —— [LGPL-3.0-or-later](packages/mathml2omml/LICENSE)
- `packages/pptxgenjs` —— [MIT](packages/pptxgenjs/package.json)（第三方）

整体再分发本仓库时，上述子包内文件适用其各自的协议。
