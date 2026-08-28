# 2027 Zhongkao Coach: Milestone 1

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

## Milestone 2 scope

The next milestone can add the smallest student-facing entry flow on top of
these contracts: a zero-profile study start, attempt capture, first-help
behavior, explanation-to-transfer transition, and exploration-plan wording.
It should continue to use the existing materials, quiz, agent runtime, i18n,
and UI boundaries rather than introducing parallel infrastructure.
