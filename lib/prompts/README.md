# `lib/prompts`

File-based prompt loader + templates shared by both the generation pipeline and
the runtime orchestration layer.

## Directory layout

```
lib/prompts/
├── loader.ts             ← file I/O + cache
├── index.ts              ← public API (loadPrompt, buildPrompt, …) + PROMPT_IDS
├── types.ts              ← PromptId / SnippetId string literal unions
├── templates/
│   └── <prompt-id>/
│       ├── system.md     ← required
│       └── user.md       ← optional (mostly for offline generation prompts)
└── snippets/
    └── <snippet-id>.md   ← reusable blocks referenced via {{snippet:…}}
```

## Template syntax

Two kinds of placeholder:

| Syntax | Semantics | Resolved by |
|---|---|---|
| `{{variableName}}` | Value is provided by the caller via `buildPrompt(id, vars)` | `interpolateVariables` in `loader.ts` |
| `{{snippet:snippet-name}}` | File content is spliced in at load time | `processSnippets` in `loader.ts` |

Processing order is **snippet includes first, then variable interpolation**, so
snippets may themselves contain `{{variableName}}` placeholders if the caller
provides the value.

## Naming conventions

- **Placeholder names use `camelCase`.** Example: `{{agentName}}`, `{{stateContext}}`.
- **Template IDs use `kebab-case`.** Example: `agent-system`, `pbl-design`.
- `lib/prompts/templates/slide-content/{system,user}.md` still uses legacy
  `snake_case` placeholders (`{{canvas_width}}`, `{{canvas_height}}`). This
  predates the camelCase convention; don't imitate it when writing new templates.

## Adding a new prompt

1. Create `lib/prompts/templates/<new-id>/system.md` (and `user.md` if needed).
2. Add `<new-id>` to the `PromptId` union in `types.ts`.
3. Add `NEW_ID: '<new-id>'` to the `PROMPT_IDS` constant in `index.ts`
   (the `satisfies Record<string, PromptId>` clause enforces that the value
   exists in the union).
4. Call `buildPrompt(PROMPT_IDS.NEW_ID, vars)` from the consuming module.

## Still in TypeScript (not yet in templates)

Not every prompt fragment lives in markdown. Some role-conditional content
still exists as TS template literals and needs editing directly:

| What | Where | Why not in markdown |
|---|---|---|
| `ROLE_GUIDELINES` (teacher / assistant / student blocks) | `lib/orchestration/prompt-builder.ts` | Branches by `agentConfig.role` |
| Length targets (100 / 80 / 50 chars per role) | `buildLengthGuidelines` in `lib/orchestration/prompt-builder.ts` | Branches by role |
| Whiteboard guidelines (LaTeX sizing table, 1000×562 canvas, layout rules, code block spacing) | `buildWhiteboardGuidelines` in `lib/orchestration/prompt-builder.ts` | Branches by role |

These may migrate into snippets in a later pass once Phase 2 eval feedback
shows which parts need frequent iteration.

## Silent-passthrough gotcha

`interpolateVariables` leaves unknown placeholders **unchanged** rather than
throwing:

```ts
interpolate('hello {{missing}}', {}) === 'hello {{missing}}'
```

This is intentional for partial-render scenarios but means a typo in a
placeholder name ships literal `{{…}}` text to the LLM. Defence:

- Tests in `tests/prompts/templates.test.ts` assert that the fully-rendered
  agent-system / director / pbl-design prompts contain no surviving
  `{{…}}` tokens. Keep that check passing when adding variables.
- `{{snippet:name}}` lookups **throw** on a missing snippet file rather than
  passing through silently, so a typo like `{{snippet:speach-guidelines}}`
  fails at load time instead of reaching the LLM.

## Testing a template change locally

The cheapest feedback loop is the template smoke suite:

```bash
pnpm test tests/prompts
```

For end-to-end runtime behaviour (agent loop + template composition +
chat/director integration), use the whiteboard eval harness on one scenario:

```bash
PORT=3100 pnpm dev &
EVAL_CHAT_MODEL=<provider:model> EVAL_SCORER_MODEL=<provider:model> \
  pnpm eval:whiteboard --base-url http://localhost:3100 \
  --scenario econ-tech-innovation
```

## Caching

`loadPrompt` and `loadSnippet` cache on first read for the lifetime of the
process. Call `clearPromptCache()` if you're iterating on markdown in a
long-lived REPL / dev server and want to pick up changes. Production reads
are idempotent so the cache is always hot.
