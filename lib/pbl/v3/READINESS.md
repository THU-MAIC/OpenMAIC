# Course readiness checklist

This is the scope audit for the general learning experience before integrating real
course content. It separates behavior already present on the integration baseline
from the remaining changes in this PR. Passing local checks does not establish live
model quality, provider acceptance or classroom capacity.

## Teaching behavior carried forward

The earlier OpenPBL pre-decision, plan-review and implementation-review Skills are
the behavioral reference. `teaching-sections.ts` adapts their sections, while
`skills.ts`, `teaching-prompt.ts` and the existing runner tools enforce the current
host contract. Course-specific Java names, legacy file tools, process topology and
release operations are not copied.

| Step | Preserved behavior and host adaptation | Work in this PR / audit result |
| --- | --- | --- |
| Teaching | Discussion A/B/C starts proactively, introduces the current milestone, discloses one section at a time and withholds formal decision answers. | Begin the project with a compact welcome inside the first step, withholding lesson materials until actual readiness; background questions do not start teaching. Keep fresh-response gates for genuinely new questions. Help-first rules also apply to a bare “I don't know”; a conflicting instruction in section B is removed. |
| Decisions | Explain offered options and consequences; only the learner's explicit control submission records a choice. | Add explicit neutral-option rules, including no recommended/correct answer hints. A milestone with no decisions remains a normal, immediately continuable decision step. |
| Plan | Planner A/B/C/D writes and reviews the actual PLAN, retains earlier approved content in incremental mode and binds approval to the current artifact. | A specific requested edit by the Planner counts as participation. Help comes before another question. Final approval summarizes established reasons and asks for a brief fresh confirmation, without repeating the entire review. Changed plans require new review. |
| Code | Coder A/B/C/D implements the approved plan, reads real files, checks one key path and a consequential risk, and makes necessary repairs. Configured compile gates remain separate from tests. | Preserve the baseline non-repetitive review, read/hash/write tools and current-version final confirmation. Shared help-first and completed-follow-up rules also apply here. |
| Tests | Assessment controls run and automatically collect actual results. Failures can be repaired and retested; infrastructure errors are not learner errors. | Expected output stays on the server; the sandbox returns actual-output digests, exit state and bounded failure reasons. Complete, current-run results are required. No extra oral gate is added. |
| Quiz | Answers stay private before submission; failed attempts can be retried, with progress controlled by the saved result. | Preserve judging and feedback. Fix sparse answer arrays so selecting a later question cannot enable submission with earlier questions unanswered; keep unsubmitted choices on scene return/refresh. |
| Recap | Mentor reflection uses actual decisions, artifacts and observed assessments, and accepts a substantive reflection without repeating completed topics. | Final milestone's final recap completes the project through `complete_stage`; only then is the report button available. Prompt handoff and the tool use the same boundary check. |

Across all guided steps, meaningful participation is not a keyword test or fixed
number of questions. New questions still require real new learner replies; sections already covered by
correct same-stage, same-version answers may reuse that verified feedback without
repeating the question. Explicit confident understanding is sufficient absent
unresolved errors, and an existing current-version approval is not requested twice;
automatic openings, retries and assistant text do not supply them. Follow-up chat
does not reopen completed teaching, while changed evidence invalidates affected
approvals. Roles know the next step without performing another role's work or
advancing for the learner.

Implementation and regressions: `skills.ts`, `teaching-sections.ts`,
`teaching-prompt.ts`, `guided-review.ts`, `stage-progress.ts`, `runner-tools.ts`;
`tests/pbl/v3/{conversation,guided-review,stage-progress,teaching-context}.test.ts`
and the real-PG scripted-runner journeys in `runtime.pg.test.ts`.

## Complete delivery scope

| Area | Existing baseline retained | Changes / regression coverage in this PR |
| --- | --- | --- |
| Progression and tool receipts | Seven steps, validate-before-completing, real feedback, cancellation/takeover fences, mixed-tool batches, automatic openings, ordinary follow-ups and no generic-API bypass. | Keep these gates; full scripted journeys verify them with the report boundary. Do not reimplement the runner. |
| Private materials | Owner and role-scoped project resources and structured public assessment diagnostics. | Keep expected output out of sandbox arguments and evaluation descriptors out of test support. Keep OpenPBL thinking previews/full-text expansion and full tool payloads in live projection and replay. Report evidence strips private protocol and transport fields. |
| Workbench layout | Left IDE/right assistant, file tree/tabs/editor, terminal/output/preview, normal and expanded scene, light/dark styles and contextual controls. | Restore debounced automatic file saving with compact status; remove the learner checkpoint button and application preview; hide shell/terminal controls behind a fixed-off activity flag while retaining build/test feedback. Fix compact solo-pane height; collapse the file tree independently from its own header while retaining the editor buffer. Preserve study-scoped files/chat/quiz drafts and pane visibility; refuse stale environment writes and preserve newer typing across late acknowledgements. |
| Current-task controls | Actual milestone/step, no empty drawer for teaching/recap, current decisions/artifacts/tests/quiz only, green usable actions and disabled reasons. | Hide unknown 0/0 counts, preserve full tab names, fix incomplete-quiz submission, verify task drawer close/Escape/focus and composer usability in short and narrow viewports. |
| Agent interaction | Waiting/thinking/tools/text/status order, role colors and stage dividers, snapshot replacement, copy, fold, send re-anchor, manual history scroll, cancel and retry. | Thinking previews expand to the full text; tool groups stay open until manually folded, and individual tool details start collapsed. Keep animated feedback through request admission, queued work and gaps between text/tool parts until the turn settles. Test status covers admission, execution and result collection, including explicit failure/retry. Browser fixtures retain the baseline behaviors and check drafts after actual scene unmount and reload. |
| Terminal contention | Existing identity, environment epoch, terminal identity, Stop and stage boundaries. | Avoid the long study lock per keystroke. Retry only confirmed pre-dispatch `ENVIRONMENT_BUSY`, with a finite budget; never replay unknown input. The actual workbench request transport preserves the error reason consumed by that retry logic. |
| Hosted entry and restore | Same durable allocation identity and saved learning progress. | Entry automatically prepares the installed project's environment, reuses a ready workspace, and opens teaching without a setup click. Setup is attempted once per observed environment on entry, with explicit retry after failure. Inspection remains read-only; scoped setup owns restore. Completed reports do not boot a sandbox. |
| Project application preview | The baseline included a workbench tab, default ports and study-bound gateway grants. | Remove these v3 features and their wiring entirely. Old learning preview tickets are denied. Generic sandbox preview remains separate; the actual course frontend is later integration work. |
| Editing permissions | Stage actions and active Agent execution restrict writes. | Share stage/writer/evaluation gates across the IDE, workbench and host saves. Show distinct read-only reasons through Monaco's cursor-side message on an editing attempt, without a permanent footer. Failed-test coder repair remains in the test step; running tests/builds also fence Agent write tools. |
| Request feedback | Many operations only disabled controls until their response returned. | Immediately show operation-specific loading/waiting feedback; select file tabs immediately, acknowledge pending decisions and roll them back on failure. Server receipts still own progress and results. |
| CI configuration | Existing workflows and integration targets. | Remove only the obsolete workspace-contract feature branch entries. |
| Cross-milestone work | Same source workspace, incremental PLAN, project/milestone role context, source fingerprinting and explicit checkpoints. | Current Python and Java samples each have two normal seven-step milestones. Real-PG/local-toolchain journeys cover edit/run/stop/save/review/tests/next/restore, newly created sources, stale evidence and recovery to an earlier repairable position. No zero-loss promise for unsaved remote work. |
| Reports | Existing state, artifacts, assessments, events and durable role history. | Save process evidence and a completion-gated report, with factual metrics, cited qualitative findings, exact learner quotations, explicit missing/truncated evidence and retryable generation. Reads do not consume a model or provision a sandbox. Return to the workbench and reopen the saved report. Friendly versions replace the internal fingerprint label. |
| Compatibility | Ordinary classroom scenes, v2, course authoring Agent and non-PBL sandboxes continue using their existing routes. | Exercise v2 and generation/runner regressions alongside the shared sandbox suite. Draft caching is confined to v3; the host canvas and shared chat/terminal components are reused. |

Every milestone uses the normal seven-step workflow and ends in reflection. There
is no exploration path, optional-milestone completion exception or separate intro
stage. No real learners or released v3 courses exist to migrate: obsolete local
fixture definitions, intro states and report-cache formats are not preserved.
Current study pinning, page refresh recovery, sandbox recovery and shared host
migrations retain their normal ownership and concurrency protections.

The report contract supersedes an earlier suggestion to expose reports before the
whole project finishes. A final recap tool receipt is required; an ordinary text
handoff, an intermediate recap or viewing a report cannot complete the project.

## Verification and limits

- `tests/pbl/v3` and `tests/sandbox`: actual PostgreSQL in an isolated test database,
  scripted runner/model fixtures and local Python/Java execution. The package
  toolchain journeys require `PBL_PACKAGE_TOOLCHAINS=1`; external acceptance tests
  are excluded. This is not a real model or cloud-provider run.
- `tests/pbl/v3/local-drafts.test.ts`: mounted editor/UI hooks, scene unmount/remount,
  study isolation, replaced environments, late acknowledgements and unavailable
  browser storage. Local drafts are not server-side submissions or checkpoints.
- The two `e2e/tests/pbl-v3-*.spec.ts` journeys use real Chromium and classroom pages
  with API fixtures: layout, drafts, scroll/fold/focus, execution controls, test/quiz
  feedback, held-response loading/selection, decision failure rollback, and saved-report navigation. Screenshots in this directory are fixtures.
- Compatibility checks cover `tests/pbl/v2`, v2 scene generation, selected ordinary
  Agent generation/recovery/tool-order tests and the non-PBL sandbox suite. They do
  not replace full manual acceptance of every course mode.
- Live model teaching quality, the complete combined real-provider journey, actual
  private course assembly and small-cohort deployment acceptance remain separate.
  Earlier live checks in [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md) are historical
  evidence for their stated revision and scope, not validation of this PR's head.

Expected-output digests remove the known command-line disclosure, but shell access
remains a cooperative learning facility. Course authors must not put expected values
inside sandbox-visible support scripts. This does not claim hostile-exam isolation.

Java runtime stack frames are excluded from compiler-location parsing, so null and
index exceptions retain their per-case execution failure instead of invalidating
the whole receipt as infrastructure failure. Repair and passing reruns are covered
with the local JDK.

Compile feedback returns bounded public-source locations and error categories,
without compiler source excerpts, private test paths, hidden expectations or raw
tracebacks. ANSI decoration is removed before parsing. The host validates locations
against the actual source snapshot. Unattributed preparation/private-driver failures
remain unreliable assessments, not confirmed learner failures. Both categories keep
editing, Coder help, public builds and retesting available when the workspace is
healthy and no writer is active. Actual environment loss still uses the shared
recovery path. Python/JDK and PostgreSQL regressions cover failure, repair and a
passing rerun; explicit current-stage compile commands do not compile an unused
future-stage fixture merely because it is staged. Course authors still own correct
stage selection, contracts, fixtures and cumulative API compatibility.

## Later work

The simplified course content, its DSL/tests/business frontend and private packaging
are subsequent integration work. Live deployment, accounts/quotas/billing/capacity,
promotion/operations, generated projects, SSH/local Docker providers and end-of-course
resource retention/cleanup are also outside this change. No additional platform,
scheduler, research export or administration dashboard is introduced.
