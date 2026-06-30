# MAIC Editor Agent — `regenerate_scene` (next-release capability widening)

- Date: 2026-06-21
- Base branch: `feat/maic-editor-agent-v0`
- Status: design approved, pending spec review → implementation plan

## 1. Background

The MAIC Editor Agent v0 (`feat/maic-editor-agent-v0`) stands up a server-side
`pi` Agent that streams `AgentEvent`s to the editor sidebar over SSE. Its
capability surface is deliberately one tool — `regenerate_scene_actions` — gated
by a tool allowlist (`V0_ALLOWLIST`). The design philosophy is **capability =
allowlist**: widening capability means adding tools to the allowlist, never
hardcoding a workflow.

Two limitations make v0 a demo rather than a usable editing assistant:

1. The agent can only regenerate **narration/actions**, not slide **content**.
   The system prompt hard-refuses any content edit; the user must hand-edit the
   canvas themselves.
2. The agent never **sees** the current scene. Scene context (outline / content)
   is injected into the tool's deps (`getSceneContext`) but is invisible to the
   model. So even `regenerate_scene_actions` is effectively a blind re-roll — the
   model cannot translate "this slide is too dense" into a precise instruction
   because it does not know what is on the slide.

## 2. Goal

Reach **basic user usability** in the next release by letting the agent
**read** a slide and then **regenerate the whole slide (content + narration)
under a natural-language instruction**, with a safe apply/restore story.

## 3. Scope decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Capability class | **Regeneration only** — no add / delete / reorder / insert | Structural ops are one click away on the canvas + NavRail; the agent's differentiated value is generation, not clicking structural buttons. Keeps allowlist + blast radius tight. |
| Regeneration granularity | **Whole page** (content + actions) in one tool | Simplest mental model — "redo this slide". Reuses `generateFullScenes`. |
| Steerability | **Instruction-driven** (every regeneration accepts an optional NL instruction) | Without an instruction, regeneration is a slot machine, not a tool. This is the usability unlock. |
| Apply model | **Apply directly + explicit "还原到重生成前" button** on the tool card | Snapshots the pre-regenerate scene; does not rely on the user remembering Ctrl+Z; lighter than a full preview/approve surface. |
| Scene-type scope | **slide only** | Most pages are slides; lowest risk; matches the restrained v0 posture. Other types: the agent honestly says "not supported yet". |
| Agent ↔ content access | **`read_scene_content` tool** (read-then-act) | The agent reads the slide to reason and craft a precise instruction. Read-only is zero-risk and yields free Q&A ("what's on this slide?"). |

### Explicit non-goals (next release)

- No new-slide / delete / reorder / duplicate capability.
- No element-level or region-select local editing (a separate inline local-edit
  track, out of scope here).
- No quiz / interactive / PBL regeneration.
- No multi-scene / deck-wide operations.
- No preview/diff surface beyond the restore button.

## 4. Architecture

The next-release allowlist grows from 1 tool to 3:

| Tool | Kind | Purpose |
|---|---|---|
| `read_scene_content` | read (new) | Return the current slide's content + outline for a `sceneId` so the model can reason, answer questions, and distil a precise regenerate instruction. |
| `regenerate_scene` | write (new) | Regenerate the whole slide (content + actions) for a `sceneId`, using **trusted injected content as baseline** + the agent's NL instruction → `generateFullScenes`. slide-only. |
| `regenerate_scene_actions` | write (existing) | Unchanged. Regenerate narration/actions only. |

### 4.1 Trust boundary (carries v0's "model is not a data source" rule)

- `read_scene_content` surfaces content **to the model's reasoning context**, on
  demand, pulled from the same client-injected `sceneContextMap` the route
  already receives. This replaces "pre-stuff everything" with "pull what you
  need" — strictly more token-efficient.
- `regenerate_scene` **executes** against the trusted injected content resolved
  by `sceneId` (never against content the model retyped). The model contributes
  only `{ sceneId?, instruction? }`. The instruction is NL intent, not content.

So: the model reads content to **write a good instruction**; the generation
consumes content from the **trusted source**. Both paths are needed.

## 5. Components & changes

### 5.1 `read_scene_content` tool — `lib/agent/tools/read-scene-content.ts` (new)

- Factory `makeReadSceneContentTool(deps)` mirroring the
  `makeRegenerateSceneActionsTool` shape.
- Args (typebox): `{ sceneId?: string }` — defaults to the active scene.
- `execute`: resolves `getSceneContext(sceneId)` and returns a compact,
  model-readable projection of `{ title, type, outline, content }`. For
  non-slide types it still returns a readable summary (read is safe for all
  types even though regenerate is slide-only).
- Reuses the existing `SceneContext` deps; no new data plumbing.

### 5.2 `regenerate_scene` tool — `lib/agent/tools/regenerate-scene.ts` (new)

- Factory `makeRegenerateSceneTool({ aiCall, getSceneContext })`, sibling to
  `regenerate-scene-actions.ts`.
- Args (typebox): `{ sceneId?: string, instruction?: string }`.
- `execute`:
  1. Resolve trusted context (`outline`, `allOutlines`, current `content`,
     `stageId`) via `getSceneContext`.
  2. **Guard**: if `outline.type !== 'slide'`, return a typed refusal result
     (the model relays "only slides are supported yet"). No generation.
  3. Call the content pipeline (see 5.4) with the current content as baseline +
     `instruction` as `editDirective`, then regenerate actions to match.
  4. Return `{ content, actions }` in `details`, same `tool_execution_end`
     contract as `regenerate_scene_actions`, so the client applies them.

### 5.3 Registry / allowlist — `lib/agent/tools/registry.ts`

- `ToolsetDeps` unchanged shape (same `SceneContext` deps reused by all three).
- `buildToolset` returns `[read_scene_content, regenerate_scene,
  regenerate_scene_actions]`.
- `V0_ALLOWLIST` → `new Set(['read_scene_content', 'regenerate_scene',
  'regenerate_scene_actions'])`.

### 5.4 Generation pipeline — `lib/generation/scene-generator.ts`

`generateSceneContent` already threads a `languageDirective` into its prompt;
this is the template for the new inputs. Add to `SceneContentOptions`:

- `editDirective?: string` — the agent's NL instruction, woven into the slide
  content prompt the same way `languageDirective` is.
- `baselineContent?: GeneratedSlideContent` — the current slide content, fed as
  the edit baseline so content-specific instructions ("drop the 2nd bullet",
  "sharpen the title") operate on the real slide rather than re-rolling from
  outline. When absent, behaviour is today's outline-based generation.

Only the **slide** branch of `generateSceneContent` consumes the baseline in the
next release; other branches ignore it (slide-only scope).

### 5.5 Server route — `app/api/agent/edit/route.ts`

- Wire the two new tools through `buildToolset` (no new request fields needed —
  `sceneContextMap` already carries everything).
- The existing `aiCall` (resolved `maic-agent` model) is shared by all tools.

### 5.6 System prompt — `lib/agent/runtime/build-agent.ts`

Rewrite the capability-boundary paragraph from "you can ONLY regenerate
narration" to:

- You can **read** the current slide (`read_scene_content`) to understand it and
  answer questions about it.
- You can **regenerate the whole slide** (content + narration) for **slide-type**
  scenes, following the user's instruction (`regenerate_scene`); you can also
  regenerate **only the narration** (`regenerate_scene_actions`).
- You still CANNOT: add / delete / reorder / duplicate slides; edit quiz,
  interactive (GenUI) or whiteboard content; regenerate non-slide scenes — say
  so honestly and suggest the user edits those on the canvas.
- Regeneration rebuilds the slide wholesale; it cannot guarantee specific
  existing elements/cues survive unchanged.

### 5.7 Client — `components/edit/AgentPanel/*` + `lib/agent/client/*`

- New `regenerate-scene-tool-ui.tsx` tool card (sibling to the existing
  `regenerate-tool-ui.tsx`): on `tool_execution_end`,
  1. **snapshot** the scene's pre-regenerate `{ content, actions }` into the
     card's local state,
  2. apply the new `{ content, actions }` into `useStageStore`,
  3. render a **"还原到重生成前"** button that re-applies the snapshot.
- `read_scene_content` needs no special card — its result feeds the model's next
  turn; the assistant reply renders normally.
- `use-agent-runtime` apply logic generalised to dispatch by tool name
  (regenerate_scene → content+actions; regenerate_scene_actions → actions only).

## 6. Data flow (happy path)

```
user: "这页太满了，精简成3个要点"
  → agent calls read_scene_content(activeScene)
      → tool returns {title, outline, content(7 bullets)}
  → agent reasons, calls regenerate_scene(sceneId, instruction:
      "精简为3点，保留 X/Y/Z，删掉细节举例")
      → tool: guard slide ✓; generateSceneContent(outline, aiCall,
          {baselineContent: current, editDirective: instruction})
          → generateSceneActions(...) ; returns {content, actions}
  → client tool card: snapshot old → apply new → show 还原 button
  → agent reply: "已精简为3个要点，旁白也对齐了。"
```

## 7. Guardrails

- Master gate unchanged: `isMaicEditorEnabled()` 404s the route when off.
- `beforeToolCall` allowlist gate now admits the 3 tools; everything else denied.
- `regenerate_scene` hard-refuses non-slide types inside `execute`.
- Quota: unchanged v0 unlimited stub (shape aligned to the planned quota hook);
  regeneration is the expensive path, so this is where the quota hook will bite.
- Concurrency / superseded-run guards from v0 (stop-then-resend) apply unchanged.

## 8. Testing

Mirror the existing `tests/lib/agent/**` coverage:

- `read-scene-content.test.ts`: returns trusted projection; defaults to active
  scene; safe on non-slide types.
- `regenerate-scene.test.ts`: slide → calls content+actions with baseline +
  editDirective; non-slide → typed refusal, no generation; model-supplied
  content is ignored (trust boundary).
- `scene-generator` content test: `editDirective` + `baselineContent` reach the
  slide prompt; absent → today's behaviour unchanged (regression guard).
- `use-agent-runtime` client test: regenerate_scene applies content+actions and
  the restore snapshot round-trips.
- allowlist test updated to expect the 3-tool set.

## 9. Risks & open points

- **Baseline-edit prompt quality**: feeding current content + instruction into
  the slide prompt is the one non-trivial prompt change. Needs eval on a few
  representative instructions (精简 / 加例子 / 改标题 / 删某点) before release.
- **Wholesale replace surprises**: even with the restore button, a user who
  hand-edited then asked for an unrelated regeneration loses those edits until
  they hit restore. Acceptable for "basic usability"; preview/approve is the
  later upgrade.
- **Token growth**: `read_scene_content` puts slide content into the model
  context. Single-slide content is small; do not let the agent read all siblings
  by default.
- **Scene-type creep**: quiz/interactive are intentionally deferred; resist
  widening the slide-only guard in this release.
