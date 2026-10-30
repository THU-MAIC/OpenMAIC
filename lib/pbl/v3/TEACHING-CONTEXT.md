# Teaching context and model windows

## Boundaries

Learning may continue for any number of turns and tool calls. Each physical model
request must fit its selected model's window. UI pagination, sandbox idleness,
preview grants and report analysis are separate concerns. This policy applies to
PBL v3 teaching; it does not change v2 or other Agent workloads.

Discussion, Planner and Coder each have a session per milestone; Mentor has a
project-level session. Summaries stay inside that existing role session. Handoffs
continue through decisions, contracts, PLAN, code and formal assessment evidence,
without sharing the roles' full chats.

## Request construction

1. Load the existing complete entry tree and run the normal delivery/resume and
   orphan-tool reconciliation. Do not derive delivery cursors from summaries.
2. Refresh owner/worker/stage authority, current file/version observations,
   pending review, declared visible decisions, current assessment receipts, and
   the exact active teaching section from the host. Do not widen artifact access.
3. Compose current instructions/material, a quoted historical summary, and recent
   complete interactions. Always retain the latest actual learner message and
   every subsequent assistant/tool group verbatim. They are the active execution,
   not historical memory. If that group cannot fit, fail with
   `PBL_CONTEXT_CAPACITY` before making summary calls; never erase a just-read
   result and ask the model to read it again. Ignore legacy checkpoints that
   covered any part of the still-active turn. Once the learner sends a new input,
   earlier completed groups can become historical context.
4. Reserve output space and ten percent headroom when preparing input. When the
   connector declares an output window, bound the per-request allowance by that
   window and one quarter of the context. Without output metadata, the 8,192-token
   fallback is only an internal input reservation: omit `max_tokens` on normal
   teaching requests rather than imposing an invented reply ceiling. The provider's
   actual output behavior still applies. The route context override precedes the
   catalogue and 128,000 fallback; operator metadata must match the real route.
   When the slot declares a fallback, teaching uses the smaller context and output
   capacities of the two targets for input preparation, normal replies and summary
   calls. This avoids passing a primary-only allowance or oversized input to a
   smaller backup. Unknown output capacity on either target omits the normal
   teaching wire allowance. Non-teaching Agent requests retain their existing
   primary metadata and fallback behavior.
5. When needed, summarize older history in bounded chunks through the same
   authorized connector, with thinking disabled and output at most 4,096 tokens.
   Include full textual tool results and their identities, not the SDK generic
   serializer's 2,000-character prefixes. Exclude old speculative thinking from
   summary input; raw thinking and tools remain available in saved records.
   Construct and measure the exact summary request (policy, previous summary,
   escaped source and output reservation) before sending it through the existing
   connector. Reduce source chunks until they fit, without a fixed 8K deduction or
   a total chunk-count limit. Never persist empty, failed or token-truncated summaries.
6. Recheck authority after asynchronous preparation. If current facts changed,
   rebuild with the fresh facts before sending. A further change fails safely
   for retry; no tool or learner mutation is replayed.

The input estimator conservatively charges serialized UTF-8 bytes as tokens,
including system text, tools and messages. This is a safety estimate, not exact
tokenization or reported usage. Operator route configuration must match the real
model/gateway. Capacity errors identify oversized current material or input;
transient summary failures have separate learner guidance. Neither sends an
oversized original request as a fallback. Provider token truncation retains the
existing incomplete-output/tool-call recovery behavior; it never proves success.

## Incremental derived checkpoints

Append `pbl.teaching-context.v1` custom entries on the existing ordered, leased
session write chain. Store only a summary, its covered message count and source
prefix hash. Restore only a matching prefix on the active branch, then summarize
newly covered messages with the previous summary. A changed branch, incompatible
summary size or mismatched prefix rebuilds from original records.

The existing Session custom-entry mechanism is intentional: unlike a native
compaction entry, it does not inject a synthetic user message into `buildContext`
or change stage feedback counts, resume classification and delivery cursors.
There is no new table, queue, shared memory service or schema migration.

Summaries are untrusted derived reference data. They cannot grant readiness,
understanding, approval, file permissions or completion. Current host receipts
and artifact/version checks remain authoritative. Current files must be reread
before editing or claiming their behavior. Report evidence, history and recovery
retain the original messages and events.
Free-form summaries are lossy model output: use them for historical context,
ask for clarification when uncertain, and never substitute them for current
decisions, formal outcomes or approval receipts.

Checkpoint writes share the source-message chain and lease fence. Cancellation,
lease loss, stage/environment changes and persistence failures stop the current
request; stale workers cannot publish new history. An interrupted command is
reconciled using its existing ID, never rerun to manufacture missing evidence.

## Verification and operation

Record projection estimates, budget, coverage, summary calls and checkpoint reuse
without logging prompts, tool payloads or learner prose. Existing connector usage
records remain the source of actual model usage. There is no global elapsed-time
or tool-count cap: existing upstream-silence and execution-stall watchdogs still
apply, with actual upstream/tool progress rather than browser heartbeats.

Cover short requests, long single steps, milestone transitions, role isolation,
large tool-result tails, output truncation, durable checkpoint reuse after worker
restart, cancellation/lease loss, current-version changes, capacity errors and
summary failures. Local/mock/PG evidence does not establish hosted real-model
long-session acceptance; verify the deployment route separately.

Deployment must verify the context window of **both** configured slot targets.
The 128K value for a target with missing metadata is an estimate, not discovery
of its real capacity; pin an appropriate slot context window before using a
smaller uncatalogued route. Summary calls publish a checkpoint only after all
chunks succeed. Interrupted preparation may therefore repeat completed summary
work. A truncated/oversized summary fails safely rather than publishing incomplete
memory; automatic retry with a different compression target, partial-chunk
checkpoints and low-water-mark tuning remain performance follow-ups.
