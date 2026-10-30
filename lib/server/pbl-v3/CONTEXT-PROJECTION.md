# PBL teaching request context

The authoritative design, budget, persistence and recovery policy is documented in
[Teaching context and model windows](../../pbl/v3/TEACHING-CONTEXT.md).

Implementation lives in `context-budget.ts` and `context-projection.ts`. PBL v3
teaching has no total duration, conversation-round or tool-call ceiling. Unknown
output metadata never turns an internal reservation into a normal reply limit.
Summary requests are measured in their actual serialized form and split to fit the
selected model. Checkpoints are persisted in the existing role-session entry tree;
original messages, thinking, tool records and recovery cursors remain intact.
