# PBL execution and lifecycle contract

The Agent runner owns request termination. Sandbox lifecycle maintenance consumes
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
stable prefix readable with `modelRequestFailureCode` from
`lib/agent/runtime/request-failure.ts`; no schema migration is required.

| Code | Meaning |
| --- | --- |
| `MODEL_REQUEST_IDLE_TIMEOUT` | No upstream stream feedback within the request silence window. |
| `MODEL_REQUEST_FAILED` | Model request/stream failed for another reason. |

`LearningView.roleRun.failureCode` exposes only the safe code. The learner sees
existing timeout/authentication/unavailable feedback and can retry the same real
input. Retry does not fabricate feedback, readiness, artifact approval, test
results or stage completion. A queued retry/new message protects the environment
again. Other failures, such as setup authorization or an incomplete teaching
receipt, still use `failed`; consumers must not require one of these two codes to
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

The lifecycle owner can use `agent_sessions.status` / `getSession()` directly and
optionally parse the failure prefix for diagnostics. Do not add another model
silence timer or cancel work based on `turn_started_at`, event age or user age.
No separate `stalled` top-level status is necessary: the request owner first
settles a failed request, then maintenance observes the terminal status.

## Required lifecycle follow-up before real course integration

Active-turn protection is a safety rule, **not a complete stalled-work recovery
policy**. The model silence guard does not cover an unclaimed queue entry or a
hung tool. Those cases can currently retain an environment indefinitely. The
follow-up was accepted in the [maintainer review](https://github.com/THU-MAIC/OpenMAIC/pull/2003#pullrequestreview-5649817140)
and the [lifecycle owner's response](https://github.com/THU-MAIC/OpenMAIC/pull/2003#issuecomment-6413001789).

The lifecycle owner must coordinate execution recovery with the runner and
deliver a finite outcome for failed/abandoned work, covering:

- Queued work that never receives a claim: unavailable workers, exhausted
  attempts or blocked admission. Distinguish actual orphaned work from valid
  scheduling or learner-input waits; age alone is not a failure verdict.
- A hung tool while its worker continues heartbeating. Worker heartbeats and
  browser connection health are not tool progress. Preserve legitimately slow
  model/tool work; do not substitute a total-turn deadline or tool-count cap.
- Repeated worker crashes/reclaims, including a worker that crashes before
  persisting the existing over-attempt terminal verdict. Lease expiry alone
  cannot guarantee completion if no worker can finish recovery.
- Long healthy execution beyond the session grant's one-hour lifetime. Provider
  lease renewal does not refresh that grant; keep authorized workspace access
  valid without reviving an explicitly released or discarded environment.

Any terminal verdict must use the existing claim/write fences and persisted
session state before normal inactivity/archive/release can proceed. Do not
destroy a sandbox merely because a row looks old while a writer may still run.
This PR does not yet establish a finite outcome for all of the cases above.

Remaining lifecycle validation and integration:

- Review these merged changes and consume terminal state without reinstating the
  former ten-minute cancellation plus five-minute forced-release policy.
- Validate provider lease renewal during long active model/tool work, then
  inactivity archive/release and subsequent restoration with the real provider.
- Validate acknowledged/uncertain deletion, archive failures and lease-loss
  fencing under the deployed worker topology. Local mocked-provider tests do not
  establish real-provider end-to-end behavior.
- If a one-minute idle warning/renew action is desired, implement it as learner
  activity UX; lack of a click must not override protected active execution.

This does not add course migration compatibility, resume an in-flight provider
request after termination, or change private-test evidence rules.
