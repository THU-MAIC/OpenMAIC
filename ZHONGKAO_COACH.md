# 2027 Zhongkao Coach: Milestones 1 through 2B-1

This document describes the domain foundation for a single fictional learner
using OpenMAIC locally or on a trusted private network. The only initialized
facts are grade 9 and exam year 2027.

## Zero-profile startup

`StudentProfile` is created with `grade=9` and `examYear=2027` as confirmed
observations backed by `project_setup` evidence. Display name, region,
preferred subjects, study time, textbook versions, and scores start unknown or
empty. The profile never stores an authoritative weak-knowledge-point list.
The UI fallback label for an unknown display name is not persisted as a name.

## Observed fields

An `ObservedField` has a value, status, confidence, evidence, and update time.
Unknown fields have a null value and null confidence. Inferred and confirmed
fields require a non-null value and evidence. Inferred confidence is in
`(0,1]`; confirmed confidence is exactly `1`. Ordinary inference leaves a
confirmed field unchanged. Only explicit user or guardian evidence can confirm
a candidate through the public domain operation. The domain layer expresses
this boundary through separate APIs and evidence types: the general confirmed
field constructor is private, while `confirmObservedField` accepts only
`user_input` or `guardian_input` evidence. A private profile initializer may use
`project_setup` only for the fixed `grade=9` and `examYear=2027` facts; it cannot
confirm region, textbook, score, target, preference, or schedule fields.

Persisted payload validation can restore a confirmed field that already meets
these rules, but it does not expose an automatic inference-to-confirmed domain
operation. A future API layer must still authenticate and authorize the caller
that supplies user or guardian confirmation. Milestone 1 does not claim that
domain code alone can prove who originated an input.

## Curriculum mode and policy

Curriculum mode is calculated independently for each subject:

- missing or unknown textbook: `generic`;
- inferred textbook: `inferred`;
- confirmed textbook: `confirmed`.

Generic mode can classify user-provided questions, explain generic middle-school
knowledge, save attempts, and use generic knowledge-point labels. It rejects
publisher, textbook title, volume, chapter, page, regional scope, and regional
policy claims. Source attribution requires a verified source. Policy decisions
use typed claim values, structured source references, and stable error codes
rather than natural-language keyword scanning.

Source attribution is default-deny in every curriculum mode. The caller must
provide a trusted verifier that confirms the exact structured source type and
id; a missing verifier, malformed reference, unknown source, or verifier error
is rejected. Milestone 1 defines this trust boundary but does not connect a real
Materials verifier. A later Materials integration must implement the verifier
by querying existing material records rather than trusting a caller-provided
boolean or guessing that a source exists.

## StudyAttempt

`StudyAttempt` is an immutable fact with a profile, subject, one or more generic
knowledge-point ids, question summary/source, attempt kind, outcomes, help
facts, and optional error/duration data. Material questions require a material
id; page values are positive integers. The validator checks schema version,
enums, identifiers, ISO timestamps, duplicate knowledge-point ids, and numeric
bounds.

Repeated reads of fully equivalent attempts with the same id are folded into a
single fact. Reusing an id with any conflicting persisted fact is rejected with
a stable domain error; neither input order nor timestamp ties choose a winner.

Independent correct is derived only when the final outcome is correct, the kind
is `transfer` or `review`, the learner attempted before help, no hints were
used, no key hint was used, and the full answer was not viewed. There is no
client-declared `isIndependent` field. Initial correct and assisted correct are
positive observations but do not count as independent progression.

## RuntimeStore partitioning

The existing `RuntimeStore` remains the only persistence layer. Two app-defined
kinds are registered in the shared validator table:

- `zhongkaoStudentProfile` stores append-only profile snapshots;
- `zhongkaoStudyAttempt` stores append-only attempt facts.

`learnerKey` is the anonymous browser learner partition. `profileId` identifies
the student configuration. A centralized helper validates and encodes the
profile id into a stable `stageId`; the chat/session id is never used as the
learning-history partition. Thus a new ordinary chat can read the same profile
and attempt history, while different profile ids remain isolated.

Profile snapshots use the RuntimeStore record `seq` as their authoritative
storage order. Loading selects the valid record with the greatest `seq`
explicitly and does not depend on `listRecords()` order or the profile's domain
`updatedAt` value. Repeatedly saving an equivalent latest profile is
deterministic and does not create a competing snapshot.

## KnowledgeProgress

`KnowledgeProgress` is a pure projection over actual attempts. It deduplicates
attempt ids, sorts by timestamp and id, filters by profile/subject/knowledge
point, and exposes traceable attempt ids. One real error yields
`needs_observation`; two real error observations yield `weak`. Two independent
correct observations among the latest three valid observations yield
`developing` and can supersede older weak evidence. `stable` is retained as a
future state but is never produced in this milestone. No percentage, score
prediction, admission probability, or intelligence label is calculated.

## Deliberate exclusions

Milestone 1 does not add pages, routes, agents, model calls, skills, material
upload/OCR changes, scheduling, daily plans, i18n, or Playwright coverage. It
also does not infer textbook identity, claim a regional syllabus, or persist a
separate progress aggregate.

## Milestone 2A coach event state machine

Milestone 2A adds the app-defined `zhongkaoCoachEvent` runtime kind. One typed
problem is an append-only event stream containing user actions and server-only
facts. RuntimeStore `seq`, beginning at zero, is the authoritative replay order
and the state's revision. The pure projector sorts records by `seq` and requires
the exact contiguous sequence `0, 1, 2, ...`. It rejects gaps, duplicate
sequences, every duplicate `eventId` or `operationId` (even if the payloads are
identical), a non-start first event, a second start, and mixed RuntimeSession,
profile, or coach-session records. Corrupt history never yields a partial state.

The projected status moves through awaiting attempt, hint pending/hinting,
solution locked/available, transfer pending, finalizing, and completed or
abandoned. Completion requires a verified transfer assignment, a durable
transfer submission, a server evaluation, and a later
`study_attempts_projected` event. M2A defines that last boundary but does not
write a StudyAttempt. The projection never stores or accepts `isIndependent`,
`mastered`, or a mastery percentage.

## Server identity and RuntimeStore partitions

Agent Session metadata supplies trusted `ownerId`. A single server-only mapper
maps it to `zhongkao-owner:v1:<sha256-hex>` using the domain
`openmaic:zhongkao-owner:v1`. The result has fixed length and contains no owner,
email, or user-name plaintext. It is a stable pseudonymous partition key, not
authentication, and never replaces the original owner/session authorization
checks. Because the hash has no secret, it does not promise resistance to a
small-dictionary enumeration attack. A future HMAC design would require a new
version and an explicit migration; M2A adds neither a key nor a migration.

`zhongkaoStageId(profileId)` remains the only stage-id constructor. Every
problem receives a server-derived `coachSessionId` and a one-to-one independent
RuntimeSession under that stage and learner. The Agent chat session is event
provenance and part of the durable start identity; it is not the learner
partition or the coach RuntimeSession. Different owners and profiles remain
isolated.

The start identity is exactly the mapped learner key, profile id, Agent Session
id, durable user-message `seq`, and the fixed `start:v2` marker. It contains no
`toolCallId`. Both `coachSessionId` and the start `operationId` are
domain-separated deterministic hashes of that identity. Therefore one durable
message can start only one coach session: equivalent start facts replay one
`coach_started`; different subject, knowledge-point, source, or question-text
facts conflict instead of creating another session. A different durable message
can create another session.

## Trusted message and idempotency boundary

The model tool schema does not contain question or response text, owner or
learner identity, user-message ids/sequences, operation/event ids, timestamps,
phase, causal references, or derived trust flags. Tool construction requires a
copied and frozen `TrustedAgentTurn` containing trusted owner, Agent Session, and
the already selected durable user-message `seq`. The reader verifies that exact
session and owner and reads that exact persisted `user_message`; it never runs a
latest-message query or accepts a lazy seq getter. Blank messages and text over
12,000 characters are rejected. Appending a later user message cannot change an
already constructed tool's turn.

M2B runner wiring must build `TrustedAgentTurn` from the runner's immutable
durable-turn tag. It must not recover the seq by asking the session for its
latest message.

Every event has a server-generated semantic `operationId` and a 64-character
canonical `operationFingerprint`. Model operations derive their id from mapped
learner, profile, coach session, Agent Session, durable message seq, and action;
internal operations derive it from a request, attempt, resolution, submission,
or evaluation event. `toolCallId` participates in neither. The fingerprint
covers all semantic operation facts but excludes timestamps, event ids,
database seq, expected revision, tool call ids, and hidden reasoning. Student
text contributes only a fixed-length text hash. Canonical object-key ordering
and normalized knowledge-point ids make equivalent inputs stable.

Every write validates the owner/learner/profile/session partition, constructs
the expected operation id and fingerprint, and then checks existing history.
Matching id and fingerprint is an idempotent replay; a matching id with a
different fingerprint is `COACH_EVENT_CONFLICT`. Only a new operation proceeds
to the expected-revision check and atomic append. A typed RuntimeStore CAS loss
causes a re-read and the same comparison; otherwise it becomes
`COACH_SESSION_CONFLICT`. A PostgreSQL append guarded by `expectedLastSeq` also
uses that typed conflict when the locked session is already inactive. The coach
layer does not classify database or inactive errors by message text.

## Original and transfer phases

Help and attempt facts are projected into separate `original` and `transfer`
phase state. Each phase has its own attempt count, hint requests, one pending
hint request, issued hints, third/key-hint flag, solution request history, and
answer-view flag. Attempt message references are deduplicated across both
phases, so one durable message cannot count once as an original attempt and
again as a transfer submission. The model never submits a phase; the server
chooses original or transfer from the authoritative state and action.

Original full-solution availability remains
`attempts >= 2 || (attempts >= 1 && hintsIssued === 3)`. Requested-but-unissued
hints and all transfer hints are irrelevant to that predicate. An early
`full_solution_requested` remains in history and returns
`FULL_SOLUTION_LOCKED`, but it is not pending. Later unlock does not generate or
reveal a solution automatically. The learner must make another explicit request
after unlock; only that event becomes the pending request which a reveal may
consume exactly once.

M2A transfer questions may request and consume up to three hints, with the third
marked as a key hint. M2A exposes no transfer full-solution action or directive,
and `transfer.viewedFullAnswer` exists but remains false on every reachable
transition. These transfer-only facts are sufficient for M2B to construct
`studentAttemptedBeforeHelp`, `hintsUsed`, `usedKeyHint`, `viewedFullAnswer`, and
`finalOutcome` without borrowing original-question help facts.

## Causal server facts

Server facts form an explicit, validated chain:

- `hint_issued` cites the current unconsumed `hint_requested` in the same phase;
- `full_solution_revealed` cites the current unlocked original request;
- `original_resolved` cites a real original attempt and records its outcome;
- `transfer_question_assigned` cites the authoritative original resolution and
  stores question id, knowledge-point ids, and a validation reference, but no
  answer key or rubric;
- `transfer_answer_evaluated` cites the one transfer submission and exact
  transfer question;
- `study_attempts_projected` cites the evaluation and stores a deterministic
  server projection reference plus projection version.

Each causal reference determines the internal operation id. Equivalent retries
replay; a changed outcome, transfer question, validation fact, or projection
fact conflicts. Callers cannot supply an arbitrary internal operation id or
projection reference.

## Model actions and internal actions

The unregistered TypeBox tool factory exposes only:

- `start_problem`, `get_state`, `submit_attempt`;
- `request_hint`, `request_full_solution`;
- `submit_transfer_answer`, `abandon_problem`.

Server-only modules reserve `recordHintIssued`,
`recordFullSolutionRevealed`, `recordOriginalResolved`,
`assignVerifiedTransferQuestion`, `recordTransferEvaluation`, and
`recordStudyAttemptsProjected`. These functions use the same owner mapping,
operation replay, fingerprint checks, revision checks, and CAS writes, and are
not exported from the browser Zhongkao barrel or included in the model action
union.

`zhongkaoCoachEvent` is a server-only RuntimeStore kind. The server Coach service
uses the provider directly. The generic persistence HTTP route rejects its
creation, hides direct sessions and records, filters it from listings, blocks
append/status/delete, and preserves it during learner-scoped deletion. Existing
client-visible runtime kinds retain their route behavior.

The internal `CoachState` is never spread into tool output. A closed public DTO
contains only coach/profile ids, status/revision, safe original/transfer counts
and booleans, allowed actions, directive, and minimal replay/append facts. Both
success and error builders run TypeBox `Value.Check` in the production return
path; serialized `content` and structured `details` are built from that same
validated DTO. Owner/learner identity, Agent Session/message refs, event and
operation ids, fingerprints, causal refs, student text, answers, rubrics, and
database errors do not cross the tool boundary.

## M2A exclusions and deployment limits

M2A does not generate hint text, full explanations, transfer questions, answer
keys, rubrics, or hidden reasoning. The tool factory is intentionally not
registered in the ordinary Agent runner. Material-backed questions return
`MATERIAL_SOURCE_NOT_SUPPORTED`; no parallel upload or source verifier was
created. M2B must connect the existing Skills and Materials boundaries, perform
generation/evaluation, validate a generated transfer question through the real
Materials boundary, and project StudyAttempt v2 facts.

The server adapter uses the existing RuntimeStore provider. Production server
persistence therefore still requires the repository's configured PostgreSQL
provider; browser IndexedDB is used only by focused adapter tests. No new
database, table, localStorage key, dependency, API route, UI, or model call is
part of M2A.

## Milestone 2B-1 Skill and runner gate

M2B-1 adds the builtin `zhongkao-coach` Skill. Its text governs teaching
behavior only: the learner tries first, one directive yields one hint, and a
full solution appears only after the service directive permits it. The Skill
cannot assert unlock, mastery, independence, source verification, or internal
events. Material text remains untrusted data and cannot override the Coach
state machine.

The ordinary runner does not expose the Coach tool by default. Registration
requires the claimed session's frozen server metadata to contain the exact
`skillId === "zhongkao-coach"` and a positive, verified durable user-message
sequence. Prompt text, automatic Skill reads, synthetic frames, tool results,
and model claims do not satisfy this boundary.

Every frozen Zhongkao run receives a new server-owned `TerminalToolGate`. It
allows only `zhongkao_coach_action`, discards all model text and reasoning
before those bytes can reach Pi, the durable event log, or SSE, and terminates
after the accepted tool result whether that result is success or a stable
error. A missing call or a gate rejection that never executed Coach produces
fixed `coach_notice` copy. Once a valid Coach call may have executed, a timeout,
malformed receipt, or result without durable operation proof is not converted
to a notice: the turn remains undelivered and is requeued for exact-call replay.
The provider's specified tool choice is defense in depth only; correctness does
not depend on provider compliance or Skill prose. Tool-result and provider-error
details are removed from the guarded public event log. Ordinary Agent runs
receive no gate and keep their existing streaming and steering behavior.

The no-attachment create route persists the initial frozen Zhongkao prompt as
a real `user_message` before the run can be queued. The runner copies and
freezes the owner, Agent Session id, and exact sequence into one
`TrustedAgentTurn`; the tool reader checks the session owner and reads exactly
that durable user row. Crash continuation recovers the same tagged turn from
the raw active entry-tree branch and verifies it against the claim watermark
and event log. Missing, duplicate, malformed, or after-watermark provenance
fails closed with no Coach tool and no free-form response. A later N+1 event
is not drained into guarded turn N; it is requeued for a new claim and a new
trusted turn.

## Terminal presentation and durable replay

The main model never authors the terminal student response. A schema-valid
Coach result is converted to the shared `hint | full_solution | coach_notice`
union. A hint or solution is publishable only when its Coach content event was
already appended or was recovered as a replay. Stable errors and all gate
failures map to fixed server copy without provider, database, owner, session,
or student details.

Publication first appends one complete server-authored assistant message to
the existing entry tree, then appends durable `message_start` and `message_end`
events. All three writes are lease-fenced correctness writes. Correlation is
derived from the Agent Session and durable turn sequence; a separate domain is
used for damaged-provenance notices, with a stable durable candidate used only
for idempotency and never promoted to trusted provenance. Retries inspect both
the entry branch and event log, reuse the persisted Coach receipt, and repair
only missing publication pieces. A failed publication is requeued rather than
re-generated. Reconnect and refresh replay the same durable text. Internal
turn and correlation markers remain server-side and are stripped from SSE.

Live and orphan Coach execution use the same bounded tool wrapper. Its derived
abort signal is bound to the per-execution generation call and is checked after
material reads, generation, and before the content append. A provider that
ignores cancellation may finish later, but that late value cannot cross the
post-await append guard. Orphan recovery requires one schema-valid Coach call
and one causally matching receipt with matching call id, tool name, order, and
`isError` semantics. Empty, interrupted, timeout, or otherwise uncertain
receipts are replayed with the original call id and parameters; recovery itself
has the same deadline and never occupies a lease indefinitely.

A guarded user cancellation wins over uncertain receipt recovery and automatic
retry. The runner first closes any in-flight Coach call with one durable
interrupted receipt, then appends a server-only durable event marker bound to
the exact user-message sequence. It next appends the entry-tree tombstone and
advances the handled watermark. Recovery treats the event marker as authority
when the entry write failed, and retains the tombstone as branch provenance. If
the marker write itself failed, the claim scan's atomic durable
`session_end(cancelled)` records the exact first-undelivered sequence and is
usable only when the raw entry cursor carries that turn tag. A later queued
turn is requeued in the same transaction; an older cancellation terminal is
ignored.
The internal marker is never sent over SSE. These paths neither replay nor
publish cancelled N, and queued N+1 starts with a new trusted turn. The
watermark means consumed-without-publication; it does not claim that the learner
saw a response.

## Materials trust chain and page lineage

The M2B-1 source adapter reuses the existing Agent Session metadata, session
materials repository, and material byte store. It verifies the current owner,
current Agent Session, and exact material id before constructing a structured
`uploaded_material` reference. Its `CurriculumSourceVerifier` accepts only the
exact source type and id. Missing, foreign, malformed, or repository-error
paths all fail closed as `MATERIAL_SOURCE_NOT_VERIFIED` without revealing
whether another owner's row exists.

Extraction does not retain reliable chunk-to-page lineage. The adapter
therefore never constructs `sourcePage`; model input cannot provide one, and
generation rejects page claims. A sanitized one-line material display name may
be used for attribution, while both that user-controlled name and extracted
text are placed inside the existing untrusted-material fence.

For this milestone, even a material-backed start uses the trusted current user
message as the problem text. The verified material is optional explanation
context, not a model-selected quote promoted to a trusted question. Reliable
material quote-to-question extraction remains future work.

## Hint and full-solution generation

Production hints are three deterministic server-owned templates selected only
by ordinal and key-hint status. The hint path does not call a model and does not
read the question, student attempt, answer, or material body. The service still
appends `hint_issued` before publication, so replay returns exactly the same
text. Answer-aware adaptive hints, semantic leak evaluation, and adversarial
offline evaluation are deferred beyond M2B-1.

M2B-1 does not generate transfer-question hints. The public Coach tool requires
the original phase before appending `hint_requested`; a transfer-phase request
is rejected as a stable action error without creating a pending request.

An explicitly requested and policy-unlocked full solution may use the existing
generation abstraction. Its closed output is
`{schemaVersion: 1, explanation, finalAnswer?, claims}`; `claims` is required
even when empty. Each claim uses the M1 `CurriculumClaim` type and is evaluated
by the M1 curriculum policy. A material source attribution is reconstructed
from the server-verified source rather than trusting model verification flags.
Generic mode rejects publisher, textbook, volume, chapter, page, regional
scope or policy claims. Source attribution requires an exact server-verified source.

Limited text patterns also reject undeclared explicit publisher, textbook,
chapter, page, regional-exam, and true-exam wording, including common `P.88`,
`p88`, Arabic-page, and Chinese-number page forms. These patterns are
defense-in-depth, not a complete natural-language proof. Provider errors,
malformed JSON, schema failures, rejected claims, or heuristic matches become
stable Coach errors and do not append a reveal event or rejected candidate.

If a request is already durable but generation, verified-material resolution,
or a stable content append fails, the service appends an internal
`presentation_failed` event for the exact request and safe failure code. This
event clears only that request's pending marker. It does not issue a hint, mark
an answer viewed, advance mastery, expose provider details, or enter the public
DTO. A later durable student turn may make a new request. If the failure event
write is itself uncertain, the current turn remains undelivered and replay
reconciles the already-persisted content or failure event before publication.
The failure code is also bound to its presentation kind: hint failures cannot
clear a full-solution request and full-solution failures cannot clear a hint
request. The same shared mapping is enforced when the event is constructed,
validated, folded, and accepted as a terminal receipt.

The causal flow is request event, server directive, generation and validation,
internal content event append, then public presentation. `hint_issued` stores
the accepted `hintText`; `full_solution_revealed` stores the accepted
student-facing `explanation` and optional `finalAnswer`. These bounded fields
participate in the operation fingerprint. Replaying the same request reads the
persisted content without another model call, while a different candidate for
the same causal request conflicts. A failed append or CAS loss returns no
presentation unless replay proves that the exact accepted content was already
persisted.

The Coach tool DTO may carry a validated persisted `hint` or `full_solution`
for the server runner. The only terminal student-facing union is
`{kind: "hint", text}`, `{kind: "full_solution", explanation, finalAnswer?}`,
or `{kind: "coach_notice", text}`. Ordinary state/facts and `get_state` never
include presentation content, internal ids, message references, owner/learner
identity, raw student text, or hidden reasoning.

Materials remain untrusted model data even after ownership and source-id
verification. Code prevents material text from changing Coach state, revision,
unlock, phase, source verification, or internal actions. Prompt fencing and
the finite text heuristics mitigate instruction following and fabricated
attribution, but do not constitute a proof that prompt injection is solved.

## M2B-1 stopping point

After a full solution, the existing state machine reports that transfer
generation is required. M2B-1 does not generate or verify a transfer question,
evaluate a transfer answer, project StudyAttempt v2, update KnowledgeProgress,
or add UI/planning/review behavior. Those remain M2B-2 work. M2B-1 does not
modify the StudyAttempt contract and adds no dependency, database, upload path,
or client persistence surface.
