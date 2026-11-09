# Native classroom context

The Native path uses the existing learner RuntimeStore as the board authority.
`route.ts` resolves the owner-scoped service and the model's vision capability;
`director-loop.ts` and `tools/call-agent.ts` attach request transforms through
the shared agent runtime.

## Current board state

Before each Pi model round, Director and Child independently read the board and
append one transient state-data message at the end of the model context. The
message is not added to conversation history. Director counts its size when
deciding to compact history and reads again after a compaction attempt. A failed
read is reported as `read_failed`, never as an empty board.

Historical `wb_read` results remain in history. This change does not refresh
state inside HTTP retries, remove old tool observations, synchronize browser
visibility across replicas, or serialize competing writes. Request-start scene
and panel information remains explicitly labeled as a request-start snapshot.

## Optional board images

`whiteboard-preview.ts` adapts the snapshot returned by a successful mutation to
the existing scene-preview protocol. It reuses the self-hostable service in
`render-service/`, `prepareScenePreview`, owner-scoped asset resolution, and
`POST /preview`. Set the existing runtime `RENDER_SERVICE_URL` to enable it.
Without configuration, writes retain their existing text feedback. An
unreachable, refusing, or incompatible preview service leaves the write
successful and returns a text notice. There is no rendering retry or second
write. The service's per-task execution mode currently refuses previews; use a
mode that supports its existing `/preview` endpoint.

Each successful mutation with preview enabled adds a PNG of the whole logical
board to its tool result, labeled with the snapshot's `lastSeq`. Preview details
record bytes and preparation/render duration. The shared `toModelMessages`
conversion preserves paired tool receipts and moves tool images into an
observation message; the provider adapter then encodes the image. Only models
whose resolved capability explicitly declares vision receive image blocks.

Snapshots are rendered without rereading mutable state, so a delayed preview
still describes its labeled sequence. Concurrent writes may make that snapshot
older than the board by the time it is consumed. Existing optimistic mutation
checks remain responsible for conflicts; no locks or queues are added here.
Images accumulate with tool history: two writes produce two images, and later
requests resend both. Board-edge overflow and live browser animation/visibility
are not represented by a fixed logical-board screenshot. Model fallback uses
the primary request's existing capability decision.

## Classroom skills and speech

`listClassroomSkills` reuses the shared SKILL.md discovery and native `read` tool.
The classroom catalog is separate from authoring skills. Builtin discovery is
cached per server process; this is not model preloading. Each teacher Child
(or assistant when no teacher is configured) starts with only names,
descriptions, and locations. A model-issued `read` adds the body to that Child's
tool history for later rounds. A new Child receives the catalog again, not a
synthetic read or the previous Child's skill body.

`call_agent` details expose `availableSkills` and `activatedSkills` for review.
Activation means a successful read of SKILL.md, including partial reads. The
shared read result's `offset`, `lines`, `totalLines`, and `sourceHash` distinguish
full coverage from partial reads; activation alone does not prove the model
followed the guidance.

Native visible text, including text before tools, is spoken to the learner.
The prompt asks for teaching content without tool narration and follows the
learner's language. Existing `buildLengthGuidelines` remains unchanged (teacher
70, assistant 60, student 40 Chinese characters, with the existing sentence
guidance). The skill contains teaching organization and diagram semantics, not
a script or a playback synchronization guarantee.

## Verification boundaries

Offline route tests drive real writes and the real provider adapter with a fake
PNG service and scripted model responses. They verify image payloads, capability
gating, snapshot sequencing, and one transient tail per request. Shared adapter
tests also cover OpenAI and Anthropic image encodings. These checks do not prove
that a model can notice or repair an obstruction, or measure rendering latency.

For an approved model evaluation, keep image transmission and visual correction
as separate outcomes. Across the three acceptance tasks, record each eligible
Child, successful and full skill reads, actual images per provider request,
provider-reported token usage, and total render duration. Report the denominator
and any missing measurements. If most Children do not read the skill, review
the data before considering preloading. Real classroom playback and teaching
quality require a separate manual check.
