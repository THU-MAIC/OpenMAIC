# Shared sandbox provider — experimental

The first adapter implements the **E2B-compatible** protocol. The opt-in host integration
reuses OpenMAIC owner identity, PostgreSQL and Agent sessions for files, commands, PTY,
checkpoints and isolated HTTP/WebSocket previews. Templates, endpoints, accounts and
compute tiers are deployment configuration. PBL teaching stages and course content are
separate consumers of this foundation.

`pause` and `desktopStream` are false capability flags; `paused` is a known state only.
This milestone does not implement pause/resume operations or a desktop-stream API.
Desktop screenshot/input primitives remain optional. A workspace page is a foundation
integration surface, not the completed PBL v3 course UI.

## Boundary

- `lib/sandbox/`: provider-neutral types and safe errors.
- `lib/server/sandbox/`: configuration, provider, owner authorization, storage, opt-in agent tools.
- `lib/persistence/sandbox-environments.ts`: lazy, versioned PostgreSQL tables.
- `app/api/sandbox/`: thin owner-aware Node route handlers.
- `components/sandbox/`: reusable project editor, command results and ANSI terminal.
- `app/project-workspace/[workspaceId]/`: opt-in host surface using those components.
- `app/sandbox-lab/`: low-level developer tools including optional desktop actions.
- `scripts/sandbox-preview-gateway.mjs`: optional isolated HTTP/WS transport.

Uses the existing PostgreSQL, owner identity and Agent runtime. No additional scheduler,
queue, model configuration tree or course DSL. Browser preview adds one small stateless
Node HTTP/WS gateway on a separate browser site; deployments that omit preview do not
need that process. A small per-command Python supervisor runs **inside**
the sandbox; runtime templates must include Python 3 and a POSIX shell even when the
learner's project uses another language. This is an adapter requirement, not a language
restriction in the shared provider contract.

A `workspaceId` is an opaque owner-scoped key. It does not convey teaching semantics or
allow attachment of an arbitrary provider resource. Templates contain language tools:
Java/Maven projects, Python exercises and other course content remain consumers.

## PBL workspace lifecycle

PBL uses one inactivity interval: `OPENMAIC_PBL_IDLE_TIMEOUT_MS` (default **1800000**, 30
minutes; allowed 60000–86400000). It counts from the learner's last real input in any tab.
Queued/running Agent work keeps the environment leased beyond it; once that work reaches a
terminal status (`succeeded`, `failed` or `cancelled`), the next pass releases without
another interval. This is independent of the provider's renewable `sandbox.lifetimeMs` lease;
keep the cloud lease at least five minutes for normal hosted use. The application runs a
30-second reconciliation schedule from `instrumentation.ts`. Replicas share the existing
study/environment locks, and application restart does not reset durable usage timestamps.
Inactivity and grace comparisons use PostgreSQL's clock. Maintenance claims the least
recently checked environments in durable batches of 100; failed or busy attempts also
advance the scan, so later environments are not starved by a fixed first batch.

Short configured leases remain valid. Before a PBL source snapshot and before a generic
workspace archive, the service renews for at least **180000 ms**: the shared 120-second
checkpoint deadline plus 60 seconds of margin, or the configured lease if longer. Ordinary
provider renewals preserve any longer remaining lease, so a concurrent short renewal cannot
remove that protection. Renewal honors the checkpoint signal; an expired or failed renewal
starts no snapshot/export or checkpoint commit. The existing failure-grace/discard paths
still release without requesting a new checkpoint lease.

Study-lock admission is shared by all stores using the same PostgreSQL pool. Maintenance
leaves one admission slot for interactive work when the pool supports multiple slots: the
default ten-connection pool admits two study operations, of which maintenance may occupy
one. The two scan workers still traverse other studies while an archive is slow. Deferred
studies within the idle timeout plus failure grace, a command within its execution deadline,
or a command/Agent completion within the idle timeout receive only a lightweight lease
renewal until the deferred checkpoint/release obtains admission, so unarchived turn output
survives congestion; completion never moves the learner inactivity clock. Checkpoint,
collection and release still require admission. Older idle/overdue-only studies, expired
failure grace and durable discard intent do not gain extra retention through this path.
A deferred archive is retried on a later scan. Injected pools with only one study slot retain
single-operation behavior; periodic publication reuses its capture admission slot.

The ten-minute idle default balances reading time and cost. Operators who choose five
minutes should treat it as a cost-leaning setting: static reading/thinking and consulting
documentation in a hidden tab do not renew activity. Only entry/visibility return and the
trusted interactions below count; returning after release can require allocation/restore.
If archival repeatedly fails, changes newer than the last checkpoint can be lost after
the additional failure grace, as described below.

The active PBL scene reports coalesced trusted pointer, keyboard and wheel input inside
the project frame at most once every 30 seconds. Entry and visibility return also mark
activity. The provider stays above scene rendering, while input capture belongs to the project frame
(including its React portals). Classroom navigation controls do not restore idle compute.
The first input after a reporting gap sends immediately; later input is coalesced within
the 30-second interval. The existing heartbeat flushes pending input and retries failed
batches, but never sends an empty batch. No additional activity timer is required.
Ordinary view polling and automatic scrolling do not count. Switching scenes or leaving
a course stops that scene's activity reports; another tab can still update the same study.
No unload callback or tab counter is required. A long static reading period can reach
inactivity; subsequent input restores the
workspace automatically. Returning to a completed project's report does not allocate compute;
its explicit restore control opens the project files when wanted.
After a preparation failure, further typing/scrolling does not automatically retry it;
the learner uses the explicit setup retry control, preserving any draft input.

Healthy queued/running teaching turns have no lifecycle age cutoff and keep the environment
leased past learner inactivity; inactivity never cancels or fails them. The independent
execution watchdog (`lib/server/pbl-v3/execution-lifecycle.md`) fails a turn after 15 minutes
without execution progress. Agent, build and command completion ends protection but never
starts a fresh inactivity interval, so a learner idle for 30 minutes is released at the first
pass after the turn becomes `succeeded`, `failed` or `cancelled`. Builds and assessments are
collected through the same verdict path as browser collection, even with no browser open;
automatic browser collection is not learner activity either. Release and replacement
preparation never rewrite Agent session status, so failed or cancelled turns stay retryable.
Real input clears a pending failure cycle; durable discard intent remains irreversible.
Activity reporting does not wait for the Study advisory lock held by a long teaching tool.
After a safe checkpoint, a short transaction checks that no learner returned and commits
normal release intent (`idle_turn_cleanup.releasing`). Checkpoint success alone never erases
it. Once release is committed, returning input completes deletion/recovery rather than
reversing it; deletion contention cannot restart renewal. Earlier return during archive
I/O cancels release, including the archive-failure path.

The rules below apply to an explicit release deadline recorded in `idle_turn_cleanup` by
earlier versions, which inactivity no longer creates.

At cleanup expiry, no maintenance path renews the binding. A still-running unacknowledged
turn is durably cancelled and its lease revoked before recording discard intent and trying
destruction. Each runner claim has a distinct lease identity; the scanner excludes locally
executing sessions, so a reset retry cannot reauthorize a late old worker. Queued-only or
acknowledged work follows normal writer cleanup and checkpointing; a checkpoint after expiry
uses only the remaining lease. Failure or uncertain writers fall back to the previous
checkpoint and loss notice. Database failure prevents intentional destruction; uncertain
provider deletion is retried, with the remaining provider lease as the final compute bound.

Explicit cancellation, actual provider failures and worker lease/orphan recovery remain
available. The companion teaching execution-policy changes in PR #2003 remove the runner's
inherited V3 duration/output/tool limits; this lifecycle policy bounds only learner inactivity.
A live worker heartbeat does not establish upstream request health, and silence alone does
not establish failure. Inactivity cleanup is intentional cancellation, not a model timeout.
Commands still active/unknown after 330 seconds are requested to cancel through
their existing operation ID. An unknown outcome is never assumed to have stopped writing.
If all unresolved commands remain overdue after cancellation, idle maintenance uses the
same finite failure grace. On expiry it records an interrupted-work loss notice and
destroys the environment without taking a potentially inconsistent archive. Confirmation
that commands have stopped clears this failure and starts normal post-task inactivity.

Execution-result collection failures also use the finite idle failure grace; repeated
collection errors cannot renew an idle workspace forever. A missing command reservation or
a permanent source snapshot limit interrupts the pending build/assessment and invalidates
its evidence so the learner can repair and retry. Lost start acknowledgements with an
existing command reservation remain uncertain until observed or cancelled; an interruption
does not count as learner activity or a passing assessment.

Idle reclamation closes leftover workbench terminals through the existing terminal cleanup
path before archiving, including ordinary background processes in the terminal session.
Recent learner activity and work protected by its execution/cleanup interval prevent reclamation.
Uncertain terminal discovery or failed closure records an execution-unsettled failure at
the terminal stage, using the same idle failure grace; retries never restart that deadline.
If closure cannot be confirmed before expiry, release without a new archive under the
existing durable discard/loss policy. Terminal closure itself does not count as activity.

File invalidation marks the workspace dirty before the remote write. In addition to teaching
checkpoints, dirty work is checkpointed after 60 seconds when no managed writer is active.
Periodic capture/upload holds a separate checkpoint lock while study and file operations
remain available. Publication briefly locks the study/environment and validates the same
revision, dirty generation, environment and writer reservations. Checkpoint head and study
recovery metadata publish in one PostgreSQL transaction. Concurrent edits or work discard
the pending upload without replacing the previous checkpoint or clearing dirty state.
This limits the normal between-stage recovery window; a long running writer or unavailable
storage can extend it. Unexpected provider expiry or application/storage failure can lose
changes since the last successful checkpoint. Local browser drafts are not durable backups.

Intentional reclamation collects outcomes, quiesces writers, commits a checkpoint and its
study recovery position, then destroys the resource. It preserves the logical study and
recovers into a new physical environment through the existing allocation identity path.
Interrupted allocations/restores and uncertain deletes are reconciled under their original
IDs. Passive polling never recreates an idle environment. Project mutations retry while
reclamation holds the Study lock. Activity control can stop an uncommitted release; after
durable release intent, return completes deletion and restoration under the original IDs.

Checkpoint failures record a safe reason, stage and first idle failure timestamp. Transient
failures retry on the next pass; deterministic size/file/quota/configuration failures wait
for user activity or an explicit retry instead of repeatedly exporting unchanged files.
`OPENMAIC_PBL_ARCHIVE_FAILURE_GRACE_MS` is optional, read at runtime, defaults to **300000**
and accepts 60000–86400000. For archive failures it starts on the first failed **idle
reclamation**, not a periodic dirty checkpoint. The same setting bounds departed-turn
cleanup starting at the learner inactivity deadline. Retries and polling never extend a
started cycle. Real learner activity clears a pending failure cycle. Agent, build and
command completion only ends protection; it never starts a fresh inactivity interval.
Both the idle timeout and archive failure grace are validated during fatal boot checks,
before background workers start; malformed settings refuse startup.

After that grace, maintenance stops renewing and records release-without-archive intent
before deletion. The previous successful checkpoint remains intact; the UI shows its
timestamp and warns that newer work may be lost. With no checkpoint, recovery uses starter
files. Existing recovery invalidates approvals/tests for unavailable versions. A durable
discard intent fences old-environment writes even if deletion fails; return/retry completes
deletion under the original ID before preparing a replacement. If metadata cannot be
persisted, no intentional destructive release occurs; the remaining provider lease is the
compute bound. Maintenance checks database writability before renewing.

Checkpoint I/O shares a 120-second total deadline, including source enumeration, source
copy/download, provider connections, archive generation/download and chunk upload. Source
reads and enumeration pass cancellation through the service/provider boundary; read-only
I/O races also bound callers of adapters that ignore it. A late source result cannot start
another read, archive or checkpoint commit. Source downloads keep their local 30-second
bound even with a longer Agent-turn signal. A pre-expired deadline starts no source or
archive I/O. Temporary transfer
cleanup is best effort with its own short I/O bound and cannot extend the caller's lock
beyond the shared deadline. Cancellation bounds caller waiting; it does not confirm that
a remote archive process has stopped. Built-in S3 uploads receive its cancellation signal;
custom byte adapters should honor the optional write signal. Even an adapter ignoring
cancellation cannot commit a late checkpoint head; uncertain chunks remain pending for the
existing collector.
Logs contain safe reason/stage and study/environment IDs, never raw provider errors.
Do not disable/change provider or storage configuration until outstanding environments are
drained. The provider lease remains the final compute bound if application workers disappear;
it cannot itself guarantee archival before expiry.

The pre-change sequential baseline is recorded in `eval/sandbox-lifecycle/baseline-2026-10-23.json`.
It uses a small two-milestone Python project, real cloud compute and local S3-compatible
checkpoint storage; it is not a production object-storage or concurrency capacity result.

## Server configuration

Configure the installation's `sandbox` section in `openmaic.yml` (see
`openmaic.example.yml`). An absent section defaults to disabled. Set `enabled: true`,
the connection/account ID, code template, and `apiKey: ${SANDBOX_API_KEY}`. The official
cloud supplies the default API URL and runtime domain; compatible services must specify
both. `desktopTemplate`, `lifetimeMs`, `maxActive` and `maxActivePerOwner` use the same
names in YAML and web settings. Missing referenced variables, malformed values and invalid
limits stop startup with the exact configuration location, without echoing secrets.

**Settings → Sandbox** is available only to the explicit personal-installation owner or
a host-verified user/service with the existing `admin` role. Ordinary learners cannot
read or edit it. The separate `sandbox:use` permission is required to operate a sandbox.
No separate settings-UI opt-in is needed. These rules apply equally to a hosted installation
and a local deployment; the page never changes a learner's personal model settings.

The deployment provides defaults. Saving web settings keeps only values that differ from
those defaults; setting a field back to its deployment value restores its inheritance without
resetting other fields. Changes take effect on subsequent requests. `lock: [sandbox]` or `lock: all` makes the page
read-only and runtime uses deployment values exclusively, ignoring saved overrides and
keys. An absent, locked section keeps sandboxes disabled. Unlocking restores saved overrides;
**Reset to deployment configuration** removes them while preserving the revision fence.

Installation overrides use one PG row and revision-checked writes. Explicit web keys use
the existing instance-secret sealing mechanism and are never returned to the browser.
Keep `OPENMAIC_SECRET_KEY` stable across restarts and replicas. An empty key field preserves
the current key; a deployment key is inherited, not copied into PG, so deployment key
rotation still works. A web key stays pinned to its account and endpoint. Changing that
connection requires a new key. An unreadable saved key never falls back to deployment secrets.

Saving does not allocate a sandbox or prove connectivity. Preview and checkpoint indicators
check configuration, not network health. DNS, HTTPS, storage credentials and agent-runtime
flags remain deployment concerns. The acceptance workspace can verify execution.

Release or reconcile **all** outstanding environments before saving or resetting settings,
including expired-but-unreconciled and uncertain resources until their state is `destroyed`.
Settings writes and allocation share the PG capacity lock; stale forms and stale creation
requests fail with 409. Before changing YAML, locks or connection/storage environment values,
drain resources and restart all replicas with the same deployment configuration. These
file changes are not live web writes and cannot participate in the database guard.

When no YAML file exists, the following legacy variables translate into the same deployment
shape at startup. A YAML file is authoritative even when it omits `sandbox`. Settings use
schema migration 8; no extra database migration is needed for this configuration layering.

```dotenv
OPENMAIC_SANDBOX_PROVIDER=e2b-compatible
OPENMAIC_SANDBOX_CONNECTION_ID=my-installation
OPENMAIC_SANDBOX_API_URL=https://api.e2b.dev
OPENMAIC_SANDBOX_DOMAIN=e2b.app
OPENMAIC_SANDBOX_API_KEY=<team API key>
OPENMAIC_SANDBOX_TEMPLATE=<code template ID>
OPENMAIC_SANDBOX_DESKTOP_TEMPLATE=<optional desktop template ID>
OPENMAIC_SANDBOX_LIFETIME_MS=300000
OPENMAIC_SANDBOX_MAX_ACTIVE_PER_OWNER=1
OPENMAIC_SANDBOX_MAX_ACTIVE=5
OPENMAIC_SANDBOX_LAB=false
```

The official cloud defaults to `https://api.e2b.dev` / `e2b.app`. A custom domain requires
an explicit HTTPS `sandbox.apiUrl` (legacy: `OPENMAIC_SANDBOX_API_URL`); it is not derived from the domain. Standalone SDK examples use
`E2B_API_KEY`, `E2B_API_URL`, `E2B_DOMAIN`; those alone do not enable this host feature.
The Team is selected by the key. There is no Team ID in the adapter's create calls.

`CONNECTION_ID` identifies the deployment/account; keep it stable for same-account key
rotation. Binding fingerprints include this ID, API URL, domain and both templates. **Drain live
resources before changing any of them**; mismatching configurations refuse operations
on old bindings. Template changes currently also prevent retrieval of old cached command
results until the original configuration is restored.

Both `secure: true` and `network.allowPublicTraffic: false` are explicit. File, command
and desktop access first check operation metadata and private ingress. Browser-facing OpenMAIC APIs serialize neither management keys, SDK resource IDs nor
traffic tokens. The adapter does not place management keys in the sandbox environment. Ambient `E2B_SANDBOX_URL` / `E2B_ACCESS_TOKEN` are refused. Versions are pinned:
`e2b@2.31.0`, `@e2b/desktop@2.3.1`.

### Authorization and limits

Allowed callers:

1. Explicit `OWNER_SINGLE_USER` owner in a loopback/private or access-code-protected installation.
2. Host-authenticated `user`/`service`, assurance `verified`, with `sandbox:use`.

Anonymous/shared owners cannot allocate resources. Existing agents receive no extra roles.
The server must supply the principal, never trust an owner ID sent by the model/client.

A shared PG advisory lock enforces the installation-wide allocation limit across owners;
owner/workspace limits are enforced in the same reservation transaction. `unknown`,
`creating`, `missing` and `destroying` records continue consuming quota until absence is
confirmed for an already-bound resource. On a capacity rejection, a create request checks
at most five oldest bindings in the current provider configuration, then retries the PG
reservation once. Provider errors and unresolved creations never free quota. This pass
only updates metadata; it does not kill another owner's live sandbox. **This is not a
Team-wide cap:** another installation, direct SDK script or console can allocate outside it.

All creates have a finite timeout, default 300 seconds, allowed 60–3600 seconds. Reconnect
uses the observed remaining lease with a safety margin; it does not
request additional time beyond the observed expiry. Only explicit `renew` requests extend it; no keepalive or automatic resume.
Do not leave applications running unattended or rely on this limit as a billing ledger.

## HTTP API

All calls require `X-OpenMAIC-Sandbox: 1`. Mutations also require JSON content type and
same-origin browser context. Responses are no-store; foreign IDs return 404. Raw SDK
errors, signed URLs and credentials are not returned.

| Method | Path | Behavior |
| --- | --- | --- |
| GET / PUT | `/api/sandbox/settings` | Installation-admin configuration; write-only API key, revision-checked save |
| GET | `/api/sandbox/capabilities` | Configured runtime profiles and implemented feature flags |
| GET / POST | `/api/sandbox/environments` | List / create `{requestId, workspaceId, profile?: "code" \| "desktop"}` |
| GET | `/api/sandbox/environments/:id` | Stored state only |
| POST | `/api/sandbox/environments/:id` | `{action: "reconcile"}` contacts provider; `renew` explicitly extends the lease |
| DELETE | `/api/sandbox/environments/:id` | Release environment and its temporary files |
| GET | `…/:id/files?path=<project-relative path>` | UTF-8 read, max 1 MiB |
| PUT | `…/:id/files` | `{path, text}`, max 1 MiB decoded |
| GET / POST | `…/:id/commands` | List / start `{requestId, command, cwd?, timeoutMs?}` |
| GET / DELETE | `…/:id/commands/:commandId` | Collect status/output / request cancellation |
| GET / POST | `…/:id/terminals` | List / create `{requestId, cols?, rows?}` |
| GET | `…/:id/terminals/:terminalId` | Reconcile terminal process |
| POST | `…/:id/terminals/:terminalId` | `{action: "input", data}` or `{action: "resize", cols, rows}` |
| DELETE | `…/:id/terminals/:terminalId` | Close terminal and ordinary processes in its POSIX session |
| GET | `…/:id/terminals/:terminalId/events` | SSE: `ready`, base64 `output`, `exit`, `disconnected` |
| GET / POST | `…/:id/desktop` | PNG screenshot as base64 / mouse or keyboard action |

Desktop actions: `{type: "move" | "click", x, y}`, `{type: "write", text}`,
`{type: "press", keys: ["CTRL", "a"]}`. Desktop profile is required. Screenshots are
bounded to 4 MiB; this is not a streaming desktop viewer.

`success: true` means the request was handled; inspect `data.state`. `creating`/`unknown`
are not usable environments. Capabilities describe this configured adapter, not a promise
that an arbitrary template contains every language tool.

### Lifecycle and retries

Commit the reservation before sending one create request. Its stable UUID and connection
metadata identify the cloud resource. Retry with the **same** UUID. A different workspace
or runtime profile under that UUID conflicts; a destroyed UUID is never reused.

Provider exceptions retain `unknown`; no automatic replacement. Reconciliation adopts
exactly one metadata match. Zero results are not proof that a timed-out create failed;
multiple matches require operator investigation. Network calls hold no SQL transaction; mutating environment operations share a session advisory lock.
Conditional updates prevent late replies resurrecting a destroyed environment.
Session-lock admission uses at most half of the shared PG pool; excess operations return
retryable `429 SANDBOX_BUSY`, leaving SQL connections available for the locked operations.
After provider-confirmed expiry of a known resource, reconcile marks it destroyed and
retains its last checkpoint. In the workspace, use Reconnect, then Open / restore project
to allocate a new instance and recover that checkpoint. An empty discovery list for an
unknown create still does not authorize replacement.

DELETE records `destroying` before cloud deletion. Repeat DELETE after uncertainty.
If an unresolved creation has no known resource, operator investigation is still required;
there is no automatic forget/recreate escape hatch. The demo's Reconcile and Release
buttons expose the normal recovery path; they cannot repair every unknown allocation.

### Commands

A command is detached from the HTTP/agent connection. One caller-supplied UUID binds its
input fingerprint. Reusing it with different input conflicts; matching retries never start
another command. The remote supervisor uses an exclusive receipt file and writes atomic
status snapshots. Python 3 and POSIX process groups are required in the runtime template.

Combined stdout/stderr is limited to 256 KiB with a truncation flag. Nonzero exit is reported
as `exited` plus its exit code; `timed_out` and `cancelled` remain distinct. At most 16
unresolved commands per environment. Polling collects final results into PG; **results not
collected before expiry may be lost**. The list endpoint helps reconnect callers find IDs.

Cancellation kills the command's ordinary process group. Terminal close additionally kills
background jobs in that PTY's POSIX session. Deliberately detached sessions are outside
those process scopes; releasing the sandbox is the definitive environment cleanup.
Sandbox-writable receipts and output are untrusted, not authoritative grading evidence.

### PTY

One active or unresolved terminal per environment. Input ≤16 KiB; size ≤400×200.
After a failed creation, use **Close shell** to reconcile and retire the reservation.
The close action shares the environment lock with creation. It closes a discovered PTY,
or retires the reservation when the sandbox process lookup succeeds with no match.
Failed or ambiguous discovery retains the reservation; ordinary status reads do not
discard an unknown allocation. The workspace keeps unresolved terminals visible after refresh.
SSE disconnection, slow clients or the 110-second stream deadline detach the reader, not
the terminal. Reconnect to resume **new** output; offline output replay is not implemented.
The project component uses xterm with bounded input/output queues; the lab remains a line console. Reverse proxies must disable
stream buffering and permit the stream duration. PTY uses SSE plus authenticated input requests. Application WebSockets use the preview gateway.

### Agent tools

The existing durable Agent runtime must also be enabled with
`OPENMAIC_AGENT_RUNTIME_ENABLED=true` and a database. To use the existing workbench UI,
set its `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true` build flag and the deployment's pi chat
flag as documented in `.env.example`, then rebuild. Sandbox configuration alone does not
enable those pre-existing OpenMAIC features.


`buildSandboxTools` accepts a host-selected `sessionId`, `environmentId`, and current
principal resolver. The model cannot choose another environment or owner. Default tools
are read-only; the host must explicitly grant writes and/or shell execution. Shell grants
imply access to the entire sandbox filesystem; they are not a teaching-policy boundary.

The factory supplies file read/write and command start/status/cancel. Tool call IDs map
stably to command IDs within the host session, avoiding double execution on replay.
File reads are paged; model-visible output is capped and marked untrusted. Cancellation of
an agent turn does not cancel already-started commands. The existing Agent runner adds these tools only to sessions with an explicit owner grant.
`POST …/:id/agent-session` takes `{sessionId, allowWrites, allowCommands}`. The service
checks session ownership and a running environment, then stores a one-hour delegation.
Tools appear on the next agent turn; every invocation rechecks the same grant version,
current session owner, expiry and environment. `DELETE` with `{sessionId}` revokes it.
Changing a grant invalidates tools from an already-running turn. A background owner ID
is never treated as a verified request principal. Already-started commands require
separate cancellation. No creation/deletion tools or grant to ordinary sessions is implied.

## Project checkpoints

The stable, owner-scoped `workspaceId` survives environment IDs. Files live under
`/home/user/project`; file APIs refuse traversal and follow no filesystem links. Shell
access is a separate broader permission inside the sandbox.

- `GET …/:id/workspace`: file list and latest checkpoint metadata.
- `POST …/:id/workspace`: `{action: "save" | "save-and-release", expectedRevision}`.
  Revision is 0 for the first checkpoint. A stale revision conflicts rather than replacing
  someone else's saved project. Stop managed commands and close terminals first.
- New and discovered environments remain unavailable until idempotent project-directory
  initialization finishes; existing files are preserved. Creation/reconciliation then restores
  an existing checkpoint automatically. A failed restore
  leaves `workspaceReady:false`, blocking file, command, PTY and preview access. Explicit
  `{action:"restore"}` retries the same checkpoint; it never overlays an edited workspace.
- `GET /api/sandbox/workspaces`: saved project metadata, including after release.
- `DELETE /api/sandbox/workspaces`: `{workspaceId,revision}` permanently removes a checkpoint;
  allowed only after all its environments are released.

Checkpoints contain files in host-configured paths, not process memory, installed system
packages, or a transactionally consistent live database. The default root is
`/home/user/project`, excluding `node_modules`, `.next`, `target`, `__pycache__` and `.venv`.
`OPENMAIC_SANDBOX_CHECKPOINT_PATHS` can add disjoint application configuration/data
directories under `/home/user`, each with a stable name and its own exclusion list:

```dotenv
OPENMAIC_SANDBOX_CHECKPOINT_PATHS=[{"name":"app","path":"/home/user/.config/my-app","excludes":[]}]
OPENMAIC_SANDBOX_CHECKPOINT_MAX_BYTES=268435456
OPENMAIC_SANDBOX_CHECKPOINT_MAX_FILES=100000
OPENMAIC_SANDBOX_CHECKPOINT_OWNER_BYTES=2147483648
OPENMAIC_SANDBOX_CHECKPOINT_PREFIX=sandbox-checkpoints/v1/
```

The defaults are 256 MiB of source data, 100,000 entries and 2 GiB of retained storage
per owner. Hosts can configure up to 8 GiB source data; select limits for the storage
backend, runtime disk, bandwidth and finite sandbox lease. Archive overhead is separately
bounded. The host transfers 8 MiB chunks instead of buffering a complete project in RAM.
The runtime temporarily needs space for the archive and staged restored files. Saving a
large dataset can exceed the 120-second operation deadline; this is not a promise that an
8 GiB upload finishes within a five-minute sandbox lease.

### Storage, retention and recovery

- Reuse the configured external asset **byte adapter**, through its optional
  `withPrefix(prefix)` method. Built-in S3 supports it. A host OSS/local-filesystem adapter
  must implement real namespace isolation before it enables checkpoint saving. The PG
  course-asset fallback does **not** enable new checkpoint saves.
- Optionally set `OPENMAIC_SANDBOX_CHECKPOINT_S3_BUCKET` to a dedicated bucket, using the
  same built-in S3 adapter and standard AWS SDK credentials/endpoint configuration. This
  does not change the course asset backend. Otherwise the existing external asset backend
  is reused, with checkpoint objects under their own prefix.
- PG stores ownership, the current revision, checksums, paths and object/chunk metadata.
  New writes never put file contents in PG or register them as course assets. Each upload
  has a unique object namespace; no reference counting across checkpoints is required.
- Record each chunk key before uploading. Commit the new current version only after all
  writes succeed. Export, upload, quota or revision failures preserve the previous version
  and do not release the sandbox. A lost commit response is resolved by refreshing the
  current revision; it never blindly overwrites it.
- Retain one current checkpoint per project. Replacement/deletion retires the old object.
  A **separate checkpoint collector** runs every 15 minutes while the sandbox feature is
  configured. It collects retired objects after one hour and abandoned uploads after 24
  hours. Active upload locks and current references prevent collection. Failed object
  deletion retains metadata for retry. Owner quota includes pending and retired bytes
  until collection, so failures cannot grow storage without a ceiling.
- Course collection remains unchanged and sees neither checkpoint metadata nor its keys.
  Do not configure bucket lifecycle deletion on live checkpoint objects. Back up both PG
  metadata and the object store; restoring only one is insufficient.
- Restore verifies chunk and archive checksums, extracts validated regular files into
  staging directories, then replaces selected roots. Symlinks, hardlinks, devices,
  traversal and overlapping roots are refused. An unrelated nonempty project root is
  never overwritten; explicitly configured application roots may replace template defaults.
  Multi-root replacement is not filesystem-atomic. The host keeps `workspaceReady:false`
  until restoration and re-export verification finish; retries can complete partial work.
- Keep path configuration stable for saved projects. Changing it requires an explicit
  migration; an incompatible restore is refused. Template dependency lockfiles rebuild
  excluded caches. Application credentials in configured paths receive the same private
  storage treatment as project files; a restored local login is still subject to the
  application's remote session validity.
- PG byte checkpoints from intermediate development versions are unsupported. Migration 9
  removes the blob column; it refuses to proceed if an old development-only record remains,
  rather than silently deleting it. Applied migrations retain their checksums.
- Before allocating a replacement for a saved project, check its path policy, external storage
  configuration and the readability/checksum of its first chunk (at most 8 MiB). A failure
  allocates no cloud resource. Full chunk/archive verification still runs during restoration;
  storage can fail later, so an incomplete restore remains blocked and can be retried or released.

No automatic saver or expiry grace period is provided: changes after the latest explicit
checkpoint are lost at expiry. File listing/editing limits are independent of backup size
(4096 listed files and 1 MiB per text edit). Stop all writers before saving; live application
DBs need their own flush/backup procedure. These are file checkpoints, not live DB snapshots.

## Isolated browser preview

Configure the origins and gateway key in `.env.example`. Start `pnpm sandbox:preview`
next to the app. The standalone deployment must package the gateway script separately;
it is not part of Next's standalone entry point. Reverse-proxy wildcard preview DNS/TLS
to that listener, preserve Host/Upgrade and disable buffering. App and preview must use
**different registrable domains**, not sibling subdomains sharing a parent cookie scope.
For Chromium-based local development use `http://localhost:3200` and
`http://{id}.localhost:3201`. These are still cross-site: preview authorization
uses a host-only `HttpOnly; SameSite=None; Secure; Partitioned` cookie, including
on loopback. `SameSite=Lax` cannot authorize the embedded frame. Chromium accepts
Secure cookies on trustworthy localhost origins; browsers that do not (including
Safari over plain HTTP) require local HTTPS. Public deployments always require HTTPS.
Partitioning isolates the authorization cookie by top-level site and supports
embedding when ordinary third-party cookies are blocked. The new-tab link runs its
own ticket exchange; it does not rely on sharing the iframe's cookie partition.
Browsers that block this storage still need the new-tab fallback. Do not disable
browser protections or move untrusted project pages onto the application's site.

Browser acceptance must include actual iframe display and interaction, CSS/JS,
same-origin requests, WebSockets, new-tab access and revocation. SDK/HTTP clients
that manually replay Set-Cookie do not enforce browser cookie rules and cannot
establish embedded-preview correctness.

`POST …/:id/preview {port}` issues a five-minute, owner/environment/port-bound signed
URL on an origin unique to that environment/port and revocation epoch. Renewed access
keeps application cookies/storage; revocation changes the origin. Service-worker registration
is disabled so project code cannot intercept future authorization bootstrap requests. Its fragment is exchanged for an HttpOnly cookie and removed
before project HTML loads. The thin gateway checks OpenMAIC grants and forwards traffic to
the provider's protected native port. **Native is the default**; set
`OPENMAIC_SANDBOX_PREVIEW_TRANSPORT=sdk` only for the optional stdin/stdout fallback.

Native transport injects the sandbox-scoped `e2b-traffic-access-token` server-side. The
provider may forward it into the student's HTTP application. This is accepted for a
sandbox wholly owned by that student, who already has arbitrary shell access. Do not put
teacher/admin/service credentials, a higher-privilege Agent, or multiple users' workloads
inside that sandbox. Reassess native ingress if this trust boundary changes. OpenMAIC
revocation blocks the gateway grant; it does not rotate the provider's traffic token. A
student-extracted native token can remain usable until provider expiry/deletion.

Project servers must listen on `0.0.0.0` inside the sandbox. Frameworks with host
validation (for example Vite) must allow the configured provider ingress hostname:
the native transport uses that hostname in the upstream `Host` header. Configure
this in the project's development-server settings; the gateway does not rewrite
student source files or disable framework host checks.

Ports 1024–65535 are allowed except runtime control port 49983. Machine-authenticated
`/api/sandbox/preview/resolve` provides the gateway's transport descriptor and scoped
token; it is not returned by the browser API. The gateway does not hold a Team management
key or database connection. Separate browser-site isolation, wildcard routing and HTTPS
are still required for untrusted project HTML. Deployments without preview configuration
report it unavailable; files, commands and checkpoints continue working.

The gateway filters transport/control headers, restricts redirects to the selected target,
removes upstream cookie Domain attributes, and preserves a student's own application
Authorization header. Every new HTTP request and WebSocket upgrade revalidates authorization against the host; there is no authorization cache.
Native HTML responses with a bare `Content-Disposition: attachment` are rendered inline
on this isolated site so ingress download policy does not break navigation. Named
downloads and non-HTML attachments remain unchanged (a bare HTML attachment from the
student app is indistinguishable from ingress and is also rendered inline). Existing
connections recheck every five seconds; a failed check closes the stream (lookup deadline
30 seconds). HTTP streams have a two-minute ceiling and WebSockets a one-minute ceiling;
clients reconnect through authorization. `DELETE …/:id/preview` revokes gateway grants.
A shared preview URL delegates access until expiry/revocation.

The optional SDK fallback opens one Python TCP relay per connection inside the sandbox.
It adds runtime/SDK hops and requires request buffering disabled on
`/api/sandbox/preview/tunnel`. Only this HMAC-authenticated route bypasses middleware.
Relays are bounded to 16 MiB output, 17 MiB input and 120 seconds, with eight connections
per environment / 32 per host process; capacity exhaustion answers 429. These are process
limits, not a measured production capacity guarantee. Native transport does not use the
SDK tunnel or these relay processes. Neither mode is a general hosting service.

Some browsers block third-party iframe cookies; the component also supplies a top-level
"Open in new tab" entry. This does not bypass provider authorization. Desktop streaming
is not implemented by the HTTP application preview.

## Acceptance before enabling learners

The integration needs fresh end-to-end acceptance through OpenMAIC: verified-owner
isolation; file/command/PTY interactions; HTTP and WebSocket browser behavior; expiry,
revocation and save/rebuild recovery; denied/failed/uncertain paths; representative
Python, Node, Java and C++ templates. Historical SDK evaluations remain separate evidence.
The default marketplace code image does not guarantee that a course's complete Java/Maven/
frontend dependencies are installed. A reproducible course runtime and course DSL remain
consumer work. Production readiness also requires operator recovery and deployment review.

Run offline regression with `pnpm exec vitest run tests/sandbox tests/agent-runtime tests/model-settings tests/server/middleware-access-token.test.ts`.
The real-host suite is skipped by default. `RUN_SANDBOX_HOST_ACCEPTANCE=1 pnpm exec vitest run tests/sandbox/real-host.acceptance.test.ts --maxWorkers=1` explicitly creates billed resources using `.env.local` and a real isolated PG.
Local PostgreSQL checkpoint fault/collection acceptance runs with
`PG_CONTRACT_URL=<isolated-test-database> pnpm exec vitest run tests/sandbox/checkpoint-storage.pg.test.ts tests/sandbox/store-lock.pg.test.ts`.
It creates and drops its own schema, with an in-memory object-store double. Real S3/cloud/
browser evidence is separate and must name its exact source revision and deployment.
Do not run paid suites concurrently or against production data. Raw evaluations belong in
an independent evaluation branch, not in the product diff or public contribution.

For Agent acceptance, configure a supported chat model in the existing model settings'
`agent` slot. A usable ordinary `llm` slot does not establish that the Agent slot is
configured, that its API protocol matches the provider, or that the model still exists.
Acceptance used the existing credentials in local encrypted model settings; no model or
credential is hardcoded into the sandbox implementation.

## Provider configuration references

- [Aliyun E2B compatibility](https://help.aliyun.com/zh/agent-sandbox/user-guide/e2b-compatibility-description)
- [Aliyun network access control](https://help.aliyun.com/zh/agent-sandbox/user-guide/network-access-control)
- [Aliyun OSS volume setup](https://help.aliyun.com/zh/agent-sandbox/user-guide/create-oss-volume)


## Compatibility and configuration examples

The npm SDK is pinned exactly to `e2b@2.31.0` (`@e2b/desktop@2.3.1` for optional
desktop primitives). Some compatible services do not implement the newer v2 create
endpoint; upgrading the SDK requires create/connect and protected-ingress regression
checks against both endpoint configurations. Python evaluation pins (`e2b==2.31.0`,
`e2b-code-interpreter==2.8.1`) are a different ecosystem, not product dependencies.

For Aliyun Agent Sandbox, configure `OPENMAIC_SANDBOX_API_URL=https://api.cn-hangzhou.sandbox.aliyuncs.com`
and `OPENMAIC_SANDBOX_DOMAIN=cn-hangzhou.sandbox.aliyuncs.com`, with that team's key
and template IDs. Economic/default QoS is a team/template choice; the adapter contains
no QoS branching. Use separate connection IDs and credentials for separate accounts.

After configuring the intended account, run the paid, opt-in compatibility check with
`RUN_SANDBOX_COMPAT_ACCEPTANCE=1 pnpm exec vitest run tests/sandbox/e2b-compatible-cloud.acceptance.test.ts`.
It exercises this adapter (not a separate evaluation SDK wrapper), requires an explicit
lease of at most 300 seconds and fewer than five existing instances, deletes its own
instances in `finally`, and saves a credential-free result in ignored `test-results/sandbox/`.
Run separately for each endpoint. Ordinary CI skips it and makes no cloud requests.

`capabilities.pause` and `capabilities.desktopStream` are false. `paused` is a known
lifecycle state, not an implemented pause/resume operation. No stream-session API or
speculative pause parameters are exported in this milestone. The evaluated desktop template runs as `user` with passwordless sudo; a non-root name alone does not
protect the runtime. Consumers needing an immutable foundation must supply a hardened
template with no sudo and explicitly restricted writable directories.


### Later desktop consumers

A desktop consumer will use the same environment/profile ownership boundary and check
`capabilities.desktopStream`. A future change can define stream authorization and noVNC
integration when its consumer requirements are concrete. This milestone exports no
placeholder stream-session or pause/resume methods. Actual embedded noVNC typing/scroll
latency and hardened non-root/no-sudo application templates remain consumer acceptance work.

### Bounded agent file listing

`sandbox_list_files` accepts `limit` (1–100, default 50) and a numeric `cursor`
(default 0). Responses include `files`, `total`, `truncated` and `nextCursor`,
within 16,000 characters including JSON escaping and the untrusted-output wrapper.
Files are sorted by path. This is a live listing: modifications between pages can
shift offsets. This does not alter the workspace browser's 4,096-file listing limit.

The browser retains the creation request UUID through timeouts/unknown outcomes.
An authoritative `SANDBOX_NOT_FOUND` response clears it so switching accounts in
one browser cannot permanently reuse another owner's operation; the next open retries
with a fresh UUID.

## Integration-only acceptance surfaces

`/sandbox-lab` and `/project-workspace/<id>` are developer acceptance surfaces, not
end-user product features. Keep them on the integration branch for validation and remove
the routes before the final integration-to-main PR. Reusable provider, API and UI components
remain available for feature consumers. Pause/resume and desktop streaming remain deferred.


## Learning-managed workspaces

The `pbl-<study UUID>` namespace is owned by the PBL learning runtime. Generic
sandbox controls cannot mutate those workspaces or issue preview/agent grants;
existing preview tickets are checked again on use. Owner/resource checks still
apply, and normal workspace IDs keep their existing behavior. Only narrow,
server-only scopes established by the teaching runtime allow specific mutations. Ordinary
mutations hold the study lock; periodic checkpoint capture uses a separate checkpoint lock
and validates the study again under its lock before publication. Read/observe, renew, cancel
and close remain available.

See the [PBL workspace contract](../../pbl/v3/README.md#learning-workspace-contract)
for evidence invalidation, source scope, recovery handoff and the dedicated
workbench follow-up. Do not bypass this boundary when adding a new workspace UI.
