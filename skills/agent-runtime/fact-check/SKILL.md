---
name: fact-check
title: "事实核查"
description: "Improve factual reliability while creating or reviewing a course or supplied content. Use when the user asks to fact-check, verify accuracy, reduce hallucinations, make a reliable course, or mentions 事实性错误、知识性错误、专业知识准确性、可靠性. During creation, checks the completed pages before delivery; on existing content, returns a short evidence-backed report and lets the user choose what to fix. Not for grammar, style, or layout. Combine with deep-research when current evidence is the course's main subject."
---

# Fact check

Keep serious factual mistakes and AI hallucinations out of the course without
turning course-making into an exhaustive audit. Focus on the few claims that
materially affect trust.

Choose the mode from the request and current course state; do not ask the user
to choose a mode:

- **Creating:** when there is no course yet or the user asks to build/rebuild
  one, load `stage-design` and run the check only after all pages exist.
- **Reviewing:** when content already exists and the user asks to inspect it,
  report findings first. Do not edit unless fixes were already requested or the
  user approves findings after the report.

## While creating a course

Use the normal `stage-design` workflow; this skill changes factual handling,
not the teaching method, page style, or build sequence.

After all pages exist, call `list_scenes`, then read every completed page with
`read_stage` using `detail:"text"`; follow `nextOffset` until all visible text
and narration have been read. Run a quick final sanity check of exact facts and
cross-page contradictions. Correct obvious errors before delivery because
creating the course already authorizes making its content accurate, subject to
the source-of-truth boundary below. Do not interrupt creation with a separate
audit report or approval gate unless that boundary requires a user decision;
briefly mention only material corrections or remaining uncertainty when
handing off the finished course.

## When reviewing existing content

For a course, call `list_scenes`, then read all visible text and narration with
`read_stage` using `detail:"text"`; follow `nextOffset` until complete. Respect a
narrower scope if the user gave one.

Read once for context and silently shortlist high-signal risks:

- exact numbers, dates, counts, names, and attributed quotations;
- laws, standards, formulas, technical definitions, and classifications;
- “first”, “only”, “always”, “must”, and similar absolute claims;
- causal or professional conclusions stated as settled fact;
- contradictions between pages;
- suspiciously specific claims with no visible support.

Do not verify every claim. Skip correct material, wording preferences, harmless
simplifications, and low-value trivia.

## Verify only the shortlist

Check `list_materials` and relevant `read_material` content first. User sources
may support a claim, but the course being checked cannot prove itself.

Use `web_search` for shortlisted claims that depend on current, exact, disputed,
or specialist knowledge. A normal first pass should need no more than about
6–8 searches. Use `fetch_url` to read the source: a result snippet or the mere
existence of a related source is not evidence.

Do not pause the run to ask the user for sources, permission to use general
knowledge, or permission to continue. Use the tools and materials that are
available. If web search is unavailable, continue with stable knowledge, make
fewer factual commitments, and mark genuinely uncertain claims. Never guess a
URL for `fetch_url`; fetch only a user-provided URL or one returned by
`web_search`.

For a compound statement, isolate the questionable part and verify that exact
part. Prefer primary or official sources. One authoritative source is enough
for an obvious error; add corroboration only for disputed or high-impact
claims. For versioned knowledge such as law, policy, standards, or medicine,
check the relevant date, version, and jurisdiction.

“No reliable evidence found” does not mean false. If verification remains
inconclusive, say so rather than inventing a verdict or correction.

## Preserve approved inputs

Do not make a correction that would materially conflict with the settled
course plan, user-uploaded materials, or facts already supplied to generation
through `materialFacts`. Treat these as approved inputs, not ordinary generated
copy.

If the evidence indicates that an approved input itself may contain a factual
error, do not edit the affected course content or silently override the input.
Use `ask_user` to flag the input conflict, state the affected page or claim and
the contrary evidence concisely, and offer options to keep the approved input,
authorize the factual correction, or review the conflict without editing. Put
the warning in the `ask_user` prompt so it appears in the choice card, not only
in the preceding report. This protection applies even when edits were otherwise
authorized. It does not block corrections to errors introduced independently
by generated page content.

## Give a short, readable review report

In review mode, return roughly 3–8 useful findings in the first pass, or fewer
when fewer exist. Group them under these bold plain-text labels, in this order,
and omit an empty group. Keep them at normal body-text size: do not prefix them
with Markdown heading markers such as `#` or `##`.

- **A. 明确事实错误**
- **B. 表述不严谨**
- **C. 需要核实** — include only when the claim matters

Within the groups, number findings consecutively across the whole report with
Arabic numerals. Give every finding a short bold line containing its number,
page/location, and specific issue, for example:
`**1. 第 5 页｜测验解析｜知识混淆**`. Do not use Markdown heading markers for
finding titles either.

Under each heading, use exactly three bullets:

- **原始表述：** quote only the relevant sentence or fragment;
- **存在问题：** explain the error and the correct fact in plain language;
  include a concise source and date here when useful;
- **修改建议：** give only the edit action or a compact replacement.

Keep each bullet to one or two short sentences. Do not repeat the same fact or
quotation across bullets. If **存在问题** already gives the applicable rule or
correct wording, **修改建议** should only state the change — for example,
“按上述条文改写，删除‘商业秘密、法人’” — instead of quoting the article again.

Do not show scores, confidence percentages, lengthy methodology, correct
claims, or minor style issues. Do not pad the report to reach a quota. If no
material issue is found, say what scope was scanned and that no obvious error
was found; do not claim the content is perfectly accurate.

## Let the user choose after a review

When there are actionable findings and edits were not already authorized, the
last action of the turn must be an `ask_user` tool call with a non-empty
`options` array. This is an interaction requirement: do not merely print option
ids or end a normal chat message with “which do you choose?”. Use concise labels
in the user's language, equivalent to:

- fix all reported issues;
- fix confirmed errors only;
- keep the report without changes.

Use stable option ids such as `fix_all`, `fix_confirmed`, and `keep`. The form's
free-text choice lets the user enter selected finding numbers such as `1, 3`.

An approved-input conflict always requires the separate `ask_user` choice
described above, even if the user previously authorized general corrections.

Do not patch before the answer. After approval, load `pro-editing`, read each
selected page with `read_stage` using `detail:"source"`, and change only the
approved claims. If narration changes, regenerate its audio as required by
`pro-editing`.
