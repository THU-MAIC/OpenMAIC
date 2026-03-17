# Tech Stack

## Core
- **Framework**: Next.js 16 (App Router) with React 19
- **Language**: TypeScript 5 (strict mode)
- **Styling**: Tailwind CSS 4 with PostCSS
- **Package Manager**: pnpm 10.28.0 (workspace monorepo)
- **Node.js**: >= 20 (22 in Docker)

## AI / LLM
- **Vercel AI SDK** (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`)
- **LangChain / LangGraph** (`@langchain/core`, `@langchain/langgraph`) for multi-agent orchestration
- **MCP SDK** (`@modelcontextprotocol/sdk`)
- **CopilotKit** (`@copilotkit/backend`, `@copilotkit/runtime`)
- **OpenAI SDK** (direct usage)

## UI
- **Radix UI** / **shadcn/ui** for components
- **Lucide React** icons
- **Motion** (Framer Motion successor) for animations
- **XY Flow** (`@xyflow/react`) for flow diagrams
- **ECharts** for charts
- **ProseMirror** for rich text editing
- **KaTeX / Temml** for math rendering
- **cmdk** for command palette

## State Management
- **Zustand** for global state
- **Immer** for immutable state updates
- **Dexie** for IndexedDB (client-side storage)

## Export / File Processing
- **pptxgenjs** (workspace package) for PowerPoint export
- **mathml2omml** (workspace package) for MathML conversion
- **JSZip**, **file-saver** for file operations
- **Sharp** and **@napi-rs/canvas** for image processing
- **unpdf** for PDF parsing

## Workspace Packages
- `packages/mathml2omml` - MathML to OMML converter
- `packages/pptxgenjs` - PowerPoint generation (forked/modified)
