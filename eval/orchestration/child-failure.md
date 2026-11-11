# Director behavior after child failures

Run with a configured provider and explicit model:

```sh
EVAL_DIRECTOR_MODEL=provider:model EVAL_SAMPLES=3 pnpm exec tsx --conditions=import eval/orchestration/child-failure-runner.ts
```

`EVAL_SCENARIO` optionally selects `error`, `timeout`, `empty`,
`teacher-error`, `teacher-error-student`, or `partial`. JSON reports are written per sample under
`eval/orchestration/results-child-failure/<model>/<timestamp>/`.

The Director uses the real model. Forced child streams bypass the provider but
run through the normal child runtime and result formatter. In `teacher-error`
(teacher + assistant) and `teacher-error-student` (teacher + student), only the
teacher fails; the other child uses the real model. A student reply alone does
not satisfy the normal teaching check, so `teacher-error-student` is the case
that exercises the `cue_user` exception after a failed teaching call. Neither runtime has its own child
deadline or transport budget; both are bounded by the shared tool timeout.
`timeout` injects a child stream that never answers and shortens that shared
timeout (`OPENMAIC_AGENT_TOOL_TIMEOUT_MS`) to 1 s for the run, so the Director
sees the real timeout result.

Reports include delegations per agent, repeat delegations, model-visible child
results, real provider adapter calls, simulated child transports, and ending
(`explicit_cue` when the Director called `cue_user`, `auto_cue` when it finished
and the runtime cued, `close`, `plain_finish`, or `no_done`). `covered` is false
when the Director never reached the injected failure or, for the teacher-only
scenarios, never tried another agent; report such samples as not covered rather
than as convergence. `agentHadContent` and `teachingAgentFailedOrEmpty` are
copied from `done`; the client uses them for its fixed notices. Provider adapter calls include
Director compaction, but not connector/SDK-internal HTTP retries. Do not interpret
this counter as an exact HTTP request count or billing total. Repeated calls
mean calls after the first to an agent, not necessarily identical instructions.

Each sample is limited to 10 child delegations, 30 real provider adapter calls,
and 120 seconds. These limits abort only the eval; `capped` and `no_done` are
reported rather than counted as convergence. The runtime has no new loop cap.
After a failed or empty teacher/assistant call, `cue_user` is allowed without a
visible teaching answer; with no teaching attempt it is still rejected, and the
close_session check is unchanged. The learner never sees the `cue_user` prompt:
the client shows a fixed, translated notice instead (no response at all, or a
partial answer after a teaching failure). Receiving `done` alone does not
establish a satisfactory outcome, and no pass-rate threshold is implied.
Token-limited partial output keeps isError and its available text.
