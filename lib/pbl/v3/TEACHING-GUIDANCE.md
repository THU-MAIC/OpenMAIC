# Product-aware teaching and assistance

The shared teaching runner combines three existing layers: role-scoped course
materials, authoritative orchestration state, and registered tools. Product help
uses those same layers; it does not add another teaching step, shared role memory,
requirements panel, or general-purpose support Agent.

## Where the instructions live

| Responsibility | Source |
| --- | --- |
| Shared product facts, role responsibilities and answer boundaries | [product-context.ts](../../server/pbl-v3/product-context.ts) |
| Prompt assembly, assessment/repair context and per-request live state | [teaching-prompt.ts](../../server/pbl-v3/teaching-prompt.ts) |
| Project welcome, milestone opening, pacing and assessment rules | [skills.ts](../../server/pbl-v3/skills.ts) |
| Built-in progressive teaching, plan, code and recap sections | [teaching-sections.ts](../../server/pbl-v3/teaching-sections.ts) |
| Bound course Skills/documents and source permissions | [project-package.ts](../../server/pbl-v3/project-package.ts) |
| Tools, observations and atomic teaching receipts | [runner-tools.ts](../../server/pbl-v3/runner-tools.ts) |
| Review, current-version approval and assistance state | [guided-review.ts](../../server/pbl-v3/guided-review.ts) |
| Durable assistance input exclusion and response display | [review-question.ts](../../server/pbl-v3/review-question.ts) |

`learner-actions.ts`, `edit-access.ts` and `presentation.ts` supply the existing
transition gates, editing policy, task-drawer availability and disabled workbench
features to both the learner view and Agent guidance. These projections do not
grant authority. Host tools still enforce permissions, versions and completion.

The live context refreshes after tools. It includes the current role/step, task
contents, available actions, stage editing permissions, pending evaluation,
recorded environment readiness, registered tools and files actually observed in
this turn. A file list is marked complete only after a successful list operation.
The Agent cannot see pane visibility, selected tabs, viewport or neighboring
classroom scenes. It must describe named controls conditionally, rather than
claiming to see the learner's screen. Environment readiness is a recorded
observation, not a fresh provider inspection on every model request.

## How a turn is handled

- Project welcome stays inside the first teaching step. It introduces the project,
  first milestone and learning format, then asks readiness once. Background/product
  questions preserve that readiness question. They do not start formal teaching.
- Every formal milestone opening describes the outcome before teaching concepts,
  avoids repeated explanations, and ends with one recorded question.
- Normal teaching/review uses the existing Skill and current-version evidence
  protocol. A mixed turn containing an actual review answer plus a help request
  can answer the help request and use that actual answer through normal review tools.
- An assistance-only turn in a guided step uses `respond_to_learner`. The same
  atomic handoff mechanism records its response and ends the turn. It preserves
  the pending review, section, coverage and approval. Its source input remains in
  conversation/report history but is excluded from later understanding/approval
  candidates. Recovery recognizes the committed receipt without generating again.
- Decision and assessment stages answer help directly. Decisions, tests and quizzes
  still require their controls; help does not create another oral review gate or
  reveal quiz answers.
- Project-related conceptual questions can go beyond the current Skill question.
  Unrelated requests are redirected briefly. Missing/ambiguous UI information calls
  for an explicit uncertainty statement and necessary clarification, not an invented
  button, tool result or staff notification.

The model still judges whether a natural-language turn is assistance-only or mixed.
The host guarantees the consequences of a committed assistance receipt; it does not
claim to perfectly classify arbitrary learner language. Assistance cannot be
committed after advancing a section in the same turn.

## Requirements, contracts and assertions

An authored contract describes required behavior and interfaces. Explain relevant
parts as the learner's task, observable outcomes and constraints. Do not imply the
learner wrote that authoring material or must edit it. A technical term can be
introduced with an explanation when it helps the task.

Evaluation assertions check behavior. Private tests, expected outputs, answer keys
and rubric preferences remain evaluator/author inputs, not student-editable files
or a shortcut to a pass. Public examples and ordinary programming assertions may
be discussed when relevant. A build pass, test pass, understanding, approval,
autosaved file and project completion are distinct records.

Skill/tool/thinking cards keep their existing expandable presentation. Returned
Skill sections and reference documents are therefore learner-visible. A document
being absent from the IDE does not make it secret. Do not place private answers in
those payloads, or require a tool card as a substitute for a requirements panel.

## FS content PR checklist

These are course-specific follow-ups, not requirements to redesign the shared host:

1. **Course structure and starts.** Supply the independent introductory course and
   four FS project courses. Give each its own Hero metadata and final PBL scene.
   The introductory course explains the activity, programming basics and learning
   format, with an unrelated minimal practice project. The four FS courses cover
   layering/interfaces, session state/concurrency, persistence, and simplified
   fault tolerance/resource budgets. Put the relevant prerequisites in preceding
   scenes, sized for learners who may have no programming experience.
   Each project must start from its authored starter snapshot; later projects use
   the preceding projects' correct baseline, regardless of a learner's other
   attempts. Each internal milestone keeps the supported seven-step sequence.
   Release order must not become a prerequisite requiring learners to complete
   earlier projects first. Keep project identity and completion records distinct
   for participation tracking; promotion/rewards are outside this teaching change.
2. **Student-facing requirements.** For every milestone, write a concrete outcome,
   visible behavior, required interfaces and necessary constraints. Decide which
   explanations belong in preceding scenes, the opening, or an intentionally
   visible source/document. Agent reference documents are not automatically IDE
   files. Do not invent a contract/assertion drawer or ask learners to edit tests.
3. **Every bound Skill and reference.** Inspect root Skills, all progressive sections,
   role prompts, stage instructions, reference documents and starter comments.
   Delete stale UI locations, terminal/preview commands, manual setup/checkpoint
   instructions and duplicate openings/questions. Keep project welcome separate
   from formal milestone teaching, and credit already demonstrated understanding.
   Course instructions must not contradict the shared product/assistance policy.
4. **Role scope and evidence.** Bind the appropriate material to each stage/role.
   Keep discussion neutral about choices, Planner focused on PLAN.md, Coder on
   permitted source, and Mentor on recorded assessment/reflection evidence. Check
   reading permissions, source roots and cumulative PLAN update modes. Do not
   bridge private role conversations or substitute readiness/help for approval.
5. **Assertions and teaching causality.** Derive checks from observable requirements,
   accept legitimate alternative implementations/wording, and ensure relevant
   decisions have real implementation consequences. Test claims such as interrupted
   writes and process restart with those actual conditions. Include negative cases
   and public failure categories that let learners understand what to repair,
   without exposing expected answers. Check the business UI displays intended
   fallback responses rather than silently dropping them.
6. **Runtime and fixtures.** Pin the chosen project's JDK, dependencies, source tree,
   entrypoints and deterministic fixtures; verify the prepared template actually
   supplies them. Exercise builds, formal tests and repair through the public
   host path. Distinguish learner implementation failures from dependencies,
   fixtures and provider failures. Do not add guessed platform workarounds to Skills.
7. **Materials and package audit.** Keep private evaluation descriptors, expected
   outputs and answer/rubric files out of source staging, role seeds and expandable
   Skill/tool payloads. Verify exported/imported packages and role bindings. Check
   the complete authored model input against the selected model's actual capacity
   during real FS integration; do not add arbitrary teaching reply/tool/time limits.
8. **Acceptance conversations.** Across all roles, test absent controls, hidden
   panes, editing locks, save problems, early report requests, requirement/test
   mismatch, deep relevant questions, unrelated questions, and mixed review/help.
   Run each course from Hero to final report, including test failures, repair,
   current-version reapproval, re-entry and returning from the report. Confirm
   help does not restart the lesson or advance learning. Coordinate live provider
   lifecycle acceptance separately with its owner; this PR changes no reclamation
   policy.

Static policy and deterministic tool tests cannot prove every natural-language
reply or every future course. Keep representative real-model conversation checks
alongside complete course acceptance and revise any contradictory course material
at its source.
