# PBL v3 prompt-cache validation — work in progress

## Latest optimization

```text
fixed system instructions → existing history → initial/live state + continuation policy
```

Initial review anchors are retained separately from latest state. Request-local
host state remains a trusted system message, not a learner turn or durable entry,
and is counted in the context budget. Version/lease rechecks and approval gates
remain active. Prefix-only adapters merge only the marked host tail back into
the system prefix; OpenAI-compatible transports retain it after history.

Tool-call objects are recursively key-sorted on replay, including calls still in
memory. This prevents JSONB key-order changes from invalidating the prefix after
reload, without mutating execution arguments or array order. No course package,
project Skill, generic teaching rule, role isolation, compaction policy or storage
format changes.

## Latest local evidence

Ratio = `sum(cached input tokens) / sum(input tokens)`. Model:
`deepseek-v4.1-flash`, existing configured MaaS route. Source requests match in all arms.

| Dataset | Before PR #2268 | Initial PR layout | Request-tail candidate |
| --- | ---: | ---: | ---: |
| Short synthetic probe, 8 calls/arm | 35.75% | 62.65% | 62.83% |
| Continuous local-QA replay subset, 67 calls/arm | 56.24% | 60.49% | 81.90% |

The 67 calls are identical retry-free source records per arm, selected from a
174-record reconstructed local acceptance corpus by execution-quality timestamps,
not cache outcome. Coverage: course 3, first milestone, discussion/planning/coding;
not C-end users or every role/milestone. The larger repeated replay had execution
interruptions, so its full aggregate is not the primary claim. History retains
visible dialogue/tool records with rebuilt host facts, not byte-exact historical
HTTP requests. Raw learner records are not published.

Output is capped at 16 tokens; generated tools are never executed. Usage returned
reasoning tokens even when thinking was requested disabled. No latency gain or
production-wide cache rate is claimed. Counts/method:
[latest-local-cache.json](latest-local-cache.json).

**Teaching baseline: pre-PR commit
`65d5ac408301a2916d1d7e81b037855760a286ab`, not an earlier version inside this PR.**
Reversible instruction/state/Skill checks pass for 36 scenarios across courses 1–3.
Fresh full-response comparison with that commit is in progress. Existing baseline
course/model behavior is excluded from new-regression findings.

**Still a draft; C-end production-data paired validation is being attempted.**
The sections below retain the initial revision's evidence and describe that
revision only. The current request-tail implementation is described above.

---

# Initial implementation validation (historical)

This is a local comparison of the **same course packages on two prompt layouts**,
not a comparison between different editions of the courses. AI-assisted change and
validation; no production deployment or learner-data experiment.

## Change under test

Base: `65d5ac408301a2916d1d7e81b037855760a286ab`.

```text
Before: role + course/context seed (including changing initial state) + fixed rules
After:  role + course/context seed + the same fixed rules + initial-state snapshot
```

Only the initial `stageEntry.automatic`, `learningRoadmap.completionRecorded`,
`teachingContext` and `currentReview` fields move. No field is dropped. In
particular, the initial review question remains available when tools advance the
latest section during a run. The latest-state suffix remains unchanged.

All instruction text and its relative order, course Skills and their progressive
loading, reference content, historical-message projection, tools, approval gates
and role isolation stay unchanged. This does not create a shared context between
roles. Material that legitimately changes earlier in the prompt can still end
prefix reuse; this is not a claim of a globally constant system prompt.

## Cache measurement

Model: `deepseek-v4.1-flash` through the existing local configured MaaS route.
Eight requests per arm, interleaved, with an independent random leading marker per
arm so the first request is cold. Same third-course root Skill plus current
section, synthetic dialogue, 16 output-token limit. Events cover a repeat,
review-reply change, section advance and milestone change. This cache-only probe
has no model tools; teaching/tool behavior is evaluated separately below.

| Measurement                        |   Before |    After |
| ---------------------------------- | -------: | -------: |
| Requests                           |        8 |        8 |
| Input tokens                       |   64,417 |   64,525 |
| Cached input tokens                |   23,040 |   40,448 |
| Input-token cache ratio            |   35.77% |   62.69% |
| Ratio excluding first cold request |   41.15% |   72.11% |
| Uncached input tokens              |   41,377 |   24,077 |
| Median whole-response time         | 1,821 ms | 2,319 ms |

Ratio = `sum(cached input tokens) / sum(all input tokens)`. Uncached input falls
41.81% in this probe. **No latency improvement was demonstrated.** Sixteen
requests cannot establish a production-wide rate. The team's reported “44%” had
no model, time window or denominator and is not a verified production baseline.
Raw usage is in [cache-results.json](cache-results.json).

An earlier exploratory layout measured 36.37% → 69.07%, but reordered rules/history
and used different prompt assembly. It was rejected. A later snapshot-deletion
probe was rejected too: initial and live states have different jobs. Neither
exploratory gain is used as evidence for this patch.

## Teaching and workflow comparison

Three actual package archives are identified by version and SHA-256 in
[teaching-results.json](teaching-results.json). Each course has two milestones;
for each milestone the comparison covers:

1. First teaching after readiness / entry into the new milestone.
2. A → B section transition after a concrete learner answer.
3. First response after a saved plan.
4. First response after a saved implementation/build fixture.
5. Plan's final invitation, then explicit acceptance.
6. Code's final invitation, then explicit acceptance.

That is **36 paired scenarios, 72 arms and 96 learner turns**. Each arm is a single
retained generation, not best-of selection. Four final-cycle arms initially hit
HTTP 408; successful arms were preserved and only those transport failures were
retried. The final retained results have no transport errors or protocol issues.

The replay uses the actual packaged Skill loader, prompt/history builders,
registered tool schemas, prose-recovery helper and `GuidedSkillReview` class.
The 48 opening/transition/first-review traces were replayed through that class;
all ended in accepted review handoffs. The 24 final-cycle arms use the native
class while generating: **one registered approval invitation → learner accepts unchanged
version → `complete_stage`**, with no second invitation. The 24 plan/code
first-review arms did not request whole-version approval.

There were 24 prose-recovery calls across the main replay. A model sometimes
produced ordinary text without registering the required handoff; the actual
continuation helper retries it. Those unregistered prose attempts are retained
separately in the output JSON, including approval wording. No further invitation
was generated after the explicit acceptance in these final cycles. Browser
visibility of transient streamed text was not evaluated, so this is a registered
workflow assertion, not proof that the UI never flashes a duplicate question.

These are bounded synthetic replays. Files and successful build receipts are
fixtures; they do not prove newly generated Java is correct or constitute a
three-course browser/sandbox E2E run. Only the first offered decision option in
each milestone is exercised. Student learning outcomes were not measured.

### Teaching regression result

**Passed for the covered scenarios.** The paired outputs retain the current
milestone's goal and architecture/flow, the A → B teaching connection and current
section scope. Plan/code first reviews address a concrete artifact arrangement;
whole-version approval stays at the end. After explicit acceptance of an unchanged
version, each final cycle completes without another invitation.

This is a regression result for the listed cases, not a claim that every course
question is perfect or that student learning outcomes were measured. Existing
course/model wording behavior is outside this prompt-layout change. No project
package or course Skill was edited as part of this work.

Three additional attempts per arm were run for each of the course-2/M2 plan-first
and course-3/M1 code-first scenarios: 11 successful arms and one HTTP 408, with no
quality-based retries. All are in
[supplementary-results.json](supplementary-results.json). They supplement, rather
than replace, the original paired responses. No newly introduced teaching
regression was established by the covered comparison.

## Deterministic and backend checks

- [prompt-equivalence.json](prompt-equivalence.json): 36 reversible-transform
  checks. Reinsert the deferred fields at their original JSON positions and
  remove the appended snapshot: the old prompt is recovered byte for byte.
  Every field, rule and its order is retained; active Skill and live context are
  exactly equal between arms.
- PBL unit suite: **790 passed, 335 skipped**, 68 passing files and 2 skipped files.
- Original PostgreSQL runtime suite, unmodified, on a dedicated test database:
  **315 passed**. Existing durable-state, role/file scope, feedback/approval and
  progression checks are retained.
- Changed-file ESLint, Prettier and `git diff --check`: pass.
- Full TypeScript check is **not green in this local dependency installation**.
  Its diagnostics are byte-identical to the unmodified baseline (missing workspace
  / test dependencies); this patch adds no diagnostics. This is not a CI pass.

Targeted deterministic reproduction from an installed checkout:

```sh
pnpm exec vitest run tests/pbl/v3/product-context.test.ts
pnpm exec vitest run tests/pbl/v3
# With a separate disposable PostgreSQL test database configured:
pnpm exec vitest run tests/pbl/v3/runtime.pg.test.ts
```

For model-level reproduction, keep the same archive hash, decision, student
answer, current section, PLAN/source fixture, model settings and tool schemas in
both checkouts. Compare the initial teaching response, the A → B response, the
first plan/code question and the final approval/acceptance pair. Keep every
successful generation and record transport failures separately. Inspect the
student-visible question against the preceding explanation and the active Skill;
a tool-success count alone cannot establish teaching quality.

For cache reproduction, capture matching synthetic requests from the two layouts,
add different random leading markers, alternate arms, include one identical
repeat and one review/section change, and retain raw provider usage. Compute the
weighted token ratio above, not the percentage of requests with any cache hit.
The evidence files omit credentials, learner records and private reference/test
inputs; the local one-off replay tooling is not part of the application runtime.
