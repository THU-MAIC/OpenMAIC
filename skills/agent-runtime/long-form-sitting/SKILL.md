---
name: long-form-sitting
title: "长课规划"
description: Long-form lessons — a request that names a real sitting of 25-240 minutes (「一个小时的课」「九十分钟的讲座」"a two-hour workshop"). Apportions the sitting into modules that carry teaching functions, plans page count from the sitting (~0.45 pages per minute), budgets narration per page, and carries what earlier pages established across the whole deck. Composes with `stage-design` (the build sequence) and `curriculum-planner` (when the sitting splits into a series); not for requests that name no duration — the default short-lesson density applies there.
---

# Planning a long sitting

A request that names a real class length — 「一个小时的课」「九十分钟的讲座」
"a two-hour workshop" — is not a short lesson with more pages. Planned by the
default rules it fails in one of two ways: a **sprint**, where the page plan
runs ahead of the minutes and the deck becomes a slideshow read aloud, or a
**short course claiming the length**, where a dozen pages carry durations
nobody checks. This skill is the long-form path: the sitting is a planning
quantity, and everything else follows from it.

`stage-design` still governs how the stage is built — plan in conversation,
roster, one `generate_scene` per page, audio before done. `curriculum-planner`
governs the series layer when the sitting is too long for one classroom. This
skill governs what the plan contains when minutes are named. When the request
names no duration, none of this applies: keep the default density and state
what you assumed.

## 1. Resolve the sitting first

Read the minutes from the request and state them as your decision the user may
overrule — 「默认按 60 分钟规划，要改直接说」. Then:

- **Under 25 minutes** — not this skill; plan by the default rules.
- **25-120 minutes** — one stage, one classroom. Modules are arcs inside it.
- **Over 120 minutes** — decide between one continuous stage and a
  `curriculum-planner` series. In a series, **several modules share one stage**
  (2-4 modules per stage is normal): a 4-12 module sitting becomes two or
  three stages, each still self-contained. Say at the confirmation which you
  chose and how the modules group into stages. A 240-minute deck is ~108
  pages of `generate_scene` calls in one classroom; a series of two or three
  stages is usually the better shape, and the user should see that choice
  before it is built.

## 2. Modules carry a teaching function

Split the sitting into 4-12 modules. A module owes an **action**, not a topic —
name it by what the learner can do when it closes:

- `hook` — opens the problem the course answers; the learner can say why the
  subject is worth the sitting.
- `concept` — fixes a definition and its boundary; the learner can sort
  examples from non-examples.
- `mechanism` — walks a claim to its consequence; the learner can derive one
  step of it themselves.
- `application` — a worked case the learner could have attempted first; the
  wrong move and its cost are shown.
- `integration` — two earlier ideas meet; the learner uses both in one move.

Apportion the minutes by weight — `mechanism` and `application` are heavy,
`hook` is light (about 5-10 minutes) — and keep every module between about 5
and 45 minutes. A module cannot be satisfied by listing facts: if its brief
reads like a table of contents, it is a topic, not a function. Within one stage a module is an arc (as `lecture-style` defines arcs); in a series several modules may share a stage, so keep the module-to-stage grouping explicit in the confirmation.

## 3. Page count comes from the sitting

Plan **~0.45 pages per minute** — an hour is 27-29 pages, not 60-120. Depth
per page, not page count: each body page carries one claim plus what makes it
stick (a definition and its boundary, a mechanism and a worked case, a
comparison and the criterion that separates the sides). This density is
calibrated against a hand-built 61-minute deck of 29 pages, where it lands
within 4%; treat it as the starting point you may depart from, with the reason
stated in the plan.

## 4. Budget the narration

A page's speech length is **planned, not discovered**: the page's spoken
minutes × the language's speech rate ≈ the narration it must carry. Use about
250-280 characters per spoken minute for Chinese and 140-160 words per minute
for English as starting rates, and pass the number in each page's
`generate_scene` `brief` or `materialFacts` as a directive —
「本页旁白约 900 字，约 3.5 分钟」. A page whose narration undershoots its
budget is a defect: name it in the wrap-up, the same way a missing page is
named.

## 5. The plan is the ledger

Every `generate_scene` call sees only its own brief. So the settled plan must
carry what earlier pages established: each page's brief names the pages it
depends on and the one thing it may assume the learner already has —
「承接第 4 页：久期的定义」. When you write page N's brief, reread the plan
rather than your memory of page N-1. In a series this is
`curriculum-planner`'s rule at stage granularity: `read_stage_outline` the
earlier stage before building one that builds on it — continuity against what
was actually built, not what was planned.

## 6. The four contracts

Check the plan against all four before asking the user to confirm it, and
check each page against the same four as it lands:

- **Derivation** — every claim has, on the same or an earlier page, the step
  that forces it. A claim stated without its step is a defect.
- **Systems** — every page builds a named node in a system the course declared
  in its opening (a vocabulary, a model, a toolkit); by the end the learner
  can name the nodes and connect them.
- **Foundation** — assumed knowledge is declared (「假设你已见过一阶导数」) and
  either patched in a module or named as an entry requirement at
  confirmation.
- **Agency** — at least once per hour the learner decides and sees the cost of
  the wrong choice: a quiz whose distractors are the real mistakes, an
  application page that first shows the plausible wrong move.

## Related skills

`stage-design` (the build sequence), `curriculum-planner` (the series layer),
`lecture-style` (a long sitting is usually a lecture; its arcs, density and
narration register compose with this skill — when both apply, the sitting
arithmetic here wins on minutes and the lecture register wins on sound).
