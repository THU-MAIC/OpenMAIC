# PBL v3 prompt-cache validation

## Current implementation, including review follow-up

Changing teaching state originally interrupted reuse of everything after it.
The current request layout is:

```text
fixed rules + stable course/stage references → retained history → initial/live host state + continuation policy
```

Initial review anchors remain separate from latest state. The marked request-only
host tail retains system authority, counts toward the context budget and is not
written into learner history. Tool-call object keys are recursively canonicalized
on replay; execution arguments and array order do not change.

The review follow-up moves mutable PLAN/code snapshots out of the early system
seed. Four ordinary same-stage PLAN changes were observed in the previous layout;
none remain in the reviewed projection. **All instruction and artifact text stays
in full.** An optional exact instruction/plan-reference experiment was evaluated
and removed because pedagogical attention/continuity remained uncertain. Its
higher cache numbers are not the final implementation's results. No instruction
summarization, reference elision or course/Skill edits ship.

OpenAI-compatible is **not** a chat-template capability. Unknown/custom endpoints
now default to `prefix`; native DeepSeek has a registry capability. A verified
custom endpoint must explicitly set deployment
`providers.<id>.options.requestSystemTailPlacement: trailing`. Primary and fallback
adapters each enforce their own policy. Prefix-only SDKs always put the marked
host tail first; equivalent cache gains are not claimed on those routes. Actual
SDK request-format tests cover strict non-leading-system rejection for
Ollama/Gemma, vLLM/Mistral and unknown custom relays, plus verified opt-in/native
DeepSeek. **The MaaS replay uses verified trailing mode; deploying this code alone
without opting that custom route in does not reproduce these cache gains.**

No project package, generic teaching rule, progressive-disclosure sequence, role
isolation, approval gate, storage schema or compaction-policy change. No deployment
or production configuration change.

## Long production sessions: final review follow-up

Source: production PostgreSQL `llm_calls`, read through `maic-ops-prod` / `pg_query`
with data source `openmaic_live`, joined to published-course studies and PBL role
sessions, excluding course authors. Fixed seed, up to 200 candidate role-session
rows/course; role/availability selection never uses cache outcomes. Four distinct
learners/course, 12 role sessions, 10 unique overall; 48 source records/course,
**144 frozen source requests**. Courses 1/2 use calls 13–24 from sessions with at
least 24 calls. No prerequisite candidate reached 24 (maximum 21), so that course
uses the last 12 calls of sessions with 16/16/19/16 calls. This is a stratified
later-window sample, not a census or full-session replay.

Model: `deepseek-v4.1-flash` through the configured MaaS route. Formula throughout:
**`sum(cached input tokens) / sum(input tokens)`**. The final full-text version ran
three variants × 144 requests × one round = **432 transport attempts**, one per
request, no retry or intentional pause. One current-version request returned 502;
that source record is excluded from **all three arms**, leaving **143 matched
successful records/version** (429 matched results; 431 successes overall). Failed
and unmatched results are retained. The 144-row CSV explicitly marks the excluded
row. Before/previous arms were rerun too; historical usage is not spliced onto a
new replay result.

| Same matched records in every arm | Requests/version | Before #2268 (`65d5ac4` reference) | Previous PR (`4126940`) | Final full-text version (`d0572b6`) |
| --- | ---: | ---: | ---: | ---: |
| All courses, including cold/window/boundary events | 143 | 31.04% | 76.97% | **75.38%** |
| Prerequisite | 48 | 36.73% | 74.80% | 75.02% |
| Course 1 | 48 | 27.76% | 80.97% | 75.52% |
| Course 2 | 47 | 30.25% | 74.13% | 75.50% |
| Ordinary append-only diagnostic, same subset in all arms | 110 | 34.74% | 86.91% | **85.28%** |

Primary cached/input totals: before **1,269,760 / 4,090,827**; previous
**3,150,464 / 4,092,873**; final **3,085,568 / 4,093,367**. Versus pre-PR:
**+44.34 percentage points**, **64.28% fewer uncached tokens**.
Versus the previous PR: **−1.59 pp and 6.94% more uncached tokens**. This correctness/
compatibility follow-up is **not** presented as a win over the previous revision.
Moving changing artifacts behind history prevents prefix breaks, but full
snapshots that were previously cacheable in the head now contribute to the tail.
Course 1 shows that trade-off clearly. We retained literal material rather than
ship a higher-cache reference optimization with uncertain teaching behavior.

The ordinary diagnostic excludes first window requests, welcome/stage switches,
captured prompt revisions and archived recovery-whitespace differences. The
143-row headline keeps these events. **85.28% is not the production-wide rate and
we do not claim 90%.** The per-request estimates below show that most ordinary
misses are in state/material tails and new text, rather than unexplained old-prefix
reprocessing. [Source/counts/aggregates](long-session-cache-results.json).
[144 numeric per-request rows, including failure status](long-session-per-request.csv).

### Where uncached input comes from

Exact billed usage is separate from offline component estimates. The endpoint
reports total cached/input tokens, not backend token boundaries. The official
DeepSeek V4 tokenizer estimates text components; it does not establish the exact
MaaS V4.1 serialization. Estimated buckets allocate tail text first, then genuinely
new text, capped at measured misses. First selected-window requests are separate.
Residual includes repeated-prefix processing, protocol framing, tokenization/
rounding and unexplained cache effects; **it is not all claimed to be an application
bug**. Per-request buckets sum to exact misses; raw estimates/clipping flags remain
in the CSV. This is conservative accounting, not independent backend boundary
measurement.

| Final full-text version | All 143 | Ordinary 110 |
| --- | ---: | ---: |
| Exact uncached tokens | 1,007,799 | 495,243 |
| Estimated request-only state/material tail | 432,417 | 343,980 |
| Estimated new learner/assistant/tool/file/head text | 163,500 | 141,895 |
| Estimated selected-window cold-start remainder | 244,924 | 0 |
| Residual repeated-prefix/framing/cache effects | 166,958 | 9,368 |

The audit records 21 head changes: welcome/material disclosure, stage switches,
one captured prompt/reference revision and archived recovery-whitespace artifacts.
Tool definitions change at four stage boundaries. Canonical history stays
append-only when the head is stable. No compaction boundary appears in this
cohort; compaction policy is unchanged and projection/budget checks remain. Thirteen
archived recovery transitions have a projection newline difference; these are
preserved and labelled, not presented as proven current-runtime defects.

Controlled-replay limits: logs preserve saved system/input but only tool names,
so both arms receive identical reconstructed pre-PR schemas. JSONB loses original
argument insertion order; original generation settings are not fully logged.
Each arm has an independently isolated leading marker, chronological same inputs
and a 16-output-token cap. Generated outputs are never executed or fed back.
Recorded assistant replies become new input without recreating their original
output-KV warmup. These are not byte-exact historical HTTP requests, UI-latency
measurements or universal cache-rate claims. No raw learner content, responses,
account/study/session identifiers or credentials are published.

The earlier optional-reference experiment completed 864 valid logical results
(two rounds × three variants × the same 144 records); 906 recorded transport
attempts including 33 invalidated candidates, conservatively 909 including possible
in-flight calls, within the approved 912 limit. It is retained separately, not
substituted into final results. Its primary candidate 78.56% / ordinary 88.89% must
**not** be cited as final code performance. The final 432 requests were separately
authorized after that optimization was rejected.

## Earlier measurements: previous layout, not reruns of this follow-up

| Source and matched sample | Before #2268 | Initial revision | Previous tail layout |
| --- | ---: | ---: | ---: |
| Synthetic short-history probe: 8 calls/version | 35.75% | 62.65% | 62.83% |
| Reconstructed local course-3 QA: same 67 retry-free pre-interruption records/version | 56.24% | 60.49% | 81.90% |
| Production early windows: 72 records, 24/course, two rounds/version | 41.59% | Not measured | 58.52% |

These are historical supporting experiments with different samples, not baselines
for the new143 matched records. The interrupted local 174-record/two-round run is
supplementary: 62.85% → 66.38% → 85.61%, 1,044 logical results / 1,160 attempts.
[Local aggregates](latest-local-cache.json). The earlier production sample used
first-six-call windows, four learners/course, nine unique overall; all 288 requests
succeeded without retry. Before 828,416/1,992,062; after 1,167,094/1,994,186.
[Earlier production source/method](production-cache-results.json).

## Teaching and engineering validation

The final full-text implementation is compared directly with **pre-PR `65d5ac4`**:
36 paired scenarios across courses 1–3 and two milestones/course. Baseline outputs
are reused unchanged; all 36 final candidate scenarios were regenerated after
removing reference reuse. All 36 reversible instruction/state/Skill checks pass;
all 12 first artifact reviews avoid whole-version approval; all 12 final cycles
complete after one acceptance; zero tool-protocol issues. Full instruction and
artifact text remains literal. [Final scope/checks](review-followup-teaching.json).

Advisory blind content review flagged wording/scope/question slips in both layouts
(7 baseline cases, 10 candidate cases); these are **not an all-pass content score**
or a causal regression estimate. Manual inspection and fixed paired repeats also
show these patterns in pre-PR outputs. No material-loss or approval/flow regression
was identified in the covered final cases. We do not claim identical generated
wording, zero stochastic teaching errors or browser/cloud learning outcomes.
The optional reference optimization was removed rather than tune course Skills to
make the comparison look better. All experimental/failed/truncated outputs remain
private; no best-of selection replaced this final dataset.

Final targeted runtime/provider tests: 197 passed, including actual SDK formatting
checks. Broader local selection: 898 passed, two fake-IP DNS failures reproduced
unchanged on the pre-PR baseline. PostgreSQL: 315 unique workflow scenarios passed
(313 plus two corrected assertion-location reruns); the two large-plan/import
flows passed again on final code. Local TypeScript diagnostics match the baseline
(77 existing, none added). The final application-code commit `d0572b6` passed all 16
GitHub CI checks, including lint/typecheck, unit, PostgreSQL and E2E jobs. Course
packages and both local acceptance classrooms/progress remain untouched.

The sections below preserve the initial revision's historical evidence.

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
