# AgentBar — lightweight per-course conversation persistence

- Date: 2026-06-21
- Surface: `lib/agent/client/use-agent-runtime.ts` + a new thread store + an AgentBar header button
- Status: design approved, implementing

## Background

The AgentBar conversation lives only in `use-agent-runtime`'s React state
(`messages`). A page refresh (or unmount) drops it — the thread is gone. Full
session management (history list, rename, server sync, cross-device) is out of
scope for now (current positioning is short, targeted fixes). This adds a
**lightweight** persistence + a single management action.

## Goal

The conversation survives a refresh, scoped per course, with a one-tap "new
conversation" reset. No server, no multi-thread history.

## Scope decisions (locked)

| Decision | Choice |
|---|---|
| Scope | **One thread per course** (keyed by `stage.id`); switching courses gives each its own thread |
| Storage | **localStorage** via a zustand `persist` store (matches `lib/store/settings.ts`) |
| Payload | **Trimmed projection** — text + tool-card render metadata only; heavy result payloads (full elements, base64) stripped |
| Management | **A "新对话" (new/clear) button** in the AgentBar header (shown only when the thread is non-empty) |
| Restore button after refresh | **No special handling needed** — `RestoreButton` returns `null` when no in-memory snapshot exists, so storage-restored cards naturally render without it |

Explicit non-goals: multi-thread history per course, rename, server/PG sync,
cross-device, persisting the regenerate restore snapshot across reloads,
persisting the in-flight (mid-stream) turn.

## Components

### 1. Thread store — `lib/agent/client/agent-thread-store.ts` (new)

A zustand `persist` store (localStorage key `maic-agent-threads`):

```ts
export interface SerializedThread {
  messages: SerializedMessage[];
  updatedAt: number; // for future pruning; stamped by the caller, not Date.now() in-store
}
interface AgentThreadStoreState {
  threads: Record<string, SerializedThread>; // keyed by stageId
  save: (stageId: string, thread: SerializedThread) => void;
  load: (stageId: string) => SerializedThread | undefined;
  clear: (stageId: string) => void;
}
```

`SerializedMessage` mirrors the slim shape below. `save` writes
`threads[stageId]`; `clear` deletes the key. Persisted via
`persist(..., { name: 'maic-agent-threads', version: 1 })`.

### 2. Serialize / deserialize — `lib/agent/client/serialize-thread.ts` (new, pure)

`serializeThread(messages: ThreadMessageLike[]): SerializedMessage[]` and
`deserializeThread(saved: SerializedMessage[]): ThreadMessageLike[]`, pure and
unit-testable. The slim projection keeps exactly what the cards render:

- **user / text parts**: `{ type: 'text', text }`.
- **tool-call parts**: `{ type: 'tool-call', toolCallId, toolName, args: { sceneId?, instruction? }, isError?, result }` where the slim `result` is:
  - `content: [{ type: 'text', text }]` — keeps the failure/summary line (small).
  - `details.sceneId`.
  - `details.content`: `null` when the original was null (so the failure badge still derives), else `{ elements: Array(n).fill({}) }` — preserves `elements.length` for the element-count line without the heavy element data / base64.
  - `details.actions`: `(actions ?? []).map(a => ({ type: a.type }))` — keeps types for the action summary, drops the rest.
- message `status` collapses to `{ type: 'complete', reason: 'stop' }` (restored threads are never mid-run); `incomplete` preserved as failed where it mattered (already encoded in the slim result).

`deserializeThread` rebuilds `ThreadMessageLike[]` from that — same shape the
ExternalStore renders today.

### 3. Wire into `use-agent-runtime.ts`

- **Resolve stageId**: `useStageStore(s => s.stage?.id)` (subscribe, so a course
  switch re-runs the effect).
- **Load on mount / stage change**: an effect keyed on `stageId` — when it
  changes, `setMessages(deserializeThread(store.load(stageId)?.messages ?? []))`.
  Guard against clobbering an in-flight run (`if (isRunning) return`).
- **Save on turn completion**: in `onNew`'s `finally` (the non-superseded
  branch, after the final `setMessages`), call
  `store.save(stageId, { messages: serializeThread(latestMessages), updatedAt })`.
  Read the latest messages from the same `setMessages(prev => …)` updater so we
  serialize the final state. Skip saving while a run is mid-stream.
- **Expose `clearThread()`**: `setMessages([]); store.clear(stageId);`. Return it
  from `useAgentRuntime` alongside the runtime so the panel can call it.

`useAgentRuntime` currently returns the `useExternalStoreRuntime` value directly;
change it to return `{ runtime, clearThread }` (or attach `clearThread` to the
returned object) and update `AgentPanel` accordingly.

### 4. "新对话" button — `AgentPanel.tsx` header

- In the expanded panel header (the row with the brand mark + `PanelRightClose`
  collapse button), add a "新对话" button **left of** the collapse button, shown
  only when the thread has messages (`runtime`/a `hasMessages` flag). A small
  icon (e.g. `SquarePen` / `Plus`) + tooltip; click → `clearThread()`.
- No confirm dialog (lightweight); clearing returns the panel to the empty state.
- New i18n key `edit.agent.newConversation` (label/aria) across all 8 locales.

## Testing

- `serialize-thread`: round-trip — text + tool-call parts survive; a regenerate
  result with N elements serializes to `elements.length === N` with no element
  data; base64/heavy fields dropped; `details.content === null` preserved;
  action `type`s preserved.
- store: `save` then `load` returns the thread for that stageId; `clear` removes
  it; threads are isolated per stageId.
- `check:i18n-keys`, tsc, eslint, prettier green; existing agent tests still pass.

## Risks / open points

- **localStorage size**: with the trimmed projection a thread is small text; the
  store holds one entry per visited course. Acceptable. If it ever grows, prune
  by `updatedAt` (the field is already there) — not implemented now.
- **Stage not yet loaded on mount**: if `stage?.id` is briefly undefined while
  the stage store hydrates, the load effect keyed on `stageId` re-runs once the
  id appears — so the thread restores as soon as the course is known.
- **Mid-stream refresh**: the in-flight turn is lost (only completed turns are
  saved). Acceptable for lightweight.
