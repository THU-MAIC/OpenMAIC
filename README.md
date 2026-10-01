<!-- <p align="center">
  <img src="assets/logo-horizontal.png" alt="OpenMAIC" width="420"/>
</p> -->

<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC Banner" width="680"/>
</p>

<p align="center">
  Get an immersive, multi-agent learning experience in just one click
</p>

<p align="center">
  <a href="https://lcn6dqn3m0yr.feishu.cn/wiki/CkQSwHFdzibQFvkGzwPcmUOfnXg"><img src="https://img.shields.io/badge/%F0%9F%93%98%20User%20Guide-v1.0.0%20%C2%B7%20English-4F8EF7?style=for-the-badge" alt="v1.0.0 User Guide (English)"/></a>
  &nbsp;&nbsp;
  <a href="https://my.feishu.cn/wiki/UIfKw9Knti0LcKkTxDNcqlUrnzh"><img src="https://img.shields.io/badge/%F0%9F%93%99%20%E4%BD%93%E9%AA%8C%E6%8C%87%E5%8D%97-v1.0.0%20%C2%B7%20%E4%B8%AD%E6%96%87-FF6B35?style=for-the-badge" alt="v1.0.0 体验指南（中文）"/></a>
</p>

<p align="center">
  <a href="https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0"><img src="https://img.shields.io/badge/Paper-JCST'26-blue?style=flat-square" alt="Paper"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License: MIT"/></a>
  <a href="https://open.maic.chat/"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=flat-square" alt="Live Demo"/></a>
  <a href="#-agent-workbench-integration"><img src="https://img.shields.io/badge/OpenClaw-Integration-F4511E?style=flat-square" alt="OpenClaw Integration"/></a>
  <a href="#lemonade-local-ai"><img src="https://img.shields.io/badge/Lemonade-Local_AI-FFD43B?style=flat-square" alt="Lemonade Local AI"/></a>
  <a href="https://github.com/THU-MAIC/OpenMAIC/stargazers"><img src="https://img.shields.io/github/stars/THU-MAIC/OpenMAIC?style=flat-square" alt="Stars"/></a>
  <br/>
  <a href="https://discord.gg/p8Pf2r3SaG"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"/></a>
  &nbsp;
  <a href="community/feishu.md"><img src="https://img.shields.io/badge/Feishu-Community-00D6B9?style=for-the-badge&logo=bytedance&logoColor=white" alt="Feishu Community"/></a>
  <br/>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/LangGraph-1.1-purple?style=flat-square" alt="LangGraph"/>
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"/>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README-zh.md">Simplified Chinese</a>
  <br/>
  <a href="https://open.maic.chat/">Live Demo</a> · <a href="#-quick-start">Quick Start</a> · <a href="#lemonade-local-ai">Lemonade</a> · <a href="#funasr-local-asr">FunASR</a> · <a href="#-features">Features</a> · <a href="#-use-cases">Use Cases</a> · <a href="#-agent-workbench-integration">OpenClaw</a>
</p>

## 🗞️ News

- **2026-10-04** — [v1.2.0-rc.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.2.0-rc.1) (pre-release): **server-first.** Until 1.1.x, the browser drove course generation step by step and kept courses, keys and model settings itself, so closing the tab stopped a course halfway, every browser had to be configured on its own, and the headless API ran a separate pipeline. In 1.2.0 the server owns all of it: generation runs on the server and survives closed tabs and restarts, models are configured once in `openmaic.yml` (with defaults, locks and an option to forbid user keys), materials are parsed as soon as they are attached, and the web app and the API share one pipeline. It needs PostgreSQL and a long-running server; Vercel deployments stay on [1.1.x](#vercel-deployment-up-to-11x). Read the [changelog](CHANGELOG.md) before upgrading.
- **2026-09-28** — [v1.1.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.2): security — provider requests connect only to validated addresses and refuse redirects ([GHSA-g87c-cm4q-cw5x](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-g87c-cm4q-cw5x)).
- **2026-09-27** — [v1.1.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.1): security — hardened MinerU Cloud parsing ([GHSA-cpjc-vgjh-c5jp](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-cpjc-vgjh-c5jp)).
- **2026-09-24** — [v1.1.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.1.0): agentic classroom chat (ask about any slide element, interactive, or whiteboard drawing); settings rebuilt around the course workflow; Token Plan connections.
- **2026-09-15** — [v1.0.3](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.3): security — access-code tokens expire, render-service network policy, pinned audio connections, Next.js RCE patch.
- **2026-09-14** — [v1.0.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.2): security — SSRF and DNS-rebinding fixes, classroom overwrite fix.
- **2026-09-06** — [v1.0.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1): security and stability; tightens two defaults.
- **2026-08-27** — **v1.0.0**: agent workbench, durable sessions, reusable skills, session materials, provider-neutral capabilities.

<details>
<summary>Earlier releases</summary>

- **2026-08-14** — [v0.3.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.2): video export hardening, server-backed persistence and asset registry, `@openmaic/generation`, four new locales, FunASR.
- **2026-07-21** — [v0.3.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.1): one-click MP4 export, direct slide editing, smarter "Edit with AI", expanded document parsing.
- **2026-06-28** — [v0.3.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.0): PBL v2, "Edit with AI" editor agent, `@openmaic/*` SDKs on npm, relicensed to MIT.
- **2026-06-02** — [v0.2.2](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.2.2): MAIC Editor Pro Mode, editable outlines, offline classroom export.
- **2026-04-26** — [v0.2.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.2.1): VoxCPM2 TTS with voice cloning, per-model thinking config, course completion page.
- **2026-04-20** — **v0.2.0**: Deep Interactive Mode — 3D, simulations, games, mind maps, online programming.
- **2026-04-14** — [v0.1.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.1.1): language inference, ACCESS_CODE, classroom ZIP export/import, Ollama.
- **2026-03-26** — [v0.1.0](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.1.0): discussion TTS, immersive mode, keyboard shortcuts.

</details>

Full history in the [changelog](CHANGELOG.md).

## 📖 Overview

**OpenMAIC** (Open Multi-Agent Interactive Classroom) is an open-source AI platform that turns any topic or document into a rich, interactive classroom experience. Powered by multi-agent orchestration, it generates slides, quizzes, interactive simulations, and project-based learning activities — all delivered by AI teachers and AI classmates who can speak, draw on a whiteboard, and engage in real-time discussions with you. The built-in OpenMAIC Skill works with [OpenClaw](https://github.com/openclaw/openclaw) as well as agent workbenches such as Codex, DeepSeek, and WorkBuddy, so you can generate classrooms from messaging apps like Feishu, Slack, or Telegram, or right inside your IDE.

https://github.com/user-attachments/assets/8f3f1e5f-1468-4e93-8054-afeeea683a61

### Highlights

- **One-click lesson generation** — Describe a topic or attach your materials; the AI builds a full lesson in minutes
- **Multi-agent classroom** — AI teachers and peers lecture, discuss, and interact with you in real time
- **Rich scene types** — Slides, quizzes, interactive HTML simulations, and project-based learning (PBL)
- **Whiteboard & TTS** — Agents draw diagrams, write formulas, and explain out loud
- **Export anywhere** — Download editable `.pptx` slides or interactive `.html` pages
- **[Agent workbench integration](#-agent-workbench-integration)** — The OpenMAIC Skill supports OpenClaw, Codex, DeepSeek, WorkBuddy, and more — generate classrooms from Feishu, Slack, Telegram, 20+ messaging apps, or your IDE

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 22.19
- **pnpm** >= 10
- **PostgreSQL** 16 — courses are stored on the server. For local development
  `pnpm db:up` starts one in Docker for you.

### 1. Clone & Install

```bash
git clone https://github.com/THU-MAIC/OpenMAIC.git
cd OpenMAIC
pnpm install
```

### 2. Configure

```bash
cp .env.example .env.local            # API keys and server options
cp openmaic.example.yml openmaic.yml  # which models the server uses
```

The copied example needs only `OPENAI_API_KEY` in `.env.local` (or change its provider to one you have a key for); everything else in it is commented out until you want it. `openmaic.yml` declares **providers** (accounts the server can call) and gives each **slot** (a use of AI: the outline, slide content, text to speech, web search, …) a model. Keys stay in `.env.local` and are referenced as `${VAR}`:

```yaml
providers:
  openai:
    preset: openai
    apiKey: ${OPENAI_API_KEY}      # OPENAI_API_KEY=sk-... in .env.local
  anthropic:
    preset: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

slots:
  llm: openai:gpt-5.5              # the default chat model
  course.outline: anthropic:claude-sonnet-4-6
  video: null                      # turn a capability off
```

The slots you write are the server's defaults; users can change them, or connect services of their own, in the app's model settings unless you `lock` them or set `allowUserKeys: false`. The server validates the file at startup and names every mistake by its field (or, for broken YAML, its line).

| To learn about | Read |
| --- | --- |
| Slots, presets, fallbacks, `lock`, `allowUserKeys`, `OPENMAIC_SECRET_KEY` | [Configuration](packages/docs/content/docs/configuration.mdx) |
| Every provider preset and model ID | [Supported models](packages/docs/content/docs/supported-models.mdx) |
| Upgrading: provider variables, `server-providers.yml`, `DEFAULT_MODEL` and `MODEL_FALLBACK` still work without `openmaic.yml`; `MODEL_ROUTES` must become slots | [Migrating from the legacy configuration](packages/docs/content/docs/configuration.mdx#migrating-from-the-legacy-configuration) |

**Providers:** OpenAI, Azure OpenAI, Anthropic, Amazon Bedrock, Google Gemini, DeepSeek, Qwen, Kimi, MiniMax, Grok (xAI), OpenRouter, TokenDance, Doubao, Tencent Hunyuan/TokenHub, Xiaomi MiMo, GLM (Zhipu), iFlytek Spark, Ollama, [Lemonade](#lemonade-local-ai) and [FunASR](#funasr-local-asr) (local), and any OpenAI-compatible API.

> [!TIP]
> **Recommended setup:** OpenMAIC is at its best with every modality turned on — generated illustrations, narration, video clips, and web-grounded research. The least friction is a single key that covers all of them (see the token plan examples below), with a fast long-context model such as `deepseek-v4.1-flash` as the default.

<details>
<summary><b>More examples</b>: token plans, Xiaomi MiMo and GLM, Amazon Bedrock</summary>

Token plan quick example (one key for chat, image, video, TTS and web search; `tokendance` works the same way):

```yaml
providers:
  minimax:
    preset: minimax
    apiKey: ${MINIMAX_API_KEY}

slots:
  llm: minimax:MiniMax-M3
  image: minimax                   # a provider id alone: the plan's default model
  video: minimax
  tts: minimax
  webSearch: minimax
```

TokenDance quick example with a fast long-context default model:

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

Xiaomi MiMo Token Plan and GLM (Zhipu) quick example:

```yaml
providers:
  mimo:
    preset: xiaomi
    apiKey: ${MIMO_API_KEY}
    baseUrl: https://token-plan-cn.xiaomimimo.com/v1
  glm:
    preset: glm
    apiKey: ${GLM_API_KEY}
    baseUrl: https://open.bigmodel.cn/api/paas/v4   # or https://api.z.ai/api/paas/v4

slots:
  llm: mimo:mimo-v2.5-pro
  course.content: glm:glm-5.1
```

Use `https://token-plan-sgp.xiaomimimo.com/v1` or `https://token-plan-ams.xiaomimimo.com/v1` for the Singapore or Europe Token Plan clusters.

Amazon Bedrock quick example:

```yaml
providers:
  bedrock:
    preset: bedrock
    models: [us.anthropic.claude-sonnet-5, us.anthropic.claude-opus-4-8]

slots:
  llm: bedrock:us.anthropic.claude-sonnet-5
```

Bedrock uses AWS environment credentials or the AWS SDK credential provider chain, with the region from `BEDROCK_REGION` (for example `BEDROCK_REGION=us-east-1` in `.env.local`). For temporary credentials, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`, or use an AWS profile / role available to the runtime.

</details>

### 3. Start the database

```bash
pnpm db:up
```

Then uncomment the local `DATABASE_URL` line in `.env.local`:

```env
DATABASE_URL=postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic
```

`pnpm db:up` starts a development PostgreSQL on `127.0.0.1:5432` (set `OPENMAIC_DB_PORT` for another port). It is its own Compose project, `openmaic-dev-db`, shared by every checkout on this machine, with its own container and volume, so it never touches the database of a `docker compose up` stack. `pnpm db:down` stops it and keeps the data. Any other PostgreSQL works too.

### 4. Run

```bash
pnpm dev
```

Open **http://localhost:3000** and start learning! Without a `DATABASE_URL` the
server refuses to start and tells you how to provide one (see
[Server-backed persistence](#server-backed-persistence-postgresql)).

### 5. Build for Production

```bash
pnpm build && DATABASE_URL=postgres://... pnpm start
```

Keep the server running as a long-running process (a process manager or a
container): course generation runs inside it and continues after the browser
leaves the page. See the
[Deployment guide](packages/docs/content/docs/deployment.mdx) for the required
configuration and for upgrading from 1.1.x.

### Docker Deployment

```bash
cp .env.example .env.local
# Edit .env.local with your API keys, then:
docker compose up --build
```

Open **http://localhost:3000**. The stack is two containers, the app and PostgreSQL. Courses, generated media and runtime sessions live in the named volumes `openmaic-postgres` and `openmaic-data`, which survive `docker compose down` and rebuilds; `docker compose down -v` deletes them. To configure models with `openmaic.yml`, create it from `openmaic.example.yml` and uncomment its mount in `docker-compose.yml`; otherwise connect a model service in the model settings once the app is running.

The Compose file is a **personal installation**: it runs in [single-user mode](#server-backed-persistence-postgresql) (every browser sees one shared library) and listens on `127.0.0.1:3000` only. To serve other machines, protect it first:

1. Set a long random `ACCESS_CODE` in `.env.local` ([details](#optional-access_code-shared-deployments)). Without it, anyone who can reach the port owns, edits and can delete the whole library.
2. Before the first start, set `PERSISTENCE_POSTGRES_PASSWORD` to a random value of letters and digits.
3. Publish on the network address:

   ```bash
   OPENMAIC_PUBLISH_ADDRESS=0.0.0.0 docker compose up -d --build
   ```

`OPENMAIC_PUBLISH_ADDRESS`, `OPENMAIC_PORT` and `PERSISTENCE_POSTGRES_PASSWORD` come from your shell or a `.env` file next to `docker-compose.yml`, not from `.env.local`. Overriding the Compose defaults, rotating the database password and the full upgrade notes are in [Hosting and identity](packages/docs/content/docs/hosting.mdx#docker-compose-as-a-personal-installation).

> [!IMPORTANT]
> **Upgrading a Compose deployment?** PostgreSQL now always starts, the app is published on `127.0.0.1` only, and every visitor is the same single owner. If `.env.local` sets `PERSISTENCE_SHARED_OWNER_ID`, also set `OWNER_SINGLE_USER=false`, or the app refuses to start. Read [Upgrading a Compose deployment](packages/docs/content/docs/hosting.mdx#upgrading-a-compose-deployment) first.

<details>
<summary><b>Slow-network / China build acceleration</b></summary>

Docker builds support two optional build arguments. Both are empty by default,
so the standard command above keeps using the upstream Alpine and npm
registries.

- `ALPINE_MIRROR` is an Alpine mirror hostname without `https://`.
- `NPM_REGISTRY` is a complete npm registry URL.

Use public mirror endpoints only. Do not embed usernames, passwords, or access
tokens in these build arguments because Docker may record them in image metadata
or build provenance.

With Docker Compose:

```bash
ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up --build
```

For a direct image build:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t openmaic:local .
```

These arguments do not accelerate Docker Hub pulls, including the Dockerfile
frontend and the `node:22-alpine` base image. Configure a Docker daemon registry
mirror separately if those pulls are slow. The pnpm store cache is reused by the
same BuildKit builder across builds, subject to normal cache garbage collection;
the cache only improves performance and is not required for a correct build.

</details>

### Vercel Deployment (up to 1.1.x)

Serverless deployment is supported up to OpenMAIC 1.1.x. From 1.2.0, course
generation runs on the server in a process that outlives requests, so OpenMAIC
needs a long-running Node.js process with PostgreSQL (the
[Docker deployment](#docker-deployment) or `pnpm start`); Vercel and other
serverless hosts are not supported, and the repository no longer ships a
`vercel.json`. To deploy 1.1.x on Vercel:

1. Fork this repository on GitHub, unchecking **Copy the `main` branch only**.
2. In the fork, set the default branch to `release/1.1.x` (**Settings → General → Default branch**).
3. In Vercel, **Add New → Project** and import the fork. Vercel builds its default branch; configure at least one LLM provider key as described in that branch's [`.env.example`](https://github.com/THU-MAIC/OpenMAIC/blob/release/1.1.x/.env.example).

Such a deployment can move to a long-running host later without losing data:
point the new host's `DATABASE_URL` at the database it used, if it used one,
and serve it at the same address, since browsers keep their data per site; the
courses visitors kept in their browsers are imported the first time each
browser opens the upgraded app. See
[Upgrading from 1.1.x](packages/docs/content/docs/deployment.mdx#upgrading-from-11x)
for every kind of deployment.

### Server-backed persistence (PostgreSQL)

OpenMAIC keeps courses on the server. Course documents, folders, chat history, learner sessions and generated media live in PostgreSQL (media optionally in S3), served by the app itself at `/api/persistence`. The browser keeps only what belongs to the device, such as settings, playback position and caches; **Settings → Clear Local Cache** never touches the server.

- **`DATABASE_URL` is required.** Without it the server prints the fix and exits with code `1`. Compose sets it for you; for development, [`pnpm db:up`](#3-start-the-database) starts a database.
- **Courses an older build kept in the browser** are imported once per browser, automatically, the first time it opens the upgraded app. The browser copy is left untouched.
- **Invalid settings stop the server** at startup with a one-line `[boot]` reason instead of a server that answers every request with `500`.

**Who owns a course.** Every request resolves to an owner, and each owner has its own library. Pick one identity mode:

| Mode | Set | Library |
| --- | --- | --- |
| Single user (Compose default) | `OWNER_SINGLE_USER=true` | One library for everyone who can reach the server; guard it with `ACCESS_CODE` or loopback |
| Shared team | `PERSISTENCE_SHARED_OWNER_ID=<id>` together with `ACCESS_CODE` | One library for the team behind the access code |
| Anonymous (default without either) | nothing | One library per browser cookie; a second browser sees an empty one |
| Your own accounts | owner auth methods registered in `instrumentation.ts` | One library per signed-in account |

Set the mode before the first start of 1.2.0: classrooms that 1.1.x saved as files are imported for the owner configured then. See [Upgrading from 1.1.x](packages/docs/content/docs/deployment.mdx#upgrading-from-11x) for every kind of deployment.

Running OpenMAIC for other people, or embedding it in your own product? [Hosting and identity](packages/docs/content/docs/hosting.mdx) covers:

- [who can read and write stored data](packages/docs/content/docs/hosting.mdx#who-can-read-and-write-stored-data), and the removed `PERSISTENCE_DEV_TOKEN`;
- [asset collection, quotas and S3 egress](packages/docs/content/docs/hosting.mdx#asset-storage) (`ASSET_*`);
- [every startup check](packages/docs/content/docs/hosting.mdx#startup-checks);
- [owner identity](packages/docs/content/docs/hosting.mdx#owner-identity): [single-user mode](packages/docs/content/docs/hosting.mdx#single-user-mode), [registering auth methods](packages/docs/content/docs/hosting.mdx#registering-owner-auth-methods), a [signed-JWT gateway recipe](packages/docs/content/docs/hosting.mdx#recipe-accounts-through-an-identity-gateway-signed-jwt) and [claiming anonymous work](packages/docs/content/docs/hosting.mdx#claiming-anonymous-work);
- [host extension hooks](packages/docs/content/docs/hosting.mdx#host-extension-hooks) for course creation, the library, uploads and asset byte stores.

### Optional: ACCESS_CODE (Shared Deployments)

Protect a deployment with a site-level password in `.env.local`:

```env
ACCESS_CODE=your-secret-code
```

Use a long random value, at least 16 characters from a random generator: it is the only secret guarding the deployment. Visitors then see a password prompt, and every API route is gated too. When it is unset (the default in `.env.example`), `middleware.ts` checks no credential and every route, the API included, is reachable: an unconfigured deployment is not gated, and there is no second enforcement point. The code is remembered for 7 days in a signed HTTP-only cookie; attempts are rate limited only behind a trusted proxy with `TRUST_PROXY_HEADERS=true`. See [Configuration → ACCESS_CODE](packages/docs/content/docs/configuration.mdx#access_code--site-wide-password).

### Optional: Agent workbench and runtime

The Pro workbench, a course-building surface entered from the home page, is off by default. Turn on its build-time entry point and the server runtime; it uses the same PostgreSQL as the rest of the app:

```env
NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true
OPENMAIC_AGENT_RUNTIME_ENABLED=true
DATABASE_URL=postgres://openmaic:openmaic-dev@postgres:5432/openmaic
```

The agent runs on the `agent` slot, which follows the default chat model unless assigned and needs a model with tool calling:

```yaml
slots:
  llm: openai:gpt-5.5
  agent:
    model: openai:gpt-5.5
    api: openai-completions        # or openai-responses
```

The `agent` slot must not set `thinking.effort`. Its routes, the `DEFAULT_MODEL` caveat and runner tuning are in [Hosting and identity](packages/docs/content/docs/hosting.mdx#agent-workbench-and-runtime).

<a id="lemonade-local-ai"></a>

### Optional: Lemonade (Local AI Provider)

OpenMAIC supports Lemonade as a local, OpenAI-compatible provider for LLMs, image generation, TTS, and ASR. No API key is required.

Run Lemonade locally, then point OpenMAIC to it:

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

With the legacy variables, the same is `LEMONADE_BASE_URL`, `TTS_LEMONADE_BASE_URL`, `ASR_LEMONADE_BASE_URL` and `IMAGE_LEMONADE_BASE_URL`.

<a id="funasr-local-asr"></a>

### Optional: FunASR (Local Speech Recognition)

OpenMAIC can transcribe locally through FunASR's OpenAI-compatible server. The built-in provider supports SenseVoiceSmall, Paraformer, and Fun-ASR-Nano and requires no API key.

```bash
python -m pip install torch torchaudio
python -m pip install "funasr==1.4.0" fastapi uvicorn python-multipart
# Add vLLM for Fun-ASR-Nano on NVIDIA GPUs
python -m pip install vllm
funasr-server --device cuda --model fun-asr-nano
```

Point OpenMAIC at the server:

```yaml
providers:
  funasr:
    preset: funasr-asr
    baseUrl: http://localhost:8000/v1

slots:
  asr: funasr
```

(Legacy variable: `ASR_FUNASR_BASE_URL=http://localhost:8000/v1`.)

Use `funasr-server --device cpu --model sensevoice` for a CPU-only setup. See the [FunASR deployment guide](https://github.com/modelscope/FunASR#deploy) for production options.

### Optional: Local Audio and Video Extraction

OpenMAIC can extract timestamped transcripts and prepared video keyframes locally. Install the system `ffmpeg` package so both `ffmpeg` and `ffprobe` are executable on `PATH`, then assign the `asr` slot (for example FunASR, Lemonade, or OpenAI) as above. The application resolves the executables at extraction time; ffmpeg is not an npm dependency and is not required to start or use OpenMAIC.

If the executables are unavailable, the local extractor is skipped. A configured AliDocMind provider remains available as the cloud extraction path. When neither local ffmpeg extraction nor AliDocMind is available, audio/video materials are marked failed with an actionable setup message instead of hanging or completing with an empty transcript.

### Optional: MP4 Video Export (Render Service)

The "Export Video" menu builds a self-contained [Hyperframes](https://www.npmjs.com/package/@hyperframes/producer) project entirely in the browser. Turning that into an MP4 needs Chromium + FFmpeg on Node 22, so it runs in an isolated `render-service` container rather than the app.

It's opt-in. Start it with the `video-export` compose profile:

```bash
docker compose --profile video-export up --build
```

The app auto-detects the service via `RENDER_SERVICE_URL` (preset in `docker-compose.yml`) and enables one-click MP4 rendering. Without the profile — or when `RENDER_SERVICE_URL` is unset — export degrades to downloading the project ZIP for local CLI rendering. See [`render-service/README.md`](render-service/README.md) for standalone setup and tuning (`RENDER_MAX_CONCURRENCY`, etc.).

### Optional: MinerU (Advanced Document Parsing)

[MinerU](https://github.com/opendatalab/MinerU) provides enhanced parsing for complex tables, formulas, and OCR. You can use the [MinerU official API](https://mineru.net/) or [self-host your own instance](https://opendatalab.github.io/MinerU/quick_start/docker_deployment/).

Declare it in `openmaic.yml` and assign the `document` slot to it: `mineru-cloud` for the official API, or `mineru` with the `baseUrl` of your own instance.

```yaml
providers:
  mineru:
    preset: mineru-cloud
    apiKey: ${PDF_MINERU_CLOUD_API_KEY}

slots:
  document: mineru
```

Without `openmaic.yml`, the legacy variables `PDF_MINERU_CLOUD_API_KEY` or `PDF_MINERU_BASE_URL` in `.env.local` still work.

### Optional: VoxCPM2 (Self-Hosted TTS with Voice Cloning)

[VoxCPM2](https://github.com/OpenBMB/VoxCPM) is an open-source TTS model from OpenBMB with voice cloning. OpenMAIC ships an adapter; run VoxCPM on your own hardware and OpenMAIC will talk to it.

**1. Run a VoxCPM backend.** Three deployment styles, all behind the same OpenMAIC adapter. You pick which one with `options.backend` in `openmaic.yml` (step 2).

| Backend | Endpoint | When to use |
| --- | --- | --- |
| **vLLM-Omni** | `/v1/audio/speech` | OpenAI-compatible speech endpoint, ideal for GPU servers |
| **Python API** | `/tts/upload` | Official VoxCPM Python runtime via FastAPI |
| **Nano-vLLM** | `/generate` | Lightweight Nano-vLLM FastAPI deployment |

See the [VoxCPM repo](https://github.com/OpenBMB/VoxCPM) for backend setup.

**2. Point OpenMAIC at it.** VoxCPM2 runs on your own network, so the deployment configures it in `openmaic.yml` (no API key required); workspaces cannot add it in **Settings → Model Services**:

```yaml
providers:
  voxcpm:
    preset: voxcpm-tts
    baseUrl: http://localhost:8000/v1
    options:
      backend: vllm-omni          # vllm-omni (default) | python-api | nano-vllm

slots:
  tts: voxcpm
```

Voice registration works only on the `vllm-omni` backend; `python-api` and `nano-vllm` send the voice prompt with each request.

Without `openmaic.yml`, the legacy `TTS_VOXCPM_BASE_URL=http://localhost:8000/v1` sets the endpoint but cannot choose a backend.

**3. Manage voices.** With VoxCPM2 assigned to the `tts` slot, open **Settings → Model Services → Text-to-Speech → VoxCPM2** (the voice manager appears only when `tts` resolves to a `voxcpm-tts` provider). Three voice modes:

<img src="assets/voxcpm/voxcpm-voice-manager.png" width="85%" alt="VoxCPM2 VoxCPM Voices section with Auto, Prompt and Clone modes" />

- **Auto Voice** (default): OpenMAIC generates a voice prompt from each agent's persona at synthesis time. No setup required.
- **Prompt voice**: describe the voice in natural language, e.g. *"warm female teacher voice, calm and encouraging, mid-pitch"*.
- **Clone voice**: upload a short reference audio clip or record one in the browser. The clip is stored in this browser (IndexedDB) and sent to your VoxCPM backend on each synthesis.

---

## ✨ Features

### Agent Workbench and Pro Mode (v1.0.0)

The workbench adds a conversational course-building agent to OpenMAIC.
Its durable sessions can be resumed after a worker restart, accept follow-up
instructions while running, and stream a replayable event history to the chat
surface.

Open it from the Pro control on the home page. The workspace combines a
transient, collapsible folders/conversations rail with a chat pane and a
classroom pane whose open courses stay in tabs. Workspace controls return to
classic mode, and either entry remains gated by the public workbench flag plus
the configured server runtime.

The agent works through explicit, validated tools rather than editing opaque
blobs:

| Area | Capabilities |
| --- | --- |
| **Plan and organize** | Plan multi-lesson curricula; create courses and folders; rename and move courses |
| **Build and edit** | Read/search the stage DSL; atomically patch one scene; generate, duplicate, insert, delete, and reorder pages; edit narration and deck structure |
| **Use materials** | Upload files; extract documents, audio, and video; search extracted text; fetch trusted web URLs; reuse material media |
| **Create media** | Generate images and videos through configured server providers; generate narration audio |
| **Import and inspect** | Import `.pptx` slides with their layout preserved; render scene previews for visual inspection when available |
| **Configure the classroom** | List available voices, set the agent roster, and clone/register a voice when a pluggable registration adapter is configured |

Twenty-four built-in skills cover curriculum planning, deep research, interactive,
lecture, workshop, vocational, and other teaching styles, slide/stage craft,
PPTX import, editing, and style reuse. User-authored skills are stored per owner
and can be created, read, and patched through the same runtime.

The server-backed workbench also exposes owner-scoped folder routes and a
per-viewer stage metadata sidecar for ownership, publication, and
generation-complete state. A stage ID acts as the capability for reading a
non-deleted course, but stage mutations remain restricted to its owner. The
material upload contract stores supported source bytes before lease-fenced
document or media extraction records derived text and images; media extraction
can select AliDocMind or the optional local ffmpeg/ffprobe provider.

Under the hood, agent sessions are database-backed with leases, heartbeats,
crash resume, cancellation, and follow-up steering, and database-maintained
revision counters keep per-stage and per-scene freshness monotonic so the
workbench refetches only the scenes that changed. Server routes resolve LLM,
media, ASR/TTS, and search configuration provider-neutrally: credentials never
reach the browser, uniform `<CAP>_<PREFIX>_ENABLED=false` switches can force
off any served capability, startup validation warns about bad model
configuration, and unresolved model routes fail loudly instead of guessing a
vendor.

### Pluggable Storage

OpenMAIC stores course documents, learner runtime records and assets on the
server, in PostgreSQL. The `@openmaic/storage` package defines swappable stores
for those primitives — PostgreSQL-backed documents, learner runtime, assets,
durable agent sessions, session materials, and user skills, plus browser
implementations for embedders — and HTTP clients connect the browser to the
embedded persistence endpoint, while the server asset layer can keep bytes in
PostgreSQL or S3. Device-scoped KV values (settings, playback position) stay in
the browser.

### Deep Interactive Mode (New!)

**Passive listening? ❌  Hands-on exploration! ✅**

As Einstein said: *"Play is the highest form of research."*

While **Standard Mode** focuses on quickly generating classroom content, **Deep Interactive Mode** goes further — creating interactive, explorable, hands-on learning experiences. Students don't just watch knowledge; they adjust experiments, observe simulations, and actively explore how things work.

#### Five Types of Interactive UI

<table>
<tr>
<td width="50%" valign="top">

**🌐 3D Visualization**

Three-dimensional visual representations that make abstract structures more intuitive.

<img src="assets/interactive_mode/3D_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**⚙️ Simulation**

Process simulations and experimental environments for observing dynamic changes and outcomes.

<img src="assets/interactive_mode/simulation_interactive.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🎮 Game**

Knowledge-based mini-games that reinforce understanding and memory through interactive challenges.

<img src="assets/interactive_mode/game_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🧭 Mind Map**

Structured knowledge organization to help learners build an overall conceptual framework.

<img src="assets/interactive_mode/mindmap_interactive.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**💻 Online Programming**

In-browser coding and instant execution for learning by writing, testing, and iterating.

<img src="assets/interactive_mode/code_interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

</td>
</tr>
</table>

#### AI Teacher Guidance

The AI teacher can actively operate the UI to guide students — highlighting key areas, setting conditions, providing hints, and directing attention at the right moments.

<img src="assets/interactive_mode/teacher_action_interative.gif" width="100%"/>

#### Available on Any Device

All generated interactive UI is fully responsive — desktop, tablet, or mobile.

<table>
<tr>
<td width="50%" align="center">

**Desktop**

<img src="assets/interactive_mode/desktop_interactive.png" width="90%"/>

</td>
<td width="50%" align="center" rowspan="2">

**Mobile**

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

#### Need a More Complete and Professional UI Generation Experience?
If you are looking for a version with richer functionality, stronger interactivity, and deeper optimization for high-quality educational UI production, please visit [MAIC-UI](https://github.com/THU-MAIC/MAIC-UI).

### Lesson Generation

Describe what you want to learn or attach reference materials. PDF, Word,
PowerPoint, spreadsheet, text, image, audio, and video inputs can enter the
material pipeline; configured extractors turn supported sources into content
for generation. OpenMAIC's classic two-stage pipeline handles the rest:

| Stage | What Happens |
|-------|-------------|
| **Outline** | AI analyzes your input and generates a structured lesson outline |
| **Scenes** | Each outline item becomes a rich scene — slides, quizzes, interactive modules, or PBL activities |

<!-- PLACEHOLDER: generation pipeline GIF -->
<!-- <img src="assets/generation-pipeline.gif" width="100%"/> -->



### Classroom Components

<table>
<tr>
<td width="50%" valign="top">

**🎓 Slides**

AI teachers deliver lectures with voice narration, spotlight effects, and laser pointer animations — just like a real classroom.

<img src="assets/slides.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🧪 Quiz**

Interactive quizzes (single / multiple choice, short answer) with real-time AI grading and feedback.

<img src="assets/quiz.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🔬 Interactive Simulation**

HTML-based interactive experiments for visual, hands-on learning — physics simulators, flowcharts, and more.

<img src="assets/interactive.gif" width="100%"/>

</td>
<td width="50%" valign="top">

**🏗️ Project-Based Learning (PBL)**

Choose a role and collaborate with AI agents on structured projects with milestones and deliverables.

<img src="assets/pbl.gif" width="100%"/>

</td>
</tr>
</table>

### Multi-Agent Interaction

<table>
<tr>
<td valign="top">

- **Classroom Discussion** — Agents proactively initiate discussions; you can jump in anytime or get called on
- **Roundtable Debate** — Multiple agents with different personas discuss a topic, with whiteboard illustrations
- **Q&A Mode** — Ask questions freely; the AI teacher responds with slides, diagrams, or whiteboard drawings
- **Whiteboard** — AI agents draw on a shared whiteboard in real time — solving equations step by step, sketching flowcharts, or illustrating concepts visually.

</td>
<td width="360" valign="top">

<img src="assets/discussion.gif" width="340"/>

</td>
</tr>
</table>

### <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/openclaw.png" height="22" align="top"/> Agent Workbench Integration

<table>
<tr>
<td valign="top">

The OpenMAIC skill package (`skills/openmaic/`) uses the standard SKILL.md format and can be loaded by various agent workbenches — besides OpenClaw, this includes **Codex**, **DeepSeek**, **WorkBuddy**, and others. It is a guided SOP covering the live demo, local setup, classroom generation, and secondary development on top of the `@openmaic/*` SDK.

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant that connects to the messaging platforms you already use (Feishu, Slack, Discord, Telegram, WhatsApp, etc.). With this integration, you can **generate and view interactive classrooms directly from your chat app** without ever touching a terminal.

</td>
<td width="360" valign="top">

<img src="assets/openclaw-feishu-demo.gif" width="340"/>

</td>
</tr>
</table>

Just tell your agent assistant what you want to learn — it handles everything else:

- **Hosted mode** — Grab an access code from [open.maic.chat](https://open.maic.chat/), save it in your config, and generate classrooms instantly — no local setup required
- **Self-hosted mode** — Clone, install dependencies, configure API keys, and start the server — the skill guides you through each step
- **Track progress** — Poll the async generation job and send you the link when ready
- **Secondary development** — Guide you through building on top of OpenMAIC: create your own app with the `@openmaic/*` SDK (see the extend docs inside the skill)

Every step asks for your confirmation first. No black-box automation.

<table><tr><td>

**Available on ClawHub** — Install with one command:

```bash
clawhub install openmaic
```

Or, in other agent workbenches such as Codex, DeepSeek, or WorkBuddy, import the `skills/openmaic/` folder from the repo (or its zipped archive) into the workbench to use it:

</td></tr></table>

<details>
<summary>Configuration & details</summary>

| Phase | What the skill does |
|------|-------------|
| **Clone** | Detect an existing checkout or ask before cloning/installing |
| **Startup** | Choose between `pnpm dev`, `pnpm build && pnpm start`, or Docker |
| **Provider Keys** | Recommend a provider path; you edit `.env.local` yourself |
| **Generation** | Submit an async generation job and poll until it completes |

Optional config in `~/.openclaw/openclaw.json`:

```jsonc
{
  "skills": {
    "entries": {
      "openmaic": {
        "config": {
          // Hosted mode: paste your access code from open.maic.chat
          "accessCode": "sk-xxx",
          // Self-hosted mode: local repo path and URL
          "repoDir": "/path/to/OpenMAIC",
          "url": "http://localhost:3000"
        }
      }
    }
  }
}
```

</details>

### Export

| Format | Description |
|--------|-------------|
| **PowerPoint (.pptx)** | Fully editable slides with images, charts, and LaTeX formulas |
| **Interactive HTML** | Self-contained web pages with interactive simulations |
| **Classroom ZIP** | Full classroom export (course structure + media) for backup or sharing |

Importing a classroom ZIP stores its embedded audio, images, video, and posters in the server asset pool before saving the course, so other browsers resolve those assets without the importing browser's cache. A ZIP is also a way to move a course between deployments: export it from one and import it on the other.

**Offline / intranet classrooms:** When you export a classroom (`.maic.zip`) or a Resource Pack, OpenMAIC inlines the external assets referenced by interactive scenes (KaTeX, Three.js incl. `three/addons`, Tailwind CDN, Google Fonts, images) into the exported HTML as `data:` URIs. The exported course then plays fully offline after import into an air-gapped/intranet instance — no public CDN is contacted at playback time. Assets that can't be fetched at export time (e.g. CORS-restricted image hosts) are reported and left as URLs. Classrooms exported *before* this feature still reference CDNs and must be re-exported to gain offline support.

### And More

- **Text-to-Speech** — Multiple voice providers with customizable voices
- **Speech Recognition** — Talk to your AI teacher using your microphone
- **Web Search** — Agents search the web for up-to-date information during class
- **Provider controls** — Server-side capability discovery, model resolution, force-off switches, and fail-loud routing keep deployments explicit
- **Course freshness** — Database-triggered per-scene revision counters, freshness events, and targeted scene fetches keep workbench views synchronized
- **i18n** — Interface supports 12 locales across 11 languages: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, Russian, Arabic, Portuguese (Brazil), Spanish (Mexico), French, Vietnamese, and German
- **Dark Mode** — Easy on the eyes for late-night study sessions

---

## 💡 Use Cases

<table>
<tr>
<td width="50%" valign="top">

> *"Teach me Python from scratch in 30 min"*

<img src="assets/python.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"How to play the board game Avalon"*

<img src="assets/avalon.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

> *"Analyze the stock prices of Zhipu and MiniMax"*

<img src="assets/zhipu-minimax.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"Break down the latest DeepSeek paper"*

<img src="assets/deepseek.gif" width="100%"/>

</td>
</tr>
</table>

---

## 🤝 Contributing

We welcome contributions from the community! Whether it's bug reports, feature ideas, or pull requests — every bit helps.

### Project Structure

```
OpenMAIC/
├── app/                        # Next.js App Router
│   ├── api/                    #   Generation, media, persistence, and agent APIs
│   │   ├── agent/              #     Durable session, event, material, and skill control plane
│   │   ├── stages/             #     Owner-scoped course reads, writes, manifests, and scene fetches
│   │   ├── generate/           #     Images, video, TTS and voice registration
│   │   ├── generate-classroom/ #     Async classroom job submission + polling
│   │   ├── chat/               #     Multi-agent discussion (SSE streaming)
│   │   ├── pbl/                #     Project-Based Learning endpoints
│   │   ├── persistence/        #     Embedded persistence service (Runtime/Document Store HTTP contracts)
│   │   ├── export-video/       #     MP4 video export (backs onto render-service)
│   │   └── ...                 #     generation-runs, materials, quiz-grade, parse-pdf, transcription, etc.
│   ├── classroom/[id]/         #   Classroom playback page
│   └── page.tsx                #   Home page (generation input)
│
├── lib/                        # Core business logic
│   ├── generation/             #   Two-stage lesson generation pipeline
│   ├── orchestration/          #   LangGraph multi-agent orchestration (director graph)
│   ├── playback/               #   Playback state machine (idle → playing → live)
│   ├── action/                 #   Action execution engine (speech, whiteboard, effects)
│   ├── ai/                     #   LLM provider abstraction
│   ├── api/                    #   Stage API facade (slide/canvas/scene manipulation)
│   ├── store/                  #   Zustand state stores
│   ├── types/                  #   Centralized TypeScript type definitions
│   ├── audio/                  #   TTS & ASR providers
│   ├── media/                  #   Image & video generation providers
│   ├── persistence/            #   Browser/server persistence wiring and PostgreSQL provider
│   ├── server/agent-runtime/   #   Durable runner, skills, materials, and course-building tools
│   ├── export/                 #   PPTX & HTML export
│   ├── hooks/                  #   React custom hooks (55+)
│   ├── i18n/                   #   Internationalization (zh-CN, zh-TW, en-US, ja-JP, ko-KR, ru-RU, ar-SA, pt-BR, es-MX, fr-FR, vi-VN, de-DE)
│   └── ...                     #   prosemirror, storage, pdf, web-search, utils
│
├── components/                 # React UI components
│   ├── slide-renderer/         #   Canvas-based slide editor & renderer
│   │   ├── Editor/Canvas/      #     Interactive editing canvas
│   │   └── components/element/ #     Element renderers (text, image, shape, table, chart …)
│   ├── scene-renderers/        #   Quiz, Interactive, PBL scene renderers
│   ├── generation/             #   Lesson generation toolbar & progress
│   ├── workbench/              #   Pro workbench conversation and course-reference UI
│   ├── chat/                   #   Chat area & session management
│   ├── settings/               #   Settings panel (providers, TTS, ASR, media …)
│   ├── whiteboard/             #   SVG-based whiteboard drawing
│   ├── agent/                  #   Agent avatar, config, info bar
│   ├── ui/                     #   Base UI primitives (shadcn/ui + Radix)
│   └── ...                     #   audio, roundtable, stage, ai-elements
│
├── packages/                   # Workspace packages
│   ├── @openmaic/dsl/          #   Versioned course/slide data contract and validators
│   ├── @openmaic/renderer/     #   React renderer for the slide DSL
│   ├── @openmaic/editor/       #   Composable slide editing core and React surface
│   ├── @openmaic/importer/     #   PPTX → OpenMAIC slide importer
│   ├── @openmaic/generation/   #   Generation contracts, pipeline, and prompt assets
│   ├── @openmaic/storage/      #   Browser, HTTP, PostgreSQL, and S3 persistence primitives
│   ├── pptxgenjs/              #   Customized PowerPoint generation
│   └── mathml2omml/            #   MathML → Office Math conversion
│
├── render-service/             # MP4 video export render service (Chromium + FFmpeg, standalone container)
│
├── skills/                     # OpenClaw / ClawHub skills
│   └── openmaic/               #   Guided OpenMAIC setup & generation SOP
│       ├── SKILL.md            #   Thin router with confirmation rules
│       └── references/         #   On-demand SOP sections (generation, deployment, extending, …)
│
├── configs/                    # Shared constants (shapes, fonts, hotkeys, themes …)
└── public/                     # Static assets (logos, avatars)
```

### Key Architecture

- **Generation Pipeline** (`@openmaic/generation`) — Two-stage: outline generation → scene content generation
- **Agent Runtime** (`lib/server/agent-runtime/`) — PostgreSQL-backed sessions with leased execution, resume/steer semantics, skills, materials, and validated course tools
- **Persistence Layer** (`@openmaic/storage`) — Swappable document, runtime, KV, asset, agent-session, material, and user-skill stores
- **Multi-Agent Orchestration** (`lib/orchestration/`) — LangGraph state machine managing agent turns and discussions
- **Playback Engine** (`lib/playback/`) — State machine driving classroom playback and live interaction
- **Action Engine** (`lib/action/`) — Executes 21 action types (speech, whiteboard draw/text/shape/chart, spotlight, laser …)
- **Storage Layer** (`@openmaic/storage`) — Runtime/Document/asset storage abstraction with a Postgres reference implementation; its HTTP contracts let you plug in any external storage service

### How to Contribute

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 💼 Partnerships

This project is licensed under the MIT License, so commercial use is permitted free of charge. For partnership or collaboration inquiries, please contact: **thu_maic@mail.tsinghua.edu.cn**

---

## 📝 Citation

If you find OpenMAIC useful in your research, please consider citing:

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

## 📄 License

This project is licensed under the [MIT License](LICENSE).

### Third-Party Components

The repository bundles workspace packages that are **not** covered by the root MIT license and keep their own terms:

- `packages/mathml2omml` — [LGPL-3.0-or-later](packages/mathml2omml/LICENSE)
- `packages/pptxgenjs` — [MIT](packages/pptxgenjs/package.json) (third-party)

When redistributing the repository as a whole, the terms of each bundled package above apply to that package's files.
