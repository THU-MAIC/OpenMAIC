# PBL teaching request context

PBL v3 has no total teaching duration, learner-turn or tool-call ceiling. Each
individual model request must still fit the selected connector's context window.
The runner applies a role-local request projection at the model-call boundary.
This is independent of UI history pagination and conversation display budgets.

Small conversations keep their existing stage-scoped view. When serialized input
approaches the model window, a conservative UTF-8 byte estimate reserves output
and protocol overhead, keeps current host policy and the latest learner input
verbatim, and retains recent complete tool-call/result groups. Older dialogue is
summarized in bounded chunks by the same owner-authorized model connector with
thinking disabled. Only internal summary calls have a bounded output budget;
normal teaching retains its existing output behavior. Zero/missing usage reports
do not disable the guard. A missing model window uses a conservative 128K fallback.

Summaries are quoted untrusted reference data, never learner messages, approval,
mastery or permission. Host receipts, live stage state, version-bound artifacts,
actual learner input and the existing tool gates remain authoritative. Each role
has its own projection instance; roles do not share summaries or dialogue. The
last projection is cached only within the current execution and discarded with
it. This avoids a new persistence/migration path; later executions can regenerate
the projection from their durable role history.

No durable messages, report evidence, history cursors or feedback records are
rewritten or removed. Cancellation and lease/stage ownership are checked again
after asynchronous compaction. A summary failure fails the current request through
the normal retry path rather than sending an oversized original request. If static
course material or the latest input alone cannot fit, the request reports a
capacity error and retains saved progress. A model with a larger window or smaller
authored material is needed for that case; no request projection can safely hide
its current instructions or the learner's latest answer.
