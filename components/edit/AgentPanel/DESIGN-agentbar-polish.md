# AgentBar polish — capability tips + voice input + unified tool rendering

- Date: 2026-06-21
- Surface: `components/edit/AgentPanel/*` (the "Edit with AI" editor sidebar)
- Builds on: the editor-agent feature (read_scene_content / regenerate_scene / regenerate_scene_actions)
- Status: design approved, pending spec review → implementation plan

## Background

Three issues with the current AgentBar:

1. **Stale, chip-driven guidance.** A row of clickable quick-prompt chips sits
   above the composer (`重新生成讲解旁白 / 让讲解更口语一些 / 加一个生活化类比`),
   and the empty state says "让 AI 重新生成与内容匹配的讲解旁白" — both still
   frame the agent as a *narration regenerator*, which is stale: the agent now
   regenerates the **whole slide** (content + narration) per instruction, reads
   the slide, etc. The user wants the chips removed and replaced with clearer,
   read-only **capability tips**.
2. **No voice input.** The composer has no dictation affordance.
3. **Inconsistent tool-call rendering.** Only `regenerate_scene` and
   `regenerate_scene_actions` have registered tool UIs; `read_scene_content`
   renders *nothing*, so a turn that reads the slide shows a blank gap between
   the assistant's "let me look at this page" and its reply.

## Goal

Make the AgentBar communicate the agent's real capabilities clearly, support
voice input, and render every tool call consistently.

## Scope decisions (locked)

| Decision | Choice |
|---|---|
| Capability guidance placement | **Empty state only** (vanishes once a conversation starts) |
| Guidance interactivity | **Pure read-only text** (no clickable examples — not "recommendations") |
| Guidance form | **Grouped capability list** — title + lead + 3 labeled rows w/ examples + boundary + "coming soon" closer |
| Voice input | **Reuse `SpeechButton` + `useASRAvailable`**, in the composer footer |
| Tool rendering | **Shared `ToolCard` shell**; `read_scene_content` gets a light card; generic fallback for unregistered tools |

Non-goals: no change to agent capabilities/tools; no per-element @-chips; no
model picker; no streaming-reasoning UI.

## Component changes — `components/edit/AgentPanel/`

### 1. Empty-state capability tips (`AgentPanel.tsx`)

- **Remove** the `QUICK_PROMPT_KEYS` array and the `<ThreadPrimitive.Suggestion>`
  chip row above the composer (the whole `scrollbar-hide … overflow-x-auto` div).
- **Replace** the single-line empty hint with a grouped capability list inside
  the existing `<ThreadPrimitive.Empty>` block:
  - Title: `有什么想改的?` (reuse `edit.agent.emptyTitle`)
  - Lead: `告诉我这一页怎么改，我会重做内容并对齐讲解。`
  - Three capability rows — each a bold/foreground **label** + one or two muted,
    quoted **examples** (read-only, NOT buttons):
    - `改内容` — `"精简成 3 个要点"` · `"加个生活化例子"`
    - `改讲解` — `"讲得更口语一些"` · `"对齐我刚改的画布"`
    - `问这页` — `"这页重点是什么?"`
  - Boundary line (muted): `增删 / 排序幻灯片请用左侧导航`
  - Closer (muted, with a sparkle): `更多能力陆续加入中，敬请期待 ✨`
- Visual: left-aligned rows within the existing centered ~260px container;
  labels `text-foreground`, examples `text-muted-foreground`, small sizes,
  consistent with the rail's existing type scale. Quoted examples may use the
  brand-violet faintly to read as "things you can say".

### 2. Voice input button (`AgentPanel.tsx` composer footer)

- Import `SpeechButton` (`@/components/audio/speech-button`) and render it in the
  composer's bottom action row, **left of** the Send/Stop button.
- Wire `onTranscription={(text) => appendToComposer(text)}`. The composer uses
  assistant-ui's `ComposerPrimitive.Input` (not local state), so append via the
  composer runtime: `useComposerRuntime().setText(currentText + (currentText && !endsWithSpace ? ' ' : '') + text)`. Confirm the exact assistant-ui API
  (`useComposerRuntime` / `getState().text` / `setText`) against the installed
  version; fall back to a ref on the underlying `<textarea>` if the runtime API
  isn't exposed.
- `SpeechButton` already self-gates via `useASRAvailable()` (disabled when ASR is
  off/unusable, except while actively recording). No extra gate needed; it simply
  shows as disabled when no ASR is configured. (Availability depends on whether
  an ASR provider is configured or browser-native ASR is present.)
- Style the button to match the composer chrome (same size box as Send, muted
  until active, brand-violet while recording — `SpeechButton` owns its active
  state; pass `className` to fit the footer).

### 3. Unified tool-call rendering

- **Extract** a shared `ToolCard` component (new `tool-card.tsx`) from the
  current `regenerate-tool-ui.tsx` / `regenerate-scene-tool-ui.tsx` scaffolding:
  the bordered `.ae-tool` shell — leading icon, truncating title, optional
  `@scene` pill (reuse the existing `ScenePill`), a right-aligned status badge
  (running = violet spinner, done = emerald check, failed = amber alert), an
  optional **inline bar-action slot** (rendered on the always-visible header row,
  e.g. for the Restore button), and an optional expandable body (children
  render-prop). This also resolves the previously-deferred tool-card duplication
  finding.
- **`read_scene_content` UI** (new `read-tool-ui.tsx`): register via
  `makeAssistantToolUI({ toolName: 'read_scene_content', render })` using the
  shared `ToolCard` — title `读取页面内容`, a book/eye glyph, the `@scene` pill,
  done = check; **no heavy expandable body** (a read is lightweight). Running →
  spinner, error → amber.
- **Refactor** `regenerate-tool-ui.tsx` and `regenerate-scene-tool-ui.tsx` to
  render their bodies *inside* the shared `ToolCard` (keep their body content:
  action breakdown / element-count). **Move the `regenerate_scene` Restore (还原)
  button out of the body and onto the tool bar** via the bar-action slot — it is
  currently buried (only reachable after expanding); surface it inline on the
  always-visible card row so revert is one tap. The `RestoreButton` component is
  unchanged; only its mount point moves to the bar-action slot. After restore,
  the bar shows the muted "已还原 / restored" state inline.
- **Generic fallback**: register a fallback tool UI (assistant-ui Tool fallback,
  or a catch-all `makeAssistantToolUI` per known tool name) so any unregistered
  tool still renders a minimal `ToolCard` titled by a humanized tool name —
  future tools never render blank.
- Mount the new `read_scene_content` UI (and fallback) alongside the existing
  `<RegenerateSceneActionsUI />` / `<RegenerateSceneUI />` in `AgentPanel.tsx`.

## i18n

- **Remove** keys `edit.agent.quickRegenerate / quickColloquial / quickAnalogy`
  from all 8 locales.
- **Update** `edit.agent.emptyHint` → repurpose as the lead, or add
  `edit.agent.empty.lead`.
- **Add** (all 8 locales): `edit.agent.cap.content.{label,examples}`,
  `edit.agent.cap.narration.{label,examples}`, `edit.agent.cap.ask.{label,examples}`,
  `edit.agent.empty.boundary`, `edit.agent.empty.comingSoon`, and
  `edit.agent.readCard.title` (`读取页面内容`). The `check:i18n-keys` gate must
  pass (keys aligned across all locales).

## Testing

- AgentBar renders the grouped empty state (no chips); examples are plain text,
  not buttons.
- `read_scene_content` tool call renders a `ToolCard` (title + done state) — a
  unit/render check that the tool UI is registered and the shared shell renders.
- `ToolCard` shared shell: running/done/failed badge states; optional body.
- Voice button: appended transcription lands in the composer text (mock
  `SpeechButton`/composer runtime); button absent/disabled when ASR unavailable.
- `check:i18n-keys`, tsc, eslint, prettier green.

## Risks / open points

- **Composer write API**: the one technical unknown is how to push the
  transcription into assistant-ui's `ComposerPrimitive.Input`. Verify
  `useComposerRuntime().setText` (or equivalent) exists in the installed
  assistant-ui version before building; textarea-ref fallback otherwise.
- **Fallback tool UI**: confirm assistant-ui supports a catch-all/fallback tool
  renderer in the installed version; if not, register the shared `ToolCard` per
  known tool name and accept that brand-new tool names render blank until added
  (still better than today for the known set).
