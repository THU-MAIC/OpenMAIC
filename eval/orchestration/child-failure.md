# Director behavior after child failures

Run with a configured provider and explicit model:

```sh
EVAL_DIRECTOR_MODEL=provider:model EVAL_SAMPLES=3 pnpm exec tsx --conditions=import eval/orchestration/child-failure-runner.ts
```

`EVAL_SCENARIO` optionally selects `error`, `timeout`, `empty`,
`teacher-error`, or `partial`. JSON reports are written per sample under
`eval/orchestration/results-child-failure/<model>/<timestamp>/`.

The Director uses the real model. Forced child streams bypass the provider but
run through the normal child runtime and result formatter. In `teacher-error`,
non-teacher children use the real model too. Neither runtime has its own child
deadline or transport budget; both are bounded by the shared tool timeout.
`timeout` injects a child stream that never answers and shortens that shared
timeout (`OPENMAIC_AGENT_TOOL_TIMEOUT_MS`) to 1 s for the run, so the Director
sees the real timeout result.

Reports include delegations per agent, repeat delegations, model-visible child
results, real provider adapter calls, simulated child transports, and ending
(`cue`, `close`, `plain_finish`, or `no_done`). Provider adapter calls include
Director compaction, but not connector/SDK-internal HTTP retries. Do not interpret
this counter as an exact HTTP request count or billing total. Repeated calls
mean calls after the first to an agent, not necessarily identical instructions.

Each sample is limited to 10 child delegations, 30 real provider adapter calls,
and 120 seconds. These limits abort only the eval; `capped` and `no_done` are
reported rather than counted as convergence. The runtime has no new loop cap.
Results currently describe unchanged prompts and cue/close validation. A plain
finish with no visible child content still provides no learner-facing explanation;
receiving `done` alone does not establish a satisfactory outcome. No pass-rate
threshold is implied. Compare individual traces across models after the pending
prompt and exit-policy decisions are implemented.
