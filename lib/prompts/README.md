# `lib/prompts`

File-based prompt loader + templates for app-only prompts (the interactive
and task-engine outline modes, and web-search query rewriting). Generation
templates live in `@openmaic/generation`.

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

Three kinds of placeholder:

| Syntax | Semantics | Resolved by |
|---|---|---|
| `{{variableName}}` | Value is provided by the caller via `buildPrompt(id, vars)` | `interpolateVariables` in `loader.ts` |
| `{{snippet:snippet-name}}` | File content is spliced in at load time | `processSnippets` in `loader.ts` |
| `{{#if conditionName}}...{{/if}}` | Content is included only when `conditionName` is truthy in the template variables | `processConditionalBlocks` in `loader.ts` |

Processing order is **snippet includes first, then conditional blocks, then
variable interpolation**, so snippets may themselves contain `{{#if}}`
blocks and `{{variableName}}` placeholders if the caller provides the value.

Conditional blocks read from the same `variables` record passed to
`buildPrompt` — no separate conditions object is needed.

## Naming conventions

- **Placeholder names use `camelCase`.** Example: `{{agentName}}`, `{{stateContext}}`.
- **Template IDs use `kebab-case`.** Example: `task-engine-outlines`, `interactive-outlines`.
- Package-owned generation templates follow the same placeholder conventions;
  edit them under `packages/@openmaic/generation/templates/`.

## Adding a new prompt

1. Create `lib/prompts/templates/<new-id>/system.md` (and `user.md` if needed).
2. Add `<new-id>` to the `PromptId` union in `types.ts`.
3. Add `NEW_ID: '<new-id>'` to the `PROMPT_IDS` constant in `index.ts`
   (the `satisfies Record<string, PromptId>` clause enforces that the value
   exists in the union).
4. Call `buildPrompt(PROMPT_IDS.NEW_ID, vars)` from the consuming module.

## Still in TypeScript (not yet in templates)

Not every prompt fragment lives in markdown. The classroom chat prompts are
built in TypeScript, and their role-conditional content needs editing directly:

| What | Where | Why not in markdown |
|---|---|---|
| Role guidelines (teacher / assistant / student blocks) | `buildRoleGuideline` in `lib/chat/pi/prompts.ts` | Branches by `agent.role` |
| Length targets (70 / 60 / 40 Chinese characters per role) | `buildLengthGuidelines` in `lib/chat/pi/prompts.ts` | Branches by role |

## Silent-passthrough gotcha

`interpolateVariables` leaves unknown placeholders **unchanged** rather than
throwing:

```ts
interpolate('hello {{missing}}', {}) === 'hello {{missing}}'
```

This is intentional for partial-render scenarios but means a typo in a
placeholder name ships literal `{{…}}` text to the LLM. Defence:

- `tests/prompts/templates.test.ts` lints placeholder naming in the app
  templates. Rendered-prompt tests assert that no `{{…}}` tokens survive, for
  app templates (for example `tests/prompts/task-engine-outlines.test.ts`) and
  for generation prompts (in `tests/prompts/` and
  `packages/@openmaic/generation/test/`). Keep those checks passing when adding
  variables.
- `{{snippet:name}}` lookups **throw** on a missing snippet file rather than
  passing through silently, so a reference like `{{snippet:missing-snippet}}`
  fails at load time instead of reaching the LLM.

## Testing a template change locally

The cheapest feedback loop is the template smoke suite:

```bash
pnpm test tests/prompts
```

For end-to-end classroom behaviour, use the whiteboard eval harness on one
scenario. It sends each scripted user turn to `/api/chat/pi`, which runs the Pi
director with the default legacy child, so start the server with the native
child runtime explicitly off:

```bash
OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME=false PORT=3100 pnpm dev &
EVAL_CHAT_MODEL=<provider:model> EVAL_SCORER_MODEL=<provider:model> \
  pnpm eval:whiteboard --base-url http://localhost:3100 \
  --scenario econ-tech-innovation
```

## Loading

`loadPrompt` and `loadSnippet` read from disk on every call. No caching —
markdown edits take effect immediately without restarting any dev server.
Prompt disk I/O is negligible next to the LLM call it feeds.
