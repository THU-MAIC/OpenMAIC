# PBL v3 prompt-cache evidence

## Request layout

The original PR keeps reusable instructions/history ahead of changing host state:

```text
fixed rules + course/stage/artifact references → retained history → request-only initial/live state + continuation policy
```

Initial and live review facts remain distinct. The marked host tail retains system
authority, counts toward the input budget and is not stored as learner dialogue.
Replayed tool-call object keys are canonicalized without changing argument values
or array order.

The request layout retains the original PR ordering from `4126940` and the
provider compatibility fix. The follow-up below removes mutable PLAN data from
the fixed head while retaining its exact version in tool history. No course/Skill, role-isolation, approval-gate,
schema or compaction-policy changes; no deployment.

## Latest follow-up: retain each exact PLAN version once

A complete mutable `PLAN.md` snapshot in the fixed head invalidated the history
prefix after an ordinary plan edit. Moving the complete file to every request
tail instead repeatedly reprocessed unchanged text. This revision reuses an exact
retained successful file read/write; when the current complete version is missing,
it serializes the host's existing run-start read once through the established
fenced preload message path. It adds no learner frame or extra model call. The
head keeps a stable file-source reference; the tail identifies the exact retained
version. Missing/compacted sources restore the full original snapshot. Current
teaching instructions, feedback and approval data are never deduplicated.

The **same frozen 144 production-source records** were replayed again, with a
fresh control and candidate: **288 successful requests, zero failures/retries**.
The original 108- and 111-record masks were frozen before this run and applied to
both arms; newly stabilized PLAN edits were not added to the 108-row diagnostic.

| Same-source group | Records/version | Earlier reported control | Fresh control | This revision |
| --- | ---: | ---: | ---: | ---: |
| Complete sample | 144 | 77.05% | 77.06% | **78.99%** |
| Original stable-prefix/append-only subset | 108 | 89.35% | 89.36% | **89.25%** |
| Broader ordinary-turn subset, including three PLAN edits | 111 | 86.92% | 86.92% | **89.25%** |
| Prerequisite | 48 | 74.80% | 74.79% | 76.49% |
| Course 1 | 48 | 80.97% | 80.97% | 81.01% |
| Course 2 | 48 | 74.42% | 74.42% | 78.68% |

Overall uncached input falls from **945,624 to 862,427 tokens (-8.80%)**.
The stable subset is close, **not improved**: uncached input rises by 2,364 tokens
(0.68%), entirely among its 29 planning requests; all other 79 records have
identical usage. Exact-version source metadata has a small uncached per-call cost,
and removing duplicate cached PLAN text also reduces the cached denominator.
This explicit trade-off is retained rather than relaxing the frozen mask.

A separate affected-scope replay used all 36 planner records from that same
144-record cohort (12/course), with its own control and cache isolation:

| Planner records only | Records/version | Control | This revision |
| --- | ---: | ---: | ---: |
| Prerequisite | 12 | 75.79% | 81.66% |
| Course 1 | 12 | 80.66% | 80.77% |
| Course 2 | 12 | 68.01% | 82.75% |
| All planning records | 36 | **75.05%** | **81.69%** |

Course 1 is effectively flat. These 36-only rates are separate measurements and
are not blended into the 144-record result. The full rerun is the primary
confirmation. Superseded raw-transport probe attempts and the correction are
accounted for in the JSON.

Teaching was checked against **`65d5ac4`, before PR #2268**, using fresh before/after
outputs for 36 scenarios across courses 1–3 and both milestones (72 arms; no
previous generations reused). All 36 instruction/Skill/state equivalence checks
passed; the candidate's 12 first artifact reviews avoid final approval, and all
12 final cycles finish after one acceptance. No newly introduced reproducible
teaching regression was identified in these bounded scenarios. This is not a
claim that every generated sentence is ideal or a full browser/cloud E2E test.
Course packages, role isolation, approval gates and compaction policy are unchanged.

[Source, exact totals and validation](plan-preload-cache-results.json) ·
[144 paired numeric usage rows](plan-preload-per-request.csv).

## Previous restored-layout production replay

Source: production PostgreSQL `llm_calls`, through `maic-ops-prod` / `pg_query`
(data source `openmaic_live`), joined to published-course studies and role sessions,
excluding course authors. Fixed seed, up to 200 candidate role-session rows/course;
selection uses role/availability/call counts, never cache outcomes. There are
**144 source requests, 48/course, 12 role sessions, four distinct learners/course,
ten unique learners overall**. They include real tool-loop/automatic-entry calls,
not only typed learner messages.

Courses 1/2 use calls 13–24 of four sessions/course with at least 24 calls.
Prerequisite candidates were shorter (maximum 21), so selected sessions of
16/16/19/16 calls contribute their final 12 calls. This is a later-window sample,
not a census or full-session replay.

Fresh matched test: original PR `4126940` versus restored layout plus compatibility,
**144 requests/version, one round, 288 actual calls, zero failures/retries**. Both
arms have independent equal-length cache-isolation markers, identical chronological
source inputs/model/tools/settings, a 16-output-token cap and no generated tools
executed or outputs fed back. Model: `deepseek-v4.1-flash` through the configured
MaaS endpoint. Both arms use the verified trailing-system mode.

Ratio throughout: **sum(cached input tokens) / sum(input tokens)**, not an average
of per-request or per-course percentages. All 144 paired input/cache usage records
are identical between the original PR and restored version.

| Same records in both arms                      | Requests/version | Original PR | Restored layout + compatibility |
| ---------------------------------------------- | ---------------: | ----------: | ------------------------------: |
| Complete later-window sample                   |              144 |      77.05% |                      **77.05%** |
| Prerequisite                                   |               48 |      74.80% |                          74.80% |
| Course 1                                       |               48 |      80.97% |                          80.97% |
| Course 2                                       |               48 |      74.42% |                          74.42% |
| Broader ordinary-turn diagnostic               |              111 |      86.92% |                          86.92% |
| Stable prefix + append-only history diagnostic |              108 |      89.35% |                      **89.35%** |

Exact totals per arm: full sample **3,175,808 / 4,121,592** cached/input;
ordinary 111 **2,949,120 / 3,393,021**; stable 108 **2,938,624 / 3,288,797**.

### What the subsets mean

All subsets come from these same 144 production-source requests. The broader
111-row mask excludes first selected-window requests and marked welcome/stage/
tool/prompt/recovery-projection boundaries. It does not require the fixed head to be unchanged. The former 110-row/86.91% result was from a different replay in which
one source record failed and was symmetrically excluded; this new replay has no
exclusions or failures.

The 108-row subset is a **post-hoc structural diagnostic**, selected without cache
values. For each request, require a previous selected request in the same role
session, byte-identical fixed head, identical serialized tool definitions, and
the previous canonical message array as the exact serialized prefix of current
history. Applied to all 144 records, these predicates select exactly 108; the subset is also a strict refinement of the broader ordinary 111. The same 108 records are used in both arms.

The request-only current-state tail may still change. Thus 89.35% characterizes
stable reusable prefixes and append-only history, **not an entirely append-only
HTTP body, all production calls, or a guaranteed 90% rate**. It is the diagnostic
closest to the review's approximate-90% append-only-loop expectation; 77.05%
remains the all-record headline. The cited approximately-82% result was the earlier
local-QA experiment, not a threshold or a new reviewer-run benchmark.

[Complete source/counts/aggregates](long-session-cache-results.json) ·
[144 numeric request rows and eligibility flags](long-session-per-request.csv).

## Where misses come from — analysis complete, residual case explicit

Per-request exact input/cache/miss counts come from API usage. Offline component
estimates use the official DeepSeek recipe V4 tokenizer, not a claim of exact
MaaS V4.1 framing. Allocate estimated tail text first, then genuinely new text,
capped at exact misses. Keep first-window cold remainder separate. Residual mixes
repeated-prefix reprocessing, backend framing, tokenization/rounding and unexplained
cache effects; **it is not all asserted to be an application defect**. Raw estimates
and clipping flags are in the CSV; estimated buckets sum to exact misses.

| Previous restored layout                            | All 144 | Stable-prefix 108 |
| --------------------------------------------------- | ------: | ----------------: |
| Exact uncached tokens                               | 945,784 |           350,173 |
| Estimated request-only tail                         | 267,499 |           202,283 |
| Estimated new learner/assistant/tool/file/head text | 167,765 |           137,676 |
| Estimated first-window cold remainder               | 258,615 |                 0 |
| Residual repeated-prefix/framing/cache effects      | 251,905 |            10,214 |

The fixed head changes on 24 requests with a previous selected record; 12 other
requests are the first in their selected windows. Tool definitions change at four
boundaries. Request-level event labels cover welcome/material disclosure, stage
switches, tool definitions, captured prompt/reference changes and archived
recovery-projection differences. Event groups overlap; do not add their counts as
disjoint populations. No compaction boundary appears in this cohort; compaction
policy is unchanged. Thirteen archived recovery transitions have projection-
whitespace artifacts; these are labelled, not asserted to be current runtime bugs.
All records remain in the full-sample totals, regardless of diagnostic eligibility.

## Compatibility

OpenAI-compatible describes the wire protocol, not chat-template support. Unknown/
custom endpoints now safely default to `prefix`. A verified custom endpoint can set
`providers.<id>.options.requestSystemTailPlacement: trailing`; native capability
does not transfer to custom URLs. Each primary/fallback resolves its own placement.
Prefix-only SDKs always keep system instructions first.

Actual SDK request-format tests with strict mock endpoints cover Ollama/Gemma,
vLLM/Mistral and unknown relays rejecting non-leading systems, plus verified opt-in,
native DeepSeek and existing Anthropic/Google/Bedrock coverage. These are serialized
request tests, not self-hosted model-inference measurements.

**Deployment requirement:** the measured custom MaaS route must explicitly opt
into its verified trailing mode to reproduce these results. Unknown safe-prefix
routes do not claim equivalent cache gains. No live provider configuration changed.

## Limits and earlier evidence

Source dialogue is real production data, but the reported rates are controlled
replays, not live-production monitoring. Earlier calls before each selected window
are not replayed, so the first selected request starts cold. Logs preserve complete
saved system/input but not full tool schemas or original generation settings;
identical pre-PR schemas are reconstructed in both arms. JSONB loses insertion
order. Capped generated outputs are not fed back, so recorded assistant replies
arrive as new input without their original output-KV warmup. These are not byte-
exact historical HTTP, UI-latency or population estimates.

No raw learner text, model responses, user/study/session identifiers or credentials
are published. Numeric per-request data has coarse course/role/window labels only.

| Historical matched experiment                                               | Before PR | Initial revision | Original tail layout |
| --------------------------------------------------------------------------- | --------: | ---------------: | -------------------: |
| Synthetic short-history probe, 8 calls/version                              |    35.75% |           62.65% |               62.83% |
| Reconstructed local QA, same 67 retry-free pre-interruption records/version |    56.24% |           60.49% |               81.90% |
| Production early windows, 72 records/24 per course, two rounds/version      |    41.59% |     Not measured |               58.52% |
| Earlier later-window replay, same 144 source records, primary round 2       |    30.88% |     Not measured |               77.05% |

These are separate versioned experiments, not baseline values spliced into the
new two-arm run. A longer-window sample offers more reusable history; changing
samples from 58.52% to 77.05% is not an additional code-improvement claim.
See [earlier production evidence](production-cache-results.json) and
[local evidence](latest-local-cache.json). Intermediate experiments are historical and do not represent current measurements.
