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

`whiteboard-preview.ts` renders the snapshot read for the current tail through
`prepareScenePreview`, owner-scoped asset resolution, and the self-hostable
`render-service/` endpoint `POST /preview`. It is enabled when
`RENDER_SERVICE_URL` is configured and passes the same `GET /health` check as
`render_scene_preview`, the Native classroom has a whiteboard service, and the
resolved model explicitly supports vision. The check runs once per chat request,
only when the other conditions hold. Otherwise requests retain text-only state.

Director and Child tails contain at most one whole-board PNG alongside the text
state. A nonempty existing board is visible on the first model round. Empty
boards (`lastSeq` is null or there are no elements) send no image. Mutation tool
results remain text-only, including `nextMutation.expectedLastSeq`; images are
not saved in tool history. User image transport is opt-in for this classroom
path and leaves authoring callers unchanged.

One chat HTTP request shares a single latest render cache and failure state
across its Director and Children. The cache key includes stage, session, board,
and `lastSeq`; unchanged snapshots reuse the image or pending render. Nothing
is cached across HTTP requests. A cleared board never reuses an old image.
Each render has a 5-second deadline and respects the caller's cancellation,
including a Child's enclosing tool deadline. The first preview failure disables
further previews for this HTTP request, while text state and successful writes
remain intact. Failed renders never fall back to an older image. Only a fixed
error category and elapsed time are logged; caller cancellation does not warn.
Cancellation before the preview deadline clears the pending cache without
disabling previews for subsequent callers in the same HTTP request.
The service's per-task execution mode refuses previews; use a mode supporting
its existing `/preview` endpoint.

The image and text describe the same read snapshot, labeled with its `lastSeq`.
An external write during rendering can make it older than the live board; no
locks or queues are added. The screenshot represents the logical board, not
live browser animation or panel visibility. It does not guarantee that the
model will recognize or correct an error. Director compaction continues to
budget the transient tail with Pi's estimator, including its image estimate;
this is not a measurement of provider billing.

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
