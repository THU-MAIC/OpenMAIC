# Learning workbench and recovery

The hosted classroom reuses SandboxService, owner identity, PostgreSQL command
receipts, the command supervisor and PTY. Entry prepares the installed project's
environment automatically and reuses an existing ready sandbox. Failed preparation
has an explicit retry; completed projects can reopen reports without a sandbox.
A passive health update after entry shows recovery rather than automatically
allocating a replacement environment for an idle learner.

One SSE subscription carries learning, workspace and execution state. The browser
uses HTTP only for learner commands, file access and explicit refresh; no periodic
learning/workbench/environment JSON requests remain. The stream reconnects with a
current snapshot and closes when hidden or unmounted. Reconnect and passive server
observation neither submit a learner turn nor renew the sandbox.

## Layout and feedback

The IDE is on the left; conversation, current-step controls and composer are on the
right. Both panels can be resized or hidden. The file tree folds independently using
the left arrow at the right edge of its Project files header. When folded, an
expand control appears at the start of the editor tabs; the current buffer stays mounted. The header panorama lists milestones;
the progress control above the composer lists the current milestone's steps.
Task details open above the composer, with bounded height and internal scrolling.

File tabs select immediately and show a reading indicator while content is fetched.
Read-only Monaco synchronization and switching models are not learner edits. User
edits autosave after 750 ms, one write at a time, with compact saving/saved/error
status. Typing can continue during a save. Receipts acknowledge only submitted text
and advance its observed hash, preserving newer typing. Rejected or stale drafts
remain recoverable, with an explicit retry rather than an unbounded request loop.
Ctrl/Cmd+S flushes pending edits; there is no manual Save or Save checkpoint button.

Network actions acknowledge clicks immediately with their specific pending state:
opening, sending, submitting a decision/quiz, starting tests, entering the next step,
reading and managing files. The
assistant waiting indicator appears before the teaching request returns and while
queued work has not yet produced a conversation entry. Between completed text blocks
or tools, it remains visible until the turn settles; active thinking/tools retain
their existing animated components. Test status starts at request submission and
continues through execution and result collection. Failure ends the animation and
exposes the existing retry control. A pending
decision selection is temporary; failures restore the confirmed selection. Only
server receipts install learning progress, outcomes and file-operation results.

Reports already open their page and generation status before awaiting a response.
Projects with a declared `runtime.application` expose a collapsible application
panel between the IDE and assistant. Launch commands and ports come from the
validated course package, and the isolated gateway uses study-specific grants;
generic sandbox preview access remains separate.

## Editing boundaries

`projectEditAccess` is shared by the editor, workbench permissions and host file-save
admission. Attempting to edit a locked file opens Monaco's existing inline message
next to the cursor with the current localized reason. The message uses the editor's
light/dark theme and dismisses on Escape, blur or cursor movement. No persistent
lock-reason footer consumes editor height. These rules follow the existing OpenPBL stage/writer boundaries:

| Step/state | Student file access |
| --- | --- |
| Teaching and decision discussion | Read-only; file editing opens in planning/coding |
| Planning, assistant idle | PLAN.md only; source remains read-only |
| Coding, assistant idle | Source files; approved PLAN.md remains read-only |
| Formal tests or result collection | Read-only to preserve the tested version |
| Recorded test failure or unreliable evaluation, coder idle and workspace healthy | Source editable in the same test step; chat/build/retest remain available |
| Understanding quiz and reflection | Read-only |
| Assistant queued/running | Read-only until the assistant finishes |
| Build or build-result collection | Read-only until collection finishes |
| Completed, paused or stopped project | Read-only |

The existing stage definitions still determine whether an action is available.
An unreliable evaluation records `evaluation_recovery`, not a confirmed learner
implementation error. The coding assistant receives the same public diagnostics as
the learner and can inspect files or run the public build. Unresolved tooling or
course-fixture problems need platform/course support; recovery never invents a pass
or advances the stage. A failed progress query alone does not mark a successfully
probed workspace unavailable. Uncertain execution still retains the writer lock
until collection confirms it has stopped.
Client-side loading, an in-flight operation, environment readiness and stale buffers
also block editing with distinct explanations. Direct API writes cannot bypass a
pending test/build. Agent file-write and file-management tools obey that evaluation
lock too. Passing tests ends repair access; failure does not move back to a different
stage or skip the existing repair/retest cycle.

Create, rename/move and delete files only inside trusted source directories. Keep
PLAN.md; refuse stale hashes, traversal, symlinks and nonregular files. All changes
invalidate dependent review/test evidence before I/O. Existing guided-review checks
still apply after either a student or Agent changes an artifact.

## Persistence and execution

Autosave writes the current sandbox's files. Existing automatic stage-boundary and
final-completion checkpoints separately preserve recovery snapshots; students do not
manage these snapshots. Preparation restores through the existing durable allocation
identity and reports recovery or progress resets. Durable snapshots require the
configured asset-byte store. No new background worker or snapshot scheduler is added.

Dirty file tabs, unsent chat, quiz choices and panel selection survive scene return
and same-tab refresh in study-scoped browser storage. This browser cache is neither
a sandbox write nor a recovery snapshot. Unavailable browser storage retains scene-
return drafts in memory and warns before leaving. Environment replacement preserves
dirty text and refuses stale saves until explicitly reloaded/discarded. Late file
responses cannot populate another file. No commands, terminal input or permissions
are replayed from browser storage.

`ACTIVITY_SHELL_ENABLED` is fixed to `false` in the v3 workbench. The current hosted
activity hides Terminal, arbitrary command input, shell reconnect and shell Stop
controls. Build output and the normal assessment controls remain available. There
is no new deployment setting. Shared sandbox/PTY services and existing v3 admission,
ownership and Stop fencing remain intact for future general-purpose workbench use.
This visibility flag is not an authorization boundary.

Managed writers must stop before a review snapshot, formal test or recovery snapshot.
An open shell can modify files, including PLAN.md; this is a cooperative learning
facility, not an adversarial-code boundary. Completion refuses a changed approved
plan and stale source evidence. Generic sandbox mutation routes cannot operate on a
learning workspace; the owner-checked v3 workbench and terminal routes own its scope.
Generic preview tickets cannot open managed learning workspaces. Declared project
applications use the dedicated, owner-checked study preview route and gateway.

## Verification and deployment

![Learning workbench with automatic save and explicit editing reasons](screenshots/workbench.png)

The screenshot and Chromium classroom journeys use API fixtures. Deliberately held
responses verify that selection/loading/waiting feedback precedes acknowledgement.
Browser checks cover editable/read-only file switching without saves, stale drafts,
scene navigation, short/narrow viewports, absence of shell controls and report round trips.
Held test-admission and collection responses, queued turns, completed-tool gaps and
text-stream gaps verify continuing animation and its removal on completion/failure.
Real PostgreSQL/local-Python tests cover file admission, evaluation locks, repair,
terminal ownership/Stop fencing, recovery and generic sandbox compatibility.

```sh
PG_CONTRACT_URL=postgres://... pnpm exec vitest run tests/pbl/v3 tests/sandbox --maxWorkers=2
pnpm exec playwright test e2e/tests/pbl-v3-workspace.spec.ts e2e/tests/pbl-v3-conversation.spec.ts
```

Use the [shared sandbox configuration](../../server/sandbox/README.md), PostgreSQL,
model authorization and enabled Agent runtime. The code template needs Python 3 and
POSIX shell; Java projects additionally need their installed JDK/build tools. Keep
credentials and private course materials out of scenes and learner files. Small-
cohort capacity, private curriculum integration and full live learner acceptance
remain separate from local fixtures and contract tests. Existing live-provider
results are recorded in [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md).
