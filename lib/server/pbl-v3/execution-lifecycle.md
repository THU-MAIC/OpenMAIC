# PBL execution and lifecycle contract

The Agent runner owns model-request termination; the independent execution watchdog settles stalled teaching work. Sandbox lifecycle maintenance consumes
persisted session state; learner inactivity, browser SSE connectivity and worker
heartbeats are not evidence of model-request progress or failure.

| Agent session status | Lifecycle meaning |
| --- | --- |
| `queued` | Accepted work awaiting a worker or recovery; protect the environment. |
| `running` | Model/tool work, including waiting for upstream response; protect the environment. |
| `succeeded` | This execution ended; normal learner-inactivity/archive rules apply. Stage completion is a separate teaching receipt. |
| `failed` | Execution ended unsuccessfully; normal learner-inactivity/archive rules apply. Preserve progress and allow retry. |
| `cancelled` | Execution ended after explicit cancellation; normal archive rules apply. |

## Request failures

V3 passes a per-model-request silence guard to `createCallLlmStreamFn`. It uses the
existing `LLM_FETCH_TIMEOUT_MS` window (15 minutes), starts before calling the
provider, and resets on upstream stream parts, including reasoning, text and tool
call data. It is not a total Agent, reasoning, output-length or tool-count limit.
It does not run while a tool is executing. Connect errors, HTTP failures and
provider/gateway deadlines may fail earlier. SOCKS5 retains its existing Undici
300-second transport fallback; no deployed gateway timeout is assumed here.

If the request goes silent, the adapter aborts it, settles its stream even if the
transport ignores abort, keeps partial text/thinking and removes executable tool
calls. Late data cannot execute tools. This means **no upstream feedback within
the window**, not a reliable diagnosis that the remote model crashed. Healthy
but completely silent inference can also exceed this policy window.

The runner persists `status: failed` under the current claim fence, releases its
worker slot and emits `session_end.errorCode`. `AgentSessionMeta.error` carries a
stable prefix readable with `executionFailureCode` from
`lib/agent/runtime/request-failure.ts`; no schema migration is required.

| Code | Meaning |
| --- | --- |
| `MODEL_REQUEST_IDLE_TIMEOUT` | No upstream stream feedback within the request silence window. |
| `MODEL_REQUEST_FAILED` | Model request/stream failed for another reason. |
| `AGENT_EXECUTION_IDLE_TIMEOUT` | No recorded execution progress for 15 minutes, including queued work, setup, tools, crash recovery and settlement. |

`LearningView.roleRun.failureCode` exposes only the safe code. The learner sees
existing timeout/authentication/unavailable feedback and can retry the same real
input. Retry does not fabricate feedback, readiness, artifact approval, test
results or stage completion. A queued retry/new message protects the environment
again. Other failures, such as setup authorization or an incomplete teaching
receipt, still use `failed`; consumers must not require one of these codes to
recognize every terminal failure.

A dead worker is handled by the existing durable lease/reclaim/attempt mechanism.
A local heartbeat proves worker lease ownership, not provider progress. Maintenance
must not turn an old `running` row into failure solely because the learner left.
Reclaim still requires an available worker; neither a live heartbeat nor a
`queued`/`running` status proves that useful work is progressing.

## Integration with sandbox lifecycle

This PR includes the merged #2011 foundation and removes its inactivity-only
Agent cancellation and active-turn renewal cutoff. The default learner idle
window is 15 minutes, configurable via `OPENMAIC_PBL_IDLE_TIMEOUT_MS`. Execution
completion can still start a fresh reading window, as in #2011. Environment
release requires **both** normal inactivity eligibility and no queued/running
Agent. Existing collection, terminal shutdown, checkpoint and writer fences still
apply; `failed` does not authorize destroying a live writer.

Explicit release/discard intent remains irreversible once published: old worker
writes, late checkpoints and stale commands cannot revive that environment. The
archive-failure grace is retained for failed archive/terminal/command cleanup;
it is not a five-minute deadline for healthy Agent work.

The lifecycle owner consumes `agent_sessions.status` / `getSession()` directly;
error codes are optional diagnostics. `queued`/`running` remain protected until a
terminal verdict commits. No additional top-level status is needed. Browser SSE
loss or learner inactivity must not itself fail execution.

## Independent execution watchdog

`execution-watchdog.ts` installs a separate process schedule even if the Agent
runner is disabled or all its slots are occupied. Every 30 seconds it checks at
most 100 eligible teaching bindings. Each pass advances past deferred candidates
within a fixed expiry cutoff, then wraps to revisit them, so a locked first batch
cannot starve later work. Owner fencing and subsequent lock waits both use the
short 250 ms maintenance policy. The durable `execution_progress_at` clock
starts on an admitted learner message, automatic opening or explicit retry.
Worker claims/reclaims, lease heartbeats, SSE heartbeats, maintenance renewals,
status reads and repeated identical tool updates do not reset it.

Nonempty upstream reasoning/text/tool-input data, completed model calls and tool
starts/results or changed progress reports publish progress under the current
worker/attempt fence. Publication is coalesced to at most one write per second;
there is no overall turn duration, output-size or tool-count cap. A silent tool
has the same 15-minute no-feedback fallback as a silent model: this is a policy
for ending unobservable execution, not proof the remote process crashed.

Once the last progress is at least 15 minutes old, the next successful scan:

1. Locks the session without waiting on the study/provider lock, then rechecks
   progress and current status. Healthy progress, a new explicit retry or an
   already terminal state cannot be overwritten.
2. Commits `failed` with `AGENT_EXECUTION_IDLE_TIMEOUT`, clears the worker lease
   and revokes the session grant in the same transaction. An explicit pending
   cancellation retains `cancelled` semantics. If this turn/attempt already has
   a durable `session_end`, reconcile that existing verdict instead of publishing
   a contradictory duplicate. Explicit retry records a control-only admission
   marker, so reused attempt numbers cannot select an earlier turn's terminal.
   Owner status and any new `session_end` publish atomically through the existing
   durable notification path; teaching completion still requires its own receipt.
3. The old worker observes lease loss, aborts its request/tool scope, drops its
   timers/subscriptions and frees its local concurrency slot even when the
   underlying promise ignores abort. Late results cannot commit or erase a newer
   local claim. Retry admits the same real learner input with a fresh clock/grant.
   Every build reservation/result commit rechecks the current teaching lease.
   File writes/file management and new command dispatch recheck the active scope
   after asynchronous admission. A command cancelled before provider dispatch
   leaves a collectable cancelled reservation, rather than an orphan writer.

This covers unclaimed/admission-blocked or over-attempt queues; hung setup/tools
or settlement despite live worker heartbeats; dead workers without a replacement;
and repeated crash/reclaim without actual execution feedback. The existing
attempt verdict may fail repeated crashes earlier; reclaim never extends this
progress clock. Valid learner-input waits are terminal handoffs, not expired work.

The schedule requires a functioning application instance and database. Database
outages/held transactions can delay a verdict; checks retry after recovery. The
15-minute threshold is checked on the scan cadence, not an exact wall-clock SLA.
A committed Agent failure does not prove an already-issued remote command stopped:
normal command collection/cancellation, workspace locking, archive and writer
safety checks still gate environment release. This watchdog never deletes compute.

Actual progress also extends an existing session grant for a healthy long turn.
It never creates a missing/revoked grant, changes its identity/permissions, or
revives a discarded/releasing environment. Progress resolves a retired anonymous
owner through the existing background-write fence after an account claim; lease
and grant checks still require the current owner. This closes the one-hour access gap
without using lease or browser heartbeats as evidence of execution health.

Remaining lifecycle validation and integration:

- Consume persisted terminal state without reinstating the former ten-minute
  cancellation plus five-minute forced-release policy or a second inactivity-based
  execution watchdog.
- Validate provider lease renewal during long active model/tool work, then
  inactivity archive/release and subsequent restoration with the real provider.
- Validate acknowledged/uncertain deletion, archive failures and lease-loss
  fencing under the deployed worker topology. Local mocked-provider tests do not
  establish real-provider end-to-end behavior.
- If a one-minute idle warning/renew action is desired, implement it as learner
  activity UX; lack of a click must not override protected active execution.

This does not add course migration compatibility, resume an in-flight provider
request after termination, or change private-test evidence rules.

## Browser subscription recovery

The browser subscription is independent of Agent execution and learner activity.
It waits up to 90 seconds for a learning snapshot, an unchanged-observation
confirmation, or incoming snapshot data. A transport ping alone does not extend
this window. Successful passive projection reads send a small `observed` frame
at most every 25 seconds when the full snapshot is unchanged; a hung projection
cannot confirm its own health just because the socket still emits pings.

A subscription timeout aborts only its HTTP request and reconnects with backoff
from one to 30 seconds. After three consecutive failed subscriptions the UI
shows interrupted live updates while still retrying; network restoration,
returning to the visible page and manual refresh can reconnect immediately.
Authentication/ownership refusal (401/403/404) stops automatic retries. Each new
subscription starts with a replacement snapshot, including any execution result
committed while the browser was disconnected. Large snapshots may transfer for
longer than 90 seconds while new data continues to arrive.

Subscription failures never write an Agent status, cancel an Agent, count as
execution progress or learner activity, or authorize environment release. The
lifecycle owner still consumes durable Agent state and recorded learner activity;
a disconnected browser is not evidence of failed execution. Real proxy buffering
and network interruption still need deployment acceptance.
