# 2027 Zhongkao Coach: Milestones 1 through M3A-1b

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
- legacy `original_resolved` cites an original attempt, while causal v2/v3
  forms cite either an authoritative original evaluation or the exact full
  solution reveal and never accept a model-supplied outcome;
- `transfer_question_assigned` cites the authoritative original resolution and
  stores the validated public question plus a server-only grading specification
  and verification metadata. The private fields never enter folded public state,
  a model tool result, or a terminal presentation;
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
Coach result is converted to the shared
`hint | full_solution | transfer_question | transfer_result | coach_notice`
union. Generated content is publishable only when its Coach content event was
already appended or was recovered as a replay. Stable errors and all gate
failures map to fixed server copy without provider, database, owner, session,
student, or private grading details.

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

### M3A-1a material storage safety contract

All new material byte-store keys use one domain-separated SHA-256 namespace.
Owner, Agent Session, and material identifiers are hashed in distinct domains
before they become path segments; raw identifiers, including anonymous owner
ids containing `:`, never enter a new filesystem or object-store key. The
logical key is portable across Windows and Linux and is passed unchanged through
the neutral byte-store abstraction. Existing pre-v1 owner keys remain readable
because their recorded key stays authoritative. Existing session keys remain
readable only when their legacy session segment is portable; new writes always
use the v1 namespace. Anonymous-owner keys containing `:` could not have been
written by the Windows local store, so there is no readable Windows legacy
object to migrate.

An owner material id identifies one owner-library original. Binding does not
reuse that id as the globally keyed `agent_session_materials.id`. Instead, the
server deterministically derives a distinct snapshot id from the trusted Agent
Session id plus owner material id, copies verified bytes into that session's
independent namespace, and writes session-scoped metadata. Rebinding is
idempotent, concurrent identical writes converge on the same snapshot, and two
sessions never share backing bytes. Before copying, the server verifies the
target session owner, owner-scoped ready row, byte length, and stored SHA-256.

Owner deletion uses tombstone, byte deletion, then metadata purge. A byte or
purge failure retains a non-visible tombstone with its object pointer so the
same deletion can retry. Existing session snapshots remain readable after the
owner original is deleted. Asset-era owner rows whose migration cannot recover
a byte-store locator are never returned as ready materials; the server does not
invent a replacement key.

Every Session byte write first persists a write claim containing the Session,
logical material, object slot, and expected canonical key. Publishing bytes
then holds the same Session row lock that deletion must acquire. A publisher
that entered first settles its durable claim before deletion can tombstone the
Session; a deletion that entered first prevents both new claims and byte writes.
If publishing fails after the backend may have accepted the bytes, its durable
claim remains available to cleanup. Creating or finalizing material metadata
after a tombstone cannot make the Session visible again.

Agent Session deletion is synchronous and drainable: it tombstones the Session,
loads object keys from both material rows and outstanding write claims, removes
those objects, and only then purges the rows and claims. Repeating the normal
delete operation is the recovery entry point after a cleanup failure. Clearing
the independent Session prefix remains defense in depth for older unclaimed
objects, but correctness for new writes comes from the durable claim and
tombstone fence. Cleanup refuses a recorded object key outside the exact
Session namespace, and derivatives are constrained to a source in the same
Session at the database layer.

Canonical object keys, owner/session hash namespaces, local paths, and provider
diagnostics are server-only. Material HTTP responses, tools, durable tool
results, and SSE replay use closed projections containing logical material ids
and closed extraction error codes. Historical free-form extraction errors map
to a generic failure code at read time. Internal storage lookup continues to use
the recorded locator without exposing it as an asset id.

The repository pins Prettier-managed source and configuration formats to LF in
`.gitattributes`. This keeps a fresh Windows checkout stable even when the
user's global `core.autocrlf` is true; Markdown and YAML remain governed by the
existing Prettier ignore policy, so the change does not introduce a repository-
wide normalization commit.

This contract is sufficient for a future server-only reference containing
`{ownerMaterialId, sha256, mimeType, byteLength}`: the owner material can be
resolved directly, re-authorized, and digest-verified without an Agent Session
copy. M3A-1a does not create that Exam reference, an Exam upload route, an Exam
runtime, extraction, OCR, diagnosis, Progress writes, or UI.

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

The Coach tool DTO may carry a validated persisted `hint`, `full_solution`,
`transfer_question`, or `transfer_result` for the server runner. Transfer
question presentation contains only its public id, supported type, question,
optional public options, and difficulty. Transfer result presentation contains
only `correct | incorrect` and matching fixed server copy. Ordinary state/facts
never include internal ids, message references, owner/learner identity, raw
student text, private grading data, verifier output, or hidden reasoning.

Materials remain untrusted model data even after ownership and source-id
verification. Code prevents material text from changing Coach state, revision,
unlock, phase, source verification, or internal actions. Prompt fencing and
the finite text heuristics mitigate instruction following and fabricated
attribution, but do not constitute a proof that prompt injection is solved.

## M2B-1 historical stopping point

After a full solution, the existing state machine reports that transfer
generation is required. M2B-1 does not generate or verify a transfer question,
evaluate a transfer answer, project StudyAttempt v2, update KnowledgeProgress,
or add UI/planning/review behavior. Those remain M2B-2 work. M2B-1 does not
modify the StudyAttempt contract and adds no dependency, database, upload path,
or client persistence surface.

## Milestone 2B-2A verified transfer question and deterministic evaluation

M2B-2A implements only the transfer assignment and evaluation portion of the
Coach lifecycle. It does not change `StudyAttempt`, project attempt records,
update `KnowledgeProgress`, schedule reviews, add student UI, or complete a
Coach session. M2B-2B owns projection and completion.

### Supported transfer question contract

The first version supports exactly four objectively gradable types:

- `single_choice`;
- `multiple_choice`;
- `numeric`;
- `exact_short_answer`.

Proofs, essays, open explanations, subjective rubrics, multi-solution problems,
symbolic algebra, and other tasks that require human or semantic grading are not
accepted. An unsupported generated type fails with
`TRANSFER_QUESTION_TYPE_UNSUPPORTED`; it is never presented as verified.

A model may produce only a closed candidate containing schema version, type,
student-facing question and options where applicable, an expected-answer shape,
authorized knowledge-point ids, allowed difficulty, and typed curriculum claims.
It cannot set a transfer question id, validation status, verification flag,
grading specification, operation/event identity, mastery, or independence.
Candidate lifecycle values are internal `candidate`, `rejected`, and `verified`:
only the server may produce `verified`, and only a verified assignment may be
persisted and presented. Candidate and rejected content is discarded rather
than written to student transcript, public DTO, SSE, or a Coach assignment event.

The public question and private grader are separate contracts. Public data is
limited to schema version, server-derived `transferQuestionId`, supported type,
question, public options, authorized knowledge-point ids, and difficulty. The
server-only grading specification is a closed discriminated union: one correct
option id, an exact set of correct option ids, a finite numeric value and bounded
tolerance, or bounded normalized accepted strings. It contains no executable
code, arbitrary regular expression, dynamic formula, or model explanation.
The browser Zhongkao barrel does not export this private type.

### Validation and independent verification

Generation runs only while authoritative Coach state is active, the original
problem is resolved, no transfer assignment exists, and the server directive is
`GENERATE_TRANSFER_QUESTION`. A model action or argument cannot manufacture that
state. The server derives a stable question id from the Coach session, original
resolution event, and transfer schema version. Once assignment is durable, all
retries and refreshes read that exact event; they do not generate a replacement.

Each bounded attempt passes these gates in order:

1. a closed structural validator checks type-specific fields, lengths, finite
   numbers, option ids, exact answer shapes, and rejects extra fields;
2. knowledge-point ids must be the original set or a strict authorized subset,
   and difficulty must be one of the server-provided values (currently `same`);
3. curriculum policy and text checks reject answer text, publisher, textbook,
   volume, chapter, page, regional-exam, policy, authentic-source, and material
   attribution claims;
4. deterministic normalization rejects exact copies, punctuation/spacing-only
   copies, reordered-choice copies, and extreme character overlap;
5. an independently injectable second-pass verifier must return a closed verdict
   with every required check true: same knowledge point, self-contained,
   answer-consistent, no student-facing answer leak, one exact answer or set,
   middle-school scope, and meaningfully different.

The duplicate and overlap checks are defense in depth, not a complete semantic
plagiarism detector. Here `verified` means only that the candidate passed this
system's structural checks, curriculum rules, duplicate defenses, and independent
second pass. It does not mean a formal mathematical proof, human expert approval,
absolute uniqueness, or zero-error guarantee. Numeric and exact-short questions
retain model-verification residual risk because this milestone adds no symbolic
solver. Rejection or verifier failure causes bounded regeneration; exhaustion is
`TRANSFER_QUESTION_GENERATION_FAILED` and exposes no rejected candidate or raw
provider/verifier output.

Every transfer question is synthetic by default and carries no source
attribution. Verified Materials may provide fenced background context, but a
material id, page, display name, or statement such as "the next answer is 42"
cannot become student-facing provenance or grading authority. The structural
answer validator and independent verifier, not material prose, decide whether a
candidate can be assigned.

### Durable assignment, answer, and result

The server appends `transfer_question_assigned` before publishing a
`transfer_question` terminal presentation. Its server-only event payload holds
the validated public question, private grading specification, and compact
verification metadata. The folded Coach state retains only assignment facts,
and the generic Runtime HTTP API continues to hide the entire Coach runtime
kind. Durable operation identity, event validation, RuntimeStore CAS, terminal
correlation, and exact-public-field comparison make assignment append and
presentation replay idempotent. An append failure publishes nothing.

`submit_transfer_answer` still has no student response or question id parameter.
It reads the raw answer from the current exact `TrustedAgentTurn`, appends one
`transfer_answer_submitted` for that durable message, and cannot consume a later
message or reuse the same message in another attempt. Evaluation then loads the
matching verified assignment and exact submission from server-only history.
The model cannot supply an outcome, answer key, or grading result.

Parsing and grading are deterministic pure server operations:

- single choice accepts an exact option id or a uniquely mapped display label;
- multiple choice deduplicates and orders parsed ids, then compares the exact set;
- numeric accepts only a finite canonical numeric literal and never evaluates an
  expression such as `1+2`;
- exact short answer applies bounded Unicode/whitespace and controlled case
  normalization, then compares only server-stored accepted strings.

The only outcome is `correct` or `incorrect`; there is no partial credit,
subjective approximation, semantic model grading, or LLM fallback. The server
records `transfer_answer_evaluated` against the exact submission and transfer
question before publishing a `transfer_result` with fixed text. Equivalent
retries replay one evaluation and one result; a changed outcome or causal target
conflicts. Neither result variant reveals the expected answer or solution.

Transfer facts remain phase-local: attempt count, durable message refs, hints,
key-hint use, answer-view flag, and outcome do not borrow original-phase help.
Transfer hints, when requested, use the same deterministic server templates and
never read the grading specification. Evaluation records only the outcome; it
does not set `isIndependent`, `mastered`, or any mastery percentage.

### Leakage boundary and stopping state

Private grading data and verifier internals may exist only in the server-only
Coach assignment event and ephemeral server evaluator input. They are excluded
from folded/public Coach state, `get_state`, terminal presentations, tool
content/details, Agent assistant transcript, session SSE, generic Runtime HTTP,
errors, logs, Skill context, and material prompts. Public presentation schemas
are closed and copy only allowlisted fields; durable tool event logging strips
guarded tool-result content and correlation metadata is removed before SSE.

After evaluation, Coach status is `finalizing` and the directive is
`PROJECT_STUDY_ATTEMPTS`. M2B-2A stops there: it does not call a StudyAttempt API,
append `study_attempts_projected`, set `completed`, or update progress. M2B-2B
will add StudyAttempt v2 projection, append the projection event, and only then
permit the existing state machine to reach `completed`.

## Milestone 2B-2A.1 authoritative original assessment

M2B-2B was blocked because the original phase had no complete authoritative
source for future `original.initialOutcome` and `original.finalOutcome` fields.
`student_attempt_submitted` durably stored the response but no correctness fact;
legacy `original_resolved` either carried one outcome or cited a full-solution
reveal without an outcome. With multiple submissions, that was insufficient to
recover both the first and final results. Correctness cannot be inferred from
attempt count, hints, key-hint use, answer viewing, or a transfer result.

M2B-2A.1 adds only the missing assessment authority and causal facts. It does
not change the `StudyAttempt` contract, write a `StudyAttempt`, build projection,
append `study_attempts_projected`, update `KnowledgeProgress`, or complete the
Coach session.

### Objective-only private authority

The first original-question authority supports exactly the same four objective
types used by transfer grading:

- `single_choice`;
- `multiple_choice`;
- `numeric`;
- `exact_short_answer`.

A typed original question is trusted learner input, not a trusted answer key.
When the first original submission needs evaluation, the server lazily runs a
bounded candidate generator, closed structural validation, and an independently
injectable second-pass verifier. These stages receive the original question but
never the student's response. A candidate may state only its supported type and
answer-key fields; it cannot declare itself verified or supply an outcome. The
server derives choice option ids, numeric tolerance, and short-answer case mode,
then accepts only a closed private grading specification whose required verifier
checks are all true.

Here `verified` has deliberately limited meaning: the candidate passed this
system's structural validation and independent consistency checks and may be
used by its deterministic evaluator. It does not mean a formal mathematical
proof, human-teacher approval, guaranteed uniqueness, absolute correctness, or
zero residual model risk. An unsupported question, invalid candidate, exhausted
generation, or failed verification produces a stable assessment error and never
causes the server to guess an outcome.

### Durable private assessment and deterministic evaluation

A verified assessment is appended as `original_assessment_prepared` before any
outcome is recorded. The server-only event binds its schema version,
deterministic assessment id, original-question fingerprint, supported type,
verification reference, private grading specification, and bounded verification
metadata. Its identity derives from the Coach session, question fingerprint,
and assessment version. Retries reuse the durable event; a competing assessment
with different grading facts conflicts instead of replacing the answer key.

The private specification is validated again when read and remains inside the
hidden Coach event stream and ephemeral evaluator input. It is excluded from
folded public state, model actions and results, tool details, terminal
presentations, assistant transcript, SSE, Skill context, ordinary persistence
HTTP access, and errors.

For each original submission, the server reads the already persisted response
and evaluates it with the same server-only grading-spec validation, option
parsers, exact-set comparison, canonical numeric parser, and short-answer
normalization used by transfer evaluation. Numeric input is never executed as an
expression, and there is no LLM, rubric, embedding, or semantic-grading fallback.
The result is exactly `correct` or `incorrect`.

The durable `original_attempt_evaluated` event cites the exact assessment and
submission. Evaluations are recorded in original-submission order, and one
submission cannot acquire two different authoritative outcomes. Deterministic
operation identities, fingerprints, replay checks, and RuntimeStore CAS recover
after an append/response interruption and fail closed on conflicting facts.
Before any full-solution resolution, an existing durable assessment must have
evaluated every persisted original submission. The resolution path first drains
that backlog, while both the service writer and state fold reject a bypassing
resolution event.

### Causal resolution and future projection sources

Committed M2B-2A.1 resolutions use `original_resolved` schema v2 and carry no
freely supplied outcome. M2B-2A.2 keeps those histories readable and uses schema
v3 for new writes so the stricter any-correct priority can be validated without
retroactively changing v2 history. `resolutionKind=evaluated_attempt` cites an
existing authoritative `correct` evaluation. `resolutionKind=full_solution`
cites the exact original `full_solution_revealed` event and records no
correctness.

The future projection source rule is therefore deterministic:

- `original.initialOutcome` comes from the first original submission's
  `original_attempt_evaluated.outcome`, which is also the earliest evaluation in
  authoritative event order;
- `original.finalOutcome` comes from the last original submission's
  `original_attempt_evaluated.outcome` before original resolution; an
  `evaluated_attempt` resolution cites the event-order latest authoritative
  `correct` evaluation, which may precede a later `incorrect` evaluation in a
  backlog that was submitted before assessment recovery;
- a missing evaluation for the first original submission makes the session
  ineligible for projection rather than permitting an inferred value.

This preserves histories such as `incorrect -> incorrect -> correct`: the first
evaluation supplies the future initial outcome and the last evaluation supplies
the future final outcome. It also handles a recovered `correct -> incorrect`
backlog without conflating resolution priority with F1: the resolution cites the
latest `correct`, while the last `incorrect` remains the future final outcome.
Help facts remain separate evidence for exposure and independence; they never
alter evaluator correctness.

`StudyAttempt` v1 admits the enum value `skipped` but does not define it as
"no final assessable submission after viewing a full solution." M2B-2A.1 did
not invent that meaning and initially left this case `NOT_PROJECTABLE_YET`.
M2B-2A.2 closes that ambiguity below by defining `finalOutcome` as the last
authoritative submission evaluation, not as the reason the teaching phase
ended. Viewing a full answer affects help exposure and independence facts, not
correctness, and never changes an evaluated outcome to `correct` or `skipped`.

### Unsupported originals and current stopping point

Open-ended, subjective, ambiguous, or otherwise unsupported originals are not
coerced into one of the four objective types. `ORIGINAL_ASSESSMENT_UNAVAILABLE`
settles that assessment attempt without exposing a candidate or private key. The
Coach may continue its existing deterministic hints, unlock and show an
authorized full solution, and continue to a separately verified transfer
question; that teaching flow remains useful because transfer has its own grading
authority.

Such a session still lacks a complete authoritative original outcome chain and
therefore cannot claim complete StudyAttempt projection or projection-backed
completion. M2B-2A.1 adds no model-writable eligibility flag and does not weaken
this fail-closed boundary to make M2B-2B appear complete.

## Milestone 2B-2A.2 original facts closure

M2B-2A.2 defines the remaining executable semantics and durable source classes
needed before StudyAttempt v2 projection can begin. It does not implement
StudyAttempt v2, write a StudyAttempt, append `study_attempts_projected`, change
`KnowledgeProgress`, or complete a Coach session.

### Executable M1 outcome semantics and F1

For an assessment-backed learning episode, M1 `initialOutcome` means the outcome
of the first actual student submission that received an authoritative
evaluation. M1 `finalOutcome` means the outcome of the last actual student
submission that received an authoritative evaluation before the phase resolved.
It is not a solved flag, completion status, resolution reason, or claim of
mastery. A resolved episode may therefore have `finalOutcome=incorrect` when the
student's last evaluated response was incorrect and the teaching phase later
ended by revealing the full solution.

The deterministic F1 selector applies that meaning to original Coach history:

- use `state.original.attemptEventIds` as the authoritative submission order;
- require one and only one `original_attempt_evaluated` event for every listed
  submission, in the same order and against the same durable
  `original_assessment_prepared` event;
- set `initialOutcome` from the first matched evaluation;
- set `finalOutcome` from the last matched evaluation before
  `original_resolved`;
- never sort by timestamps and never derive either outcome from hints, attempt
  count, answer viewing, generated solution text, or transfer performance.

For example, `incorrect -> hint -> incorrect -> full solution` projects
`initialOutcome=incorrect`, `finalOutcome=incorrect`, and
`viewedFullAnswer=true`. The reveal does not synthesize a third submission and
does not overwrite either evaluation. An `evaluated_attempt` resolution must
cite the event-order latest authoritative `correct` evaluation; that event need
not be the final evaluation in a recovered backlog. A
`full_solution` resolution cites only the reveal; F1 still obtains correctness
exclusively from the complete evaluation chain. If a recovered backlog is
`correct -> incorrect`, the resolution cites the first event as the latest
authoritative `correct`, while F1 remains `initialOutcome=correct` and
`finalOutcome=incorrect`.

This rule does not assign a new meaning to `skipped`. It also does not expand
`AttemptOutcome`: the closed M1 values remain `correct`, `incorrect`, `partial`,
and `skipped`. Current deterministic original and transfer evaluators continue
to emit only `correct` or `incorrect`.

### Answer viewing and resolution priority

`full_solution_revealed` changes `viewedFullAnswer` and the future independence
classification only. Its `explanation` and optional `finalAnswer` are
presentation facts, not assessment authority. A request without a persisted
reveal does not count as answer viewing.

Recovery must settle original facts in this order:

1. drain every evaluation that can be produced from an already durable verified
   assessment;
2. if any completed evaluation is `correct`, append or replay the causal
   `evaluated_attempt` resolution citing the event-order latest `correct`, even
   when a reveal was already persisted;
3. otherwise, when an authorized reveal exists, append or replay the causal
   `full_solution` resolution;
4. only after one authoritative original resolution may transfer assignment
   proceed.

The same priority applies to submit replay, `get_state`, full-solution replay,
transfer generation, and crash recovery. No continuation may make a reveal-only
window terminal by bypassing this settlement order.

### Durable unavailable authority and transient failures

An objectively unsupported original needs a durable server-owned fact rather
than repeated inference from a returned error. The implemented
`original_assessment_unavailable` fact binds the Coach session, assessment
version, original-question fingerprint, and a closed unsupported reason through
a deterministic server-owned operation identity. It is mutually exclusive with
`original_assessment_prepared`, carries no candidate answer, verifier prose, raw
provider error, or grading secret, and replays by deterministic causal identity.
Once this fact is durable, retries do not regenerate an answer key for the same
assessment version.

Only a terminal, validated unsupported result may create that fact. Provider
unavailability, aborts, malformed or rejected candidates, verifier failure,
RuntimeStore failure, and unresolved CAS competition are transient failures.
They must not be persisted as unsupported, must remain retryable, and must not
authorize projection. A transient error is absence of a completed authority
decision, not evidence that the question is unassessable.

### Future unassessed union

An unavailable original has no authoritative `initialOutcome` or
`finalOutcome`, so neither field may be filled with `incorrect`, `skipped`, or a
default. A future StudyAttempt v2 design must represent this with a closed
discriminated union outside `AttemptOutcome`:

- an assessed variant carries the F1 `initialOutcome` and `finalOutcome` backed
  by the complete evaluation chain;
- an unassessed variant carries the durable unavailable provenance and carries
  no fabricated outcomes.

The exact StudyAttempt v2 schema and persistence contract remain a later
milestone. M2B-2A.2 establishes only the authoritative facts and source rules;
it does not add the union to production domain types yet.

### Facts-closure Source Matrix

Legend: `P` means an authoritative persisted fact, `D` means a deterministic
derivation from persisted facts, `O` means intentionally optional/undefined,
`U` means intentionally unassessed, and `M` means a missing authoritative
source. The four columns describe future StudyAttempt v2 records; M2B-2A.2 does
not create those records.

| Future StudyAttempt v2 field | A objective + evaluated resolution | B objective + full-solution resolution | C unavailable original + evaluated transfer | D transfer |
| --- | --- | --- | --- | --- |
| `schemaVersion` | D constant | D constant | D constant | D constant |
| deterministic `id` | D from session/phase/version | D from session/phase/version | D from session/phase/version | D from session/phase/version |
| `coachSessionId`, `profileId`, `subjectId` | P start | P start | P start | P start |
| `knowledgePointIds` | P start | P start | P start | P verified assignment |
| `questionSummary` | D bounded start text | D bounded start text | D bounded start text | D public verified question |
| `questionSourceType` | D start source | D start source | D start source | D `generated` |
| `sourceMaterialId` | P or O from start | P or O from start | P or O from start | O |
| `sourcePage` | O | O | O | O |
| `attemptKind` | D `initial` | D `initial` | D `initial` | D `transfer` |
| `assessmentStatus` | D `evaluated` | D `evaluated` | D `unassessed` | D `evaluated` |
| `initialOutcome` | D from first P evaluation | D from first P evaluation | U | D from P transfer evaluation |
| `finalOutcome` | D from last P evaluation | D from last P evaluation; reveal ignored | U | D from P transfer evaluation |
| `unassessedReason` | O | O | P unavailable reason | O |
| `studentAttemptedBeforeHelp` | D causal order | D causal order | D causal order | D causal order |
| `hintsUsed`, `usedKeyHint` | D phase events | D phase events | D phase events | D phase events |
| `viewedFullAnswer` | D reveal fact | D true from reveal | D true from reveal | D false |
| `createdAt` | P first submission time | P first submission time | P first submission time | P transfer submission time |
| `errorType`, `durationSeconds` | O | O | O | O |

All four reachable projection scenarios therefore contain no `M` entry:
`MISSING AUTHORITATIVE SOURCE = 0`.
Prepared evaluation backlogs, transient failures, corrupt histories, and legacy
histories without the required facts remain outside the projection boundary;
they fail closed rather than being represented with an invented field value.

Transfer remains assessment-backed by its one durable submission and one
deterministic `transfer_answer_evaluated` event, so its future
`initialOutcome` and `finalOutcome` both come from that same evaluation. Original
and transfer help exposure, hint counts, key-hint facts, and answer-viewing facts
remain phase-local.

Implementation of StudyAttempt v2 may resume only after its Projection Source
Matrix contains zero `MISSING AUTHORITATIVE SOURCE` entries for every reachable
history it intends to project. An assessed history must have the complete F1
chain; an unassessed history must have the durable unavailable fact and the
future explicit union variant. Transient and conflicting histories remain
outside the projection boundary. `MISSING=0` is a hard gate, not permission to
substitute heuristics, defaults, or new `AttemptOutcome` values.

## Milestone 2B-2B durable StudyAttempt projection and completion

M2B-2B closes the server-side learning-record workflow. It deterministically
projects one original and one transfer `StudyAttempt` from authoritative Coach
history, persists and reads both records back through the existing
`RuntimeStore`, and only then appends `study_attempts_projected`. It adds no
model action, database, dependency, UI, review scheduler, prompt, or generation
step.

### StudyAttempt v2 and v1 compatibility

The public domain contract is now a versioned union:

```text
StudyAttempt = StudyAttemptV1 | StudyAttemptV2

StudyAttemptV2 =
  | EvaluatedStudyAttemptV2
  | UnassessedStudyAttemptV2
```

`StudyAttemptV1` keeps `schemaVersion=1`, its existing fields, closed-key
validation, outcome values, equality, persistence, and progress semantics. No
v1 record is migrated, and v1 does not accept `coachSessionId`,
`assessmentStatus`, or `unassessedReason`.

Both v2 variants carry the common long-lived learning facts and a required,
trimmed, bounded `coachSessionId`. The evaluated variant carries
`assessmentStatus=evaluated` plus required `initialOutcome` and `finalOutcome`,
and forbids `unassessedReason`. The unassessed variant carries
`assessmentStatus=unassessed` and the closed durable reason
`unsupported_question_type`, forbids both outcome fields, and is reachable only
for `attemptKind=initial`. Transfer is always evaluated; an unassessed transfer
or review record is invalid. Variant-forbidden fields are rejected even when a
caller explicitly supplies them as `undefined`, and every variant remains
closed to additional fields. `AttemptOutcome` is not expanded with an
`unassessed` value.

### Projection authority and source rules

The projection boundary accepts raw durable Coach `RuntimeRecord` values, not a
caller-constructed `CoachState`, outcome summary, or plain-object facts. It
sorts records by durable sequence, validates every payload, folds the validated
events, requires `finalizing`, and then proves all cited source events and
profile/session relationships before constructing a plan. Missing, ambiguous,
corrupt, transient, or conflicting facts fail closed with a stable projection
error; they are never replaced by defaults.

The executable four-class Source Matrix is:

| Projection class | Original record | Original outcomes | Transfer record |
| --- | --- | --- | --- |
| A. objective + evaluated resolution | `evaluated`, `initial` | first authoritative evaluation; final outcome from the evaluation cited by the causal evaluated resolution | verified assignment plus deterministic evaluated submission |
| B. objective + full-solution resolution | `evaluated`, `initial` | F1 first and last authoritative evaluations before resolution; reveal changes exposure only | verified assignment plus deterministic evaluated submission |
| C. unavailable original + evaluated transfer | `unassessed`, `initial`, reason from durable unavailable fact | intentionally absent; never inferred as incorrect or skipped | verified assignment plus deterministic evaluated submission |
| D. transfer | `evaluated`, `transfer` | one deterministic transfer evaluation supplies both initial and final outcome | same Coach session and authoritative transfer knowledge points |

For every class, identifiers and summaries are deterministic derivations;
profile, subject, knowledge-point, source, submission time, evaluation, and
unavailable facts come from validated durable events; unavailable outcomes and
fields without authoritative lineage remain intentionally absent. The matrix
therefore retains `MISSING AUTHORITATIVE SOURCE = 0` without guessing. F1 never
turns a full-solution reveal into `correct` or `skipped`, and original and
transfer help exposure remain phase-local.

### Deterministic identity and canonical projection

Each Coach session can project one ordinal original record and one ordinal
transfer record. Their IDs are domain-separated SHA-256 derivations of the
Coach session, phase, and projection ordinal. Replays produce the same IDs;
different sessions or phases produce different IDs. IDs do not depend on
randomness, current time, chat identity, tool-call identity, or model output.

Each v2 record has an explicit canonical serialization covering every persisted
field, including the variant discriminator and reason or outcomes. Knowledge
point ids are canonicalized before persistence. Optional absent values have a
fixed representation, and no caller property-insertion order participates in
the digest. The per-attempt fingerprint covers only long-lived learning facts.
It excludes raw answers, grading specifications, answer keys, verifier output,
expected revisions, provider data, and current time.

`projectionRef` is a separate domain-separated SHA-256 derivation over the
projection version, Coach session id, original attempt id and fingerprint, and
transfer attempt id and fingerprint. A fact change changes the relevant
fingerprint and projection reference; an expected revision or tool-call id does
not.

### StudyAttempt write authority

The entire `zhongkaoStudyAttempt` runtime kind is server-only, like the Coach
event kind. The generic browser persistence route cannot create its session,
discover or list it, read its records, append evaluated or unassessed payloads,
change its status, or delete it. This closes both v2 forgery and overwrite paths
and also removes the unauthenticated legacy v1 write surface; the repository has
no production browser-side StudyAttempt producer that requires that path.
Server-owned projection continues to use the shared payload validator and the
existing server `RuntimeStore` adapter.

### Bounded CAS, read-back, and saga recovery

Projection reuses the existing learner/profile partition:
server owner authority derives `learnerKey`, `profileId` derives
`zhongkaoStageId`, and the existing `zhongkaoStudyAttempt` session stores the
append-only facts. The model and client never choose owner, learner, stage, or
projection partition.

For each deterministic attempt id, persistence follows three cases:

1. missing: append with atomic expected-last-sequence CAS;
2. present with canonically identical facts: return replay success;
3. present with any different fact: fail with
   `STUDY_ATTEMPT_PROJECTION_CONFLICT` and never overwrite or merge.

CAS loss triggers a bounded reread-and-retry policy. An identical winning write
is success, a conflicting winner is a stable conflict, and a still-missing
record may retry only within the bound. Historical identical duplicate ids
remain one logical M1 fact, but the projector does not intentionally create new
raw duplicates. Every append, including an append whose response is uncertain,
must be followed by an authoritative reread. Persistence succeeds only when
read-back finds the deterministic id and exact canonical facts.

The fixed saga order is:

1. load, validate, and fold raw Coach records;
2. build one deterministic projection plan;
3. persist and read back the original attempt;
4. persist and read back the transfer attempt;
5. reread both and verify their fingerprints and `projectionRef` against the
   unchanged plan;
6. append the causal `study_attempts_projected` event;
7. refold Coach history and confirm `completed`.

The projected event is never written first. If original persistence fails, no
projection event exists. If transfer persistence fails, the identical original
remains and replays on retry. If both attempts persist but the projected event
loses CAS or fails, both replay identically and the event is retried. If the
event commits but the response crashes, retry verifies the completed projection
instead of writing another logical attempt or projected event. No process-local
mutex is used as a correctness boundary.

Concurrent workers derive the same plan. CAS losers reread the winner and may
continue only when it is identical. The converged result is one logical
original, one logical transfer, one logical `study_attempts_projected` event,
and one completed Coach state. Conflicting deterministic ids fail closed while
the Coach remains `finalizing`.

### Completed integrity and meaning

`completed` is reachable only after the durable attempts have been verified and
`study_attempts_projected` has committed. Its meaning is exactly: the Coach
workflow's durable learning projection is complete. It does not mean mastered,
stable, independently correct, ready for an exam, or exempt from review.

A completed replay must reconstruct and verify the projected event,
`projectionRef`, deterministic original and transfer ids, both persisted
records, and both fingerprints. A missing or conflicting attempt after a
completed event is corruption and fails closed; completed is not returned on
the strength of the state label alone.

An unsupported original may still complete the workflow. Its original v2
record honestly remains unassessed with no outcomes, while its separately
verified transfer record remains evaluated. Once both are persisted and the
projection event commits, the Coach may become completed without claiming that
the original response was correct or that the student has mastered the point.

### Progress, privacy, and zero-LLM projection

`KnowledgeProgress` treats v1 and evaluated v2 records through the same existing
outcome logic. Unassessed v2 records contribute no incorrect observation,
assisted correct, independent correct, recent evaluated observation, or mastery
transition. Their learning/help facts remain durable evidence, but a knowledge
point with only unassessed attempts remains `unobserved`. In particular,
`isIndependentCorrectAttempt` always returns false for unassessed records, and a
single independent transfer success still cannot produce `stable`.

Projected records contain only bounded long-lived learning facts. They contain
no raw original or transfer response, expected answer, accepted-answer list,
option key, tolerance, private assessment, full-solution text, verifier output,
hidden reasoning, source-material body, mastery flag, or client-declared
independence. Projection, fingerprinting, persistence, recovery, completion,
and terminal presentation have zero LLM dependency. The server triggers them
automatically after transfer evaluation or during an authorized finalizing
resume; no student answer is consumed again and no model action can mark a
session complete or mastered.

## Milestone 3A-1b immutable Exam intake

M3A-1b introduces `ExamSession` as a long-lived domain that is separate from
Coach events, StudyAttempt facts, Agent Session metadata, and
KnowledgeProgress. Its only ready state is `ready_for_extraction`, meaning that
the declared raw materials have been frozen and read back with matching byte
lengths and SHA-256 digests. It does not mean that a PDF was parsed, a response
was recognized, an answer was verified, grading occurred, or a diagnosis was
produced.

### Roles, identity, and authority

An intake has exactly one `question_paper`, at most one `student_response`, and
at most one `answer_key`, in that canonical order. These are user-declared
document-role facts only. In particular, `answer_key` does not create a grading
specification or authoritative answer, `student_response` does not confirm
recognized student text, and `question_paper` does not confirm question
structure or source attribution. M3A-1b performs no semantic read or model call
over any document.

The server derives the Exam id with a domain-separated SHA-256 digest over the
owner-derived learner partition, profile id, bounded client request id, and
Exam schema version. The client does not choose the owner, learner, stage,
Exam-document ids, operation ids, event ids, object keys, digests, lengths, or
status. Title is bounded display metadata and does not affect Exam identity;
it does participate in the semantic request fingerprint, so replaying one
request id with a changed title, subject, or document set is a conflict.
Document order in the request does not affect identity or replay.

The dedicated API reuses the trusted request owner, derives the learner key,
and requires an existing profile in that partition before intake. Exam events
use the server-only `zhongkaoExamEvent` RuntimeStore kind. This kind is
deliberately excluded from the generic Zhongkao long-lived helper and from all
generic persistence HTTP create, discovery, read, append, status, and delete
surfaces. Only the dedicated Exam service and `POST/GET/DELETE
/api/zhongkao/exams` routes can access it.

### Immutable snapshots and intake saga

Every source is re-resolved as an active, ready, same-owner source material.
The source row is locked against deletion while the byte object is read and
its actual length and SHA-256 digest are compared with durable metadata. A
snapshot read that obtains the row lock first may finish from its captured
buffer; a deletion that tombstones first makes a new intake fail closed.

Snapshot objects use a separate non-reversible namespace:

```text
materials/v1/exams/exm_<sha256>/doc_<sha256>/raw
```

Raw owner, profile, Exam, material, title, and filename values never become
path segments. Each `examDocumentId` is a deterministic digest of the Exam id,
role, and document schema version. The intake sequence is fixed:

1. authorize and verify every owner source;
2. append `exam_created` as the immutable intake plan;
3. write each deterministic snapshot key and read it back;
4. append one `exam_document_snapshotted` fact per verified object;
5. recheck every object and append `exam_intake_completed`.

`exam_created` therefore precedes every new Exam byte. An existing matching
object recovers a bytes-before-event crash without another write; an existing
different object is a document conflict and is never overwritten. A durable
snapshot event whose object is missing or different is integrity failure, not
permission to recreate an authoritative fact. Replays resume one logical Exam,
one deterministic object per declared role, and one deterministic operation
per logical event. The RuntimeStore session remains active after intake so a
later delete can append its lifecycle facts.

A database advisory mutation lock serializes all intake and delete callbacks
for one Exam. The advisory lock uses a small dedicated connection pool, so a
callback can use the existing provider pool without exhausting that pool with
its own outer locks. This prevents a stale intake writer from putting bytes
after a delete sweep. RuntimeStore compare-and-append remains the durable event
CAS; the byte store and RuntimeStore are intentionally joined by the
recoverable saga rather than represented as one false cross-store transaction.

### Independence, server resolver, and public data

Exam snapshots are owned by the Exam lifecycle. They do not point at owner raw
objects or Agent Session snapshots. Deleting the original OwnerMaterial or an
Agent Session after intake cannot remove or invalidate a ready Exam. A future
server pipeline may call the server-only Exam snapshot resolver, which reloads
and folds the private history, checks owner/learner/profile partition facts,
derives the exact key, reads the object, and verifies its digest and length.
M3A-1b exposes no generic raw download route and sends no Exam bytes to an
Agent, tool, SSE stream, transcript, Skill, extractor, or model.

The public DTO contains only Exam/profile/subject identity, optional title,
ingestion status, creation time, and per-document id, declared role, safe
display name, MIME type, length, and snapshot status. It excludes owner and
learner identities, owner material ids, client request ids, digests, object
keys, filesystem paths, RuntimeSession ids, event or operation references,
claims, leases, answer content, grading facts, and verification claims.

### Delete, bounds, and stopping point

Deletion appends `exam_delete_requested`, deletes every exact key derivable
from the immutable plan (including bytes written before a missing snapshot
event), optionally sweeps only that hashed Exam prefix, verifies absence, and
then appends `exam_deleted` while completing the RuntimeStore session. A crash
or byte-store failure leaves `deleting` and is retryable; repeated DELETE is
idempotent. Private RuntimeStore history is retained and is never deleted as
the first lifecycle step. Missing, foreign, malformed, and deleted Exam reads
share not-found semantics, and public errors never contain locators, digests,
paths, or raw causes.

The first intake is limited to one to three supported documents, 50 MiB per
document, and 50 MiB total. Supported storage MIME declarations are PDF, PNG,
JPEG, WebP, and plain text; accepting bytes does not assert that a later
extractor can recognize them. Existing owner-material quota accounting does
not include independent Exam copies, so a unified cross-Exam storage quota is
explicit follow-up work. The per-Exam caps close this milestone's unbounded
single-request copy path without introducing a second quota database.

M3A-1b adds no OCR, PDF or region extraction, question matching, response
recognition, answer authority, grading, knowledge-point mapping, observation,
diagnosis, recommendation, StudyAttempt write, Progress mutation, Coach
behavior, UI, upload system, production dependency, or LLM call. M3A-2 may
consume only bytes returned by the verified server snapshot resolver and must
define its own extraction and semantic-authority contracts.

## Milestone 3A-2A text-native Exam question extraction

M3A-2A reads only the verified immutable `question_paper` snapshot of a ready
Exam. The first adapter accepts `application/pdf` and requires a usable native
text layer. It opens the PDF with local `unpdf`/PDF.js, streams each page's text
content, and reads one page at a time without ever materializing or merging all
pages, so the PDF page index is
the source of `pageNumber` and each page retains its own ordered text blocks.
Page objects are cleaned up before the next page is read, and page, item, block,
text, candidate, diagnostic, and serialized-byte limits are enforced. The
adapter has no stable bounding-box, formula-node,
table-node, or image-marker contract; those fields are omitted rather than
fabricated. A PDF without enough extractable text fails with a stable
text-extraction-unavailable error. There is no OCR, vision, cloud provider, or
model fallback.

### Versioned derivatives and recovery

The raw Exam snapshot remains the only source authority. Extraction creates
two separate Exam-owned JSON derivatives beneath the same hashed Exam/document
namespace: a versioned document artifact and a separately versioned question
candidate artifact. Both have closed schemas and deterministic canonical JSON.
Neither large payload is stored in RuntimeStore events or exposed through the
public Exam DTO.

The event stream records an extraction plan before document bytes and a
segmentation plan before candidate bytes. Each completed fact contains only
bounded algorithm/version identifiers, opaque deterministic references,
source fingerprints, byte length and SHA-256 integrity facts, plus page or
candidate counts. Writes use deterministic exact keys, read back the object,
and verify bytes and closed schema before appending completion. A retry after a
bytes-before-event crash recomputes the deterministic result and requires an
exact match. Once a completion fact exists, missing or changed bytes are
corruption and are never silently regenerated.

Extraction and deletion share the per-Exam mutation lock. Delete removes raw
snapshots and every derivative key derivable from persisted plans before the
Exam becomes deleted. A delete that linearizes first prevents extraction from
writing; extraction that finishes first is fully reclaimed by the following
delete. No deleted Exam can be restored by a late extraction event.

### Artifact and candidate semantics

`ExamDocumentArtifactV1` preserves source fingerprint, MIME type, actual page
count, page order, page-local block order, and source text. Normalization is
limited to stable Unicode, line-ending, and bounded whitespace handling that
does not rewrite mathematical meaning. Page dimensions and bounding boxes are
absent when the extractor does not supply a reliable coordinate contract.

The deterministic segmenter detects section headings separately from question
markers, normalizes full-width digits and punctuation for matching while
retaining each raw label, and represents a locator as section path, printed
number, and subquestion path. Parent questions with `(1)`, `(2)`, and similar
children become a group plus leaf candidates; shared parent text remains
traceable rather than being copied as invented child content. Every candidate
has page/block source spans, and an active question may continue across pages.
Candidate text is derived only from those spans.

Duplicate normalized locators remain as separate ambiguous candidates; the
system never chooses the first occurrence. Gaps, orphan subquestions, empty or
oversized bodies, duplicate locators, and low text coverage produce closed
structural diagnostics and qualitative confidence bands, not probabilities.
The resulting records are `ExamQuestionCandidate` facts, not confirmed
questions. They contain no correct answer, grading specification, knowledge
point, difficulty, diagnosis, or student-performance conclusion.

The dedicated extraction endpoint accepts either no body or the closed JSON
object `{}` and lets
the server select the question-paper document and frozen algorithms. Public
Exam detail may expose only extraction status, page count, candidate count, and
whether structural review is needed. Server-only resolvers reauthorize the
owner/profile partition and verify derivative length, digest, schema, source
fingerprint, and deterministic reference before returning structured data.
There is no public raw artifact or candidate endpoint in this milestone.

M3A-2A never resolves or reads `answer_key` or `student_response` bytes and
never imports an Agent runner, Skill, `AICallFn`, model provider, or model SDK.
It performs no answer matching, grading, diagnosis, KnowledgeProgress or
StudyAttempt mutation, Coach behavior, or UI work. A later M3A-2B may consume
verified candidates, while confirmation and semantic authority remain a later
human-review milestone.
