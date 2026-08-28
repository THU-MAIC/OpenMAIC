---
name: curriculum-planner
title: "系列课规划"
description: Multi-stage series — a request for several classrooms that belong together, like 「7 天学 Python」, a four-week onboarding track, a semester unit split across lessons, or "turn this book into a lesson per chapter". Clarifies the series brief, gets the user's explicit sign-off on the full lesson list before spending anything, then builds the stages one at a time into a shared folder. Use when the ask is a sequence of classrooms; not for a single stage, however large.
---

# Planning and building a stage series

A series is many stages — many classrooms — that a learner takes in order. The
unit of work is still one stage, and `stage-design` governs how each one is
built. Three things are yours and only yours: getting the brief straight,
getting the user's sign-off on the whole list, and carrying the series from the
first stage to the last without losing the thread.

Your tools for the series layer: `create_folder`, `create_stage`,
`move_to_folder`, `list_folder_stages`, `read_stage_outline`,
and `ask_user`. Everything else — planning in conversation, `set_roster`,
`generate_scene`, `list_scenes`, `read_stage`, `patch_stage`, `grep_stage`,
`edit_deck`, `generate_tts`, the material tools, `web_search`, `fetch_url`,
`render_scene_preview` — is the same toolset you would use for a single stage,
applied with that stage's explicit `stageId` on every call.

## `ask_user` ends the run

Calling `ask_user` turns the user's composer into a question form and **stops
this run**. Their answer starts the next one, with the conversation intact. Two
consequences shape how you clarify:

- **One round is one call.** Everything you are asking at this point goes into a
  single `ask_user` — two calls back to back is two waits for one round of
  questions, and the second card lands on a user who is still reading the first.
- **The rounds themselves are sequential, on purpose.** What you ask second
  depends on what they answered first: you cannot offer 「案例领域偏好：生活化小
  工具 / 办公自动化 / 小游戏」 before you know they have never written code. Two
  or three rounds that each build on the last are how someone who knows the
  subject takes a brief; one giant form is a questionnaire.

## Gate 1 — Clarify, in rounds

A series request is almost always underdetermined. A single sentence like
「7 天学 Python」 fixes the topic and the lesson count and leaves open everything
that decides what the lessons actually contain. Work through it in **two or three
rounds**, one `ask_user` per round, each round narrower than the one before.

**Round 1 — where this lands.** The two or three things nothing else can be
decided without:

- **who the learner is** — absolute beginner, someone who codes in another
  language, a team with mixed levels;
- **what they want out of it** — a working script of their own, an exam they have
  to pass, a concept they can hold up in a meeting.

Put the example inside the option label: 「完全零基础，没写过一行代码」 tells the
user what you mean by beginner, 「初级」 makes them guess.

**Round 2 — the shape, fitted to Round 1's answers.** Now ask what Round 1 made
askable: how long one session is, the pace, the language of instruction, how
hands-on it should be. **Build the options out of what they just told you** —
「零基础」 turns into 「案例领域偏好：生活化小工具 / 办公自动化 / 小游戏」, and
「平时写 Java」 turns into 「从 Python 与 Java 的差异切入，还是从语法从头讲一遍」.
An option set that could have been written before their answer is the giveaway
that this is a form and not a conversation.

**Round 3 — the edges, and only when they are real.** Whether a book, syllabus or
deck they already have should be the source the series is built from; how much
checking they want (a quiz per lesson, one at the end, none). Skip this round
whenever neither question would change the plan.

Rules that hold for every round:

- **At most three big things per round.** A round carrying six questions is the
  giant form again, wearing three hats.
- **Open each round by saying what you took from the last one.** «既然是零基础、
  每天 30 分钟，我把每课压到一个当天能跑起来的小工具» — the user has to see their
  answer being used. This is the whole reason several rounds read as professional
  rather than slow: a round that does not visibly consume the previous answers is
  just a second form.
- **Never ask what you already know.** Anything the request settled, or that you
  can safely default, is **stated as your decision for them to overrule** rather
  than asked: 「默认中文讲授、每课 30 分钟，要改直接说」 costs no round at all.
- **Two or three rounds, not four.** Opening a round to ask something you could
  have decided yourself is padding, and padding reads as stalling, not as care.
  When the next round has nothing load-bearing left in it, go to Gate 2.

**The question IS the tool call, never the text.** Writing the questions into
chat prose is not asking: the user gets no answer form, only a turn that ended
in a paragraph, and nothing to answer with. Two patterns are banned outright —
listing the questions in narration instead of calling the tool («为确保安排合适，
请一次确认以下信息：…» followed by no `ask_user`, which is exactly how this gate
fails), and narrating the question before asking it. The sentence you write
before the gate says what you are about to do; it must not contain a question
mark, and it must not preview the questions themselves.

When the request is already specific enough — the user described the audience
and the shape they want, or attached the syllabus — skip this gate. Go straight
to a proposal and let Gate 2 be the one place they confirm.

## Gate 2 — The confirmation gate

**Never start building before the user has signed off on the full series.** A
series of seven stages is seven times the work of one stage; the user has to
see the whole plan before anything is built. This is its own
round, after the clarification rounds are done — never folded into one of them,
because a plan proposed before the answers are in is a plan built on guesses.

Present, in the chat, before any stage exists:

- the **series title** and the **number of stages**;
- **every stage, one line each**: its title and, in a clause, what it is for and
  what the learner can do at the end of it;
- anything you decided for them that they might disagree with — the level you
  pitched it at, the order, what you deliberately left out.

Then call `ask_user` for an explicit go, and offer the obvious alternatives to
a plain yes: change the count, reorder, drop or add a lesson, adjust the level.
A silent or ambiguous answer is not a go. If they change something, show the
revised list and ask again — a second confirmation round is far cheaper than
seven stages built to the wrong brief.

The list above belongs in the chat — it is what the user reads. **The ask does
not.** The go is an `ask_user` call with those alternatives as its options; a
turn that presents the list and then asks «可以开始吗？» in prose ends with no
way to answer, and treating that silence as consent is the one thing this gate
exists to prevent. Same rule as Gate 1: no question mark in the narration, and
no preview of the question you are about to ask.

## Designing the series

- **Progression.** Each stage opens where the previous one closed. What is
  assumed to be known must have been taught, in an earlier stage, in a form the
  learner will recognize.
- **Self-contained lessons.** Every stage must stand on its own as a class: a
  learner who takes only day 4 gets a complete lesson with its own opening, its
  own payoff, and enough framing to make sense. A lesson that only works as the
  continuation of another is not a lesson, it is half of one.
- **Review hooks.** From the second stage on, open by reactivating what the
  learner needs from earlier — briefly, and as use rather than repetition:
  apply the earlier idea to the new problem instead of restating it.
- **Difficulty curve.** Difficulty rises steadily and never jumps. Watch for the
  usual failure: three easy lessons, then one that carries the whole hard part.
  If one lesson is doing too much, split it and say so at Gate 2 — the lesson
  count is a proposal, not a constraint the user imposed.
- **Titles that say what the lesson does**, in the series' own language, so the
  folder reads as a curriculum: 「第 3 天：把重复的活写成函数」 rather than
  「Python 基础（三）」.

## The execution loop

Once you have the go:

1. `create_folder` for the series, named as the user would name it.
2. For each stage, in order:
   - `create_stage` passing the series folder's `folderId` — the stage is filed
     into the folder in the same call, never left sitting in ungrouped — keep
     the returned `stageId` and pass it to every generation/edit/read call;
   - build it by the `stage-design` sequence — outline once, roster, one
     `generate_scene` per page in order, `list_scenes` to verify, audio checked
     before it counts as done;
   - after the lesson is built, `list_folder_stages` and check the stage is in
     the series folder. If it shows no folder (the `folderId` was dropped), call
     `move_to_folder` to file it right away — never let the whole series run to
     the end before noticing an ungrouped stage;
   - write **one short paragraph into the chat**: what this lesson ended up
     covering, and what the next one starts from. Three or four sentences.
3. Before starting a stage that builds on an earlier one, `read_stage_outline`
   on that earlier stage. Read what was actually built, not what you planned to
   build — the outline generator's plan is never exactly your proposal, and
   continuity has to be against reality.
4. `list_folder_stages` when you need to know where the series stands — which
   stages exist, in what order.

## Long-run context discipline

A series is a long conversation, and everything you write stays in it. Your
per-lesson recap is the series' memory: keep it about the lesson — what it
teaches, what it assumed, what it left for later. Do not replay tool detail
(page counts per call, ids, which tool returned what); do not re-quote outlines
you already summarized; do not restate the whole series plan at every step. If
you need a detail from an earlier lesson, read it back with `read_stage_outline`
or `list_folder_stages` instead of keeping it alive by repetition.

## When something fails

One bad page does not end a series. If a page or a whole stage will not
generate:

- retry it once — every tool is idempotent, and an interrupted step just needs
  re-issuing;
- if it still fails, note it, leave the rest of that stage intact, and move on
  to the next one. Do not restart the series, and do not silently drop a lesson
  from the plan;
- keep a short running list of what did not come out right, and **report it at
  the end**: which lesson, which page, what needs a rebuild. A series delivered
  with two known gaps is worth far more than a series abandoned at lesson three.

## Finishing

Close with:

- the **folder link**, so the user lands on the series;
- a short **series summary**: the lessons that were built, in order;
- the **rework list** — anything that failed or that you would build differently
  — or a sentence saying there is none.

## Related skills

`stage-design` governs each individual stage; this skill adds the layer above it
and never replaces it — read both. If a lesson in the series has a shape of its
own — hands-on, vocational, research-backed — the matching topic skill applies
inside that stage. And if the subject rests on facts you would have to verify
rather than recall, run `deep-research` BEFORE Gate 2, not after: a series plan
the user approved is a plan you then have to build.
