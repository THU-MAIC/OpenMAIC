# OpenMAIC 部署与自定义 Provider 操作教程

> 供 Claude 实例参考的操作手册，基于实际部署经验总结。

## 1. 项目概览

- 项目地址：`/home/sunli/MyWork/myproject/OpenMAIC/`
- GitHub：`https://github.com/THU-MAIC/OpenMAIC`
- 技术栈：Next.js 16 + React 19 + TypeScript + LangGraph + pnpm
- 服务端口：8002
- 访问地址：`http://172.16.29.100:8002`

## 2. 部署步骤

### 环境要求
- Node.js >= 20（当前 v20.19.6）
- pnpm >= 10（通过 `sudo corepack enable pnpm` 启用）

### 克隆与安装
```bash
# 需要代理访问 GitHub
export http_proxy="http://127.0.0.1:17891" https_proxy="http://127.0.0.1:17891"
git clone https://github.com/THU-MAIC/OpenMAIC.git
cd OpenMAIC
pnpm install
```

### 配置
```bash
cp .env.example .env.local
# 编辑 .env.local 填入 LLM provider 配置
```

### 构建与启动
```bash
pnpm build
# 后台启动，指定端口 8002
nohup pnpm start -p 8002 > /tmp/openmaic.log 2>&1 &
```

### 停止服务
```bash
pkill -f "next-server"
```

## 3. 新增自定义 LLM Provider（以七牛云 QN 为例）

OpenMAIC 内置了 10 个 provider（openai, anthropic, google, deepseek, qwen, kimi, minimax, glm, siliconflow, doubao）。如果要接入新的 OpenAI 兼容 API，需要改 4 个文件。

### 3.1 `lib/types/provider.ts` — 添加 Provider ID

在 `BuiltInProviderId` 联合类型中添加新 ID：

```typescript
export type BuiltInProviderId =
  | 'openai'
  | 'anthropic'
  // ...existing...
  | 'doubao'
  | 'qn';       // ← 新增
```

### 3.2 `lib/ai/providers.ts` — 注册 Provider 配置

在 `PROVIDERS` 对象末尾（`doubao` 之后，`};` 之前）添加：

```typescript
qn: {
  id: 'qn',
  name: 'QN (七牛云)',
  type: 'openai',                          // OpenAI 兼容接口
  defaultBaseUrl: 'https://api.qnaigc.com/v1',
  requiresApiKey: true,
  icon: '/logos/qwen.svg',                 // 暂用已有图标
  models: [
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      contextWindow: 1048576,
      capabilities: { streaming: true, tools: true, vision: false },
    },
    {
      id: 'deepseek-v3.1',
      name: 'DeepSeek V3.1',
      contextWindow: 128000,
      capabilities: { streaming: true, tools: true, vision: false },
    },
    // ...更多模型按需添加
  ],
},
```

关键字段说明：
- `type: 'openai'` — 使用 `@ai-sdk/openai` 的 `createOpenAI` 创建客户端，兼容所有 OpenAI API 格式的服务
- `type: 'anthropic'` — 使用 `@ai-sdk/anthropic`
- `type: 'google'` — 使用 `@ai-sdk/google`
- `models` — 前端模型选择列表，ID 必须与 API 实际支持的模型名一致

### 3.3 `lib/server/provider-config.ts` — 添加环境变量映射

在 `LLM_ENV_MAP` 中添加映射（key 是环境变量前缀，value 是 provider ID）：

```typescript
const LLM_ENV_MAP: Record<string, string> = {
  OPENAI: 'openai',
  // ...existing...
  DOUBAO: 'doubao',
  QN: 'qn',        // ← 新增：QN_API_KEY, QN_BASE_URL, QN_MODELS
};
```

这样系统会自动读取 `QN_API_KEY`、`QN_BASE_URL`、`QN_MODELS` 环境变量。

### 3.4 `.env.local` — 配置 API 密钥

```env
QN_API_KEY=sk-your-api-key-here
QN_BASE_URL=https://api.qnaigc.com/v1
QN_MODELS=                                 # 留空则显示 providers.ts 中定义的所有模型

# 设置默认模型（格式：providerId:modelId）
DEFAULT_MODEL=qn:gemini-3.1-pro-preview
```

## 4. 架构要点（供理解代码用）

### 配置加载流程
```
.env.local / server-providers.yml
    ↓
lib/server/provider-config.ts    （服务端加载，缓存在内存）
    ↓
GET /api/server-providers        （返回 provider ID + metadata，不暴露 API key）
    ↓
lib/store/settings.ts            （前端 Zustand store，合并到 providersConfig）
    ↓
前端 UI 显示 provider 列表
```

### 模型调用流程
```
前端选择 model → POST /api/chat (body: { model: "qn:gemini-3.1-pro-preview" })
    ↓
lib/server/resolve-model.ts      （解析 modelString，获取 apiKey/baseUrl）
    ↓
lib/ai/providers.ts getModel()   （根据 provider.type 创建对应 SDK 客户端）
    ↓
createOpenAI({ apiKey, baseURL }) → 调用 QN API
```

### 关键文件索引
| 文件 | 作用 |
|------|------|
| `lib/types/provider.ts` | Provider/Model 类型定义 |
| `lib/ai/providers.ts` | Provider 注册表 + getModel() |
| `lib/server/provider-config.ts` | 服务端配置加载（env + yaml） |
| `lib/server/resolve-model.ts` | API 路由中的模型解析 |
| `lib/store/settings.ts` | 前端设置 store（Zustand） |
| `lib/types/settings.ts` | ProviderSettings 类型 |
| `app/api/server-providers/route.ts` | 暴露 provider 元数据的 API |
| `app/api/chat/route.ts` | 聊天 API 路由 |

### 自动机制（不需要手动改）
- `getDefaultProvidersConfig()` — 遍历 `PROVIDERS` 自动生成前端初始配置
- `ensureBuiltInProviders()` — 每次 rehydrate 自动合并新增的 provider
- `fetchServerProviders()` — 前端自动标记 `isServerConfigured`，显示"管理员已配置"

## 5. 常用操作

### 查看 QN API 可用模型
```bash
export http_proxy="http://127.0.0.1:17891" https_proxy="http://127.0.0.1:17891"
curl -s https://api.qnaigc.com/v1/models \
  -H "Authorization: Bearer $QN_API_KEY" | python3 -m json.tool
```

### 验证 server-providers API
```bash
curl -s http://localhost:8002/api/server-providers | python3 -m json.tool
```

### 健康检查
```bash
curl -s http://localhost:8002/api/health
```

### 重新构建部署
```bash
pkill -f "next-server"
cd /home/sunli/MyWork/myproject/OpenMAIC
pnpm build
nohup pnpm start -p 8002 > /tmp/openmaic.log 2>&1 &
```

## 6. 注意事项

- `OPENAI_MODELS` 等 `*_MODELS` 环境变量如果设了值，前端会用 `filter` 从内置模型列表筛选。如果模型 ID 不在内置列表里，会被过滤掉导致列表为空。所以自定义 provider 的模型必须在 `providers.ts` 的 `models` 数组中注册。
- `DEFAULT_MODEL` 只影响服务端 API 的 fallback 模型（`resolve-model.ts:30`），不影响前端 UI 默认选择。
- 前端首次加载时，如果用户没选过模型，会自动选择第一个 `isServerConfigured` 的 provider 的第一个模型。
- `.env.local` 已在 `.gitignore` 中（`.env*` 规则），不会被提交。
- 构建需要代理：`export http_proxy="http://127.0.0.1:17891" https_proxy="http://127.0.0.1:17891"`

## 7. 项目目录结构

```
OpenMAIC/
├── app/                          # Next.js App Router
│   ├── api/                      #   服务端 API 路由
│   │   ├── chat/route.ts         #     多智能体聊天（SSE 流式）
│   │   ├── generate-classroom/   #     异步课堂生成（提交 + 轮询）
│   │   ├── generate/             #     场景生成流水线
│   │   │   ├── scene-outlines-stream/  # 大纲生成
│   │   │   ├── scene-content/    #     场景内容生成
│   │   │   ├── scene-actions/    #     场景动作生成
│   │   │   ├── agent-profiles/   #     智能体角色生成
│   │   │   ├── tts/              #     语音合成
│   │   │   └── image/            #     图片生成
│   │   ├── quiz-grade/           #     测验评分
│   │   ├── parse-pdf/            #     PDF 解析
│   │   ├── pbl/                  #     项目制学习
│   │   ├── web-search/           #     网络搜索
│   │   ├── transcription/        #     语音识别
│   │   ├── server-providers/     #     Provider 元数据 API
│   │   ├── health/               #     健康检查
│   │   ├── verify-model/         #     模型验证
│   │   └── classroom/            #     课堂数据 API
│   ├── classroom/[id]/           #   课堂页面（动态路由）
│   ├── generation-preview/       #   生成预览页面
│   ├── layout.tsx                #   根布局
│   └── page.tsx                  #   首页
├── components/                   # React 组件
│   ├── classroom/                #   课堂相关组件（slides, quiz, interactive, pbl）
│   ├── generation/               #   课堂生成 UI
│   ├── settings/                 #   设置面板
│   └── ui/                       #   通用 UI 组件（shadcn/radix）
├── lib/                          # 核心库
│   ├── ai/                       #   AI Provider 注册 + 模型创建
│   │   └── providers.ts          #     ★ PROVIDERS 注册表 + getModel()
│   ├── server/                   #   服务端工具
│   │   ├── provider-config.ts    #     ★ 环境变量/YAML 配置加载
│   │   └── resolve-model.ts      #     ★ 模型解析（DEFAULT_MODEL fallback）
│   ├── store/                    #   前端状态管理
│   │   └── settings.ts           #     ★ Zustand store（provider/model 选择）
│   ├── types/                    #   TypeScript 类型定义
│   │   ├── provider.ts           #     ★ ProviderId, ModelInfo 等
│   │   └── settings.ts           #     ProviderSettings 类型
│   ├── generation/               #   课堂生成逻辑（大纲→场景→内容）
│   ├── orchestration/            #   多智能体编排（LangGraph）
│   ├── chat/                     #   聊天逻辑
│   ├── audio/                    #   TTS/ASR 音频处理
│   ├── pdf/                      #   PDF 解析（unpdf/MinerU）
│   ├── media/                    #   图片/视频生成
│   ├── export/                   #   导出（PPTX/HTML）
│   ├── playback/                 #   课堂回放控制
│   ├── i18n/                     #   国际化（中/英）
│   ├── web-search/               #   网络搜索（Tavily）
│   └── utils/                    #   通用工具函数
├── packages/                     # workspace 子包
│   ├── mathml2omml/              #   MathML → OMML 转换（PPTX 公式）
│   └── pptxgenjs/                #   PPTX 生成（fork 版）
├── public/logos/                 # Provider 图标（SVG/PNG）
├── .env.example                  # 环境变量模板
├── .env.local                    # 实际配置（gitignored）
├── next.config.ts                # Next.js 配置
├── package.json                  # 依赖（pnpm workspace）
└── CLAUDE_DEPLOY_GUIDE.md        # 本文档
```

标 ★ 的是修改最频繁的核心文件。

## 8. 课堂生成流程

这是 OpenMAIC 的核心功能，理解它对排查问题至关重要。

### 两阶段流水线
```
用户输入主题/上传PDF
    ↓
[阶段1] 大纲生成
    POST /api/generate/scene-outlines-stream
    → LLM 分析输入，生成结构化大纲（SSE 流式返回）
    ↓
[阶段2] 场景生成（并行）
    对每个大纲条目：
    ├── POST /api/generate/scene-content    → 生成场景内容（slides/quiz/interactive/pbl）
    ├── POST /api/generate/scene-actions    → 生成教师动作（激光笔、聚光灯等）
    ├── POST /api/generate/agent-profiles   → 生成智能体角色
    └── POST /api/generate/tts              → 生成语音
    ↓
课堂就绪，跳转 /classroom/{id}
```

### 异步生成模式（API 调用）
```bash
# 1. 提交生成任务
curl -X POST http://localhost:8002/api/generate-classroom \
  -H "Content-Type: application/json" \
  -d '{"requirement": "教我 Python 基础"}'
# 返回: { "jobId": "abc123", "pollUrl": "...", "status": "queued" }

# 2. 轮询进度
curl http://localhost:8002/api/generate-classroom/abc123
# 返回: { "status": "running", "step": "generating-scenes", "progress": 0.6 }

# 3. 完成后获取课堂 URL
# 返回: { "status": "succeeded", "result": { "classroomId": "xxx", "url": "/classroom/xxx" } }
```

## 9. 前端页面路由

| 路由 | 说明 |
|------|------|
| `/` | 首页 — 输入主题或上传 PDF 生成课堂 |
| `/classroom/[id]` | 课堂页面 — 幻灯片、测验、互动、PBL |
| `/generation-preview` | 生成预览 — 查看大纲和场景生成进度 |

前端状态全部存在浏览器 localStorage（key: `settings-storage`），通过 Zustand persist 中间件管理。清除浏览器缓存会重置所有设置。

## 10. 多智能体系统

### 编排引擎
- 基于 LangGraph（`lib/orchestration/`）
- 支持多个 AI 智能体角色（教师、学生、助教等）
- 聊天通过 SSE 流式传输（`app/api/chat/route.ts`）

### 场景类型
| 类型 | 说明 | 关键组件 |
|------|------|----------|
| slides | 幻灯片演示 | `components/classroom/slides/` |
| quiz | 交互测验 | `components/classroom/quiz/` |
| interactive | HTML 交互模拟 | `components/classroom/interactive/` |
| pbl | 项目制学习 | `components/classroom/pbl/` |

## 11. 当前 .env.local 配置状态

```env
# 已配置（有效）
QN_API_KEY=sk-ebad...（七牛云 API）
QN_BASE_URL=https://api.qnaigc.com/v1
DEFAULT_MODEL=qn:gemini-3.1-pro-preview

# 未配置（留空）
OPENAI_API_KEY=        # 如需 OpenAI 原生模型
ANTHROPIC_API_KEY=     # 如需 Claude 模型
GOOGLE_API_KEY=        # 如需 Gemini 模型（直连 Google）
# TTS/ASR/PDF/Image/Video 均未配置
```

如需添加更多 provider，直接在 `.env.local` 填入对应的 `{PROVIDER}_API_KEY` 即可，无需改代码（前提是该 provider 已在内置列表中）。

## 12. 故障排查

### 服务无法启动
```bash
# 查看日志
tail -50 /tmp/openmaic.log

# 检查端口占用
ss -tlnp | grep 8002

# 杀掉残留进程
pkill -f "next-server"
```

### 模型调用失败
```bash
# 1. 确认 provider 配置正确
curl -s http://localhost:8002/api/server-providers | python3 -m json.tool

# 2. 直接测试 QN API 连通性（需代理）
export http_proxy="http://127.0.0.1:17891" https_proxy="http://127.0.0.1:17891"
curl -s https://api.qnaigc.com/v1/chat/completions \
  -H "Authorization: Bearer sk-ebad216962663702e91a69addd28b51c85c3b6b01a3e6dd623cdf89f319bade5" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-pro-preview","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'

# 3. 检查服务端日志中的错误
grep -i "error\|fail" /tmp/openmaic.log | tail -20
```

### 前端不显示新 provider
- 清除浏览器 localStorage（开发者工具 → Application → Storage → Clear site data）
- 或删除 `settings-storage` key
- 确认已重新 `pnpm build` 并重启服务

### 课堂生成卡住
```bash
# 检查生成任务状态
curl -s http://localhost:8002/api/generate-classroom/{jobId} | python3 -m json.tool
```
生成任务是内存中的，服务重启后任务丢失。

### 构建失败
```bash
# TypeScript 类型错误：检查新增的 provider ID 是否在所有相关文件中一致
# 常见遗漏：lib/types/provider.ts 的 BuiltInProviderId 忘记添加

# 依赖问题：清理重装
rm -rf node_modules .next
pnpm install
pnpm build
```

## 13. 代理相关

本机通过 Shadowsocks 代理访问外网：
- HTTP 代理：`http://127.0.0.1:17891`
- SOCKS5 代理：`socks5://127.0.0.1:17890`
- 服务：`shadowsocks-client.service`

OpenMAIC 服务端调用 QN API 时，QN API 地址 `api.qnaigc.com` 是国内服务，不需要代理。但如果配置了 OpenAI/Anthropic/Google 等海外 provider，需要在 `.env.local` 中设置：
```env
HTTP_PROXY=http://127.0.0.1:17891
HTTPS_PROXY=http://127.0.0.1:17891
```

`pnpm install` 和 `pnpm build` 下载依赖时需要代理（npm registry 部分包在海外）。

---

> 最后更新：2026-03-20 | 维护者：Claude Code
