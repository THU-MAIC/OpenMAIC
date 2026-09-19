---
name: workshop-style
title: "互动工作坊"
description: Hands-on workshop — the learner works through the course instead of watching it, with an exercise or a check every couple of pages, short slides that only set up the next task, guiding narration that asks more than it tells, and a closing page where the pieces come together in one small project. Use when the ask is a workshop, a bootcamp session, 「动手」「实操」「练中学」「边做边学」, or a skill the learner is meant to leave holding; also use when the user names this style. Not for a systematic explanatory course (that is `lecture-style`) and not for occupational procedure training with tools and safety gates (that is `vocational`).
---

# Workshop design

You are designing a **workshop**. Nothing is explained for longer than it takes
to set up the next thing the learner does, and every idea is followed
immediately by a page where they try it. The learner leaves having built
something, not having been told about it.

`stage-design` still governs how the stage is built — outline, roster, one page
per `generate_scene`, audio before done. This skill governs what the stage
contains and how it sounds.

## The shape

- **Scene 1 is a `slide`, and it is short**: what the learner will have made by
  the end, and the first thing they are about to try. No agenda, no history of
  the field.
- **Every concept is followed at once by a hands-on page.** The rhythm is
  concept → do it, concept → do it: roughly **one `interactive` or `quiz` page
  for every two pages** in the course. If two explanatory pages ever sit next to
  each other, one of them is unnecessary.
- **`interactive` pages are the exercises.** Each isolates one thing to build,
  vary or trace. Consecutive interactive pages must not reuse the same
  `widgetType` — as the learner moves from trying to predicting to applying, the
  modality moves with them.
- **`quiz` pages are quick self-checks**, not exams — placed right after a
  hands-on page to make the learner state what they just observed. Short, two or
  three questions.
- **The last page is a small integrating project**: one `interactive` page whose
  task needs several of the workshop's pieces at once, with the earlier
  exercises as its parts. Not a summary slide. This is the page the learner
  screenshots afterwards.

## Slides are task briefs

A slide in a workshop exists to make the next exercise possible. Keep it to
**two or three `keyPoints`** — the rule, the shape, the one gotcha — and put
everything else in the exercise. A workshop slide that could be read on its own
as a lesson is too long: cut it and let the interactive page teach.

## widgetOutline

Every `interactive` page must carry a populated `widgetOutline`, always
including `concept` — the one thing this exercise is about. An interactive page
with an empty widget outline degrades into a generic page, which in this style
takes the course's whole point with it.

- `simulation`: `concept`, `keyVariables` (the actual things the learner moves)
- `code`: `concept`, `language`
- `diagram`: `concept`, `diagramType`, `nodes`
- `game`: `concept`, `gameType`, `challenge`, `playerControls`
- `visualization3d`: `concept`, `visualizationType`, `objects`, `interactions`

`keyPoints` on an interactive page describe **the task and what doing it
reveals** — what the learner changes, what they should notice, what conclusion
that forces. Not facts to be read aloud.

## Narration is facilitation

This is where the style is heard, so it is the part to get right.

- Lines are **short — one or two sentences**. Nobody in a workshop listens to a
  paragraph while a task is waiting on screen.
- **Ask more than you tell.** Most narration lines on a hands-on page are
  questions or instructions: 「先把这个值调到最大，看看会发生什么」「你觉得下一步
  会往哪边偏？」「试完再往下看。」 Statements are reserved for the moment after
  the learner has already seen the effect.
- **Hand the work over and get out of the way.** Say what to do, then stop. A
  narration that explains the answer before the exercise runs has cancelled the
  exercise.
- **Two voices, in dialogue.** The teacher sets the task; the assistant
  co-facilitator reacts, tries the wrong thing on the learner's behalf, or asks
  what everybody is wondering. Alternating short turns, not monologue.
- Encouragement is fine and belongs after an attempt, tied to something
  specific — 「注意你刚才那一下，曲线立刻翻过去了」 rather than 「太棒了」.

## The roster

The runtime allows **exactly one teacher**, so the dialogic pair is a lead
teacher plus a co-facilitator `assistant` — not two teachers. Write the roster
with `set_roster`: a hands-on practitioner who talks in tasks, an assistant
who is warm, quick and unafraid to be wrong out loud, and keep the roster small
enough that turns stay readable. Put 「short turns, question-first,
encouraging」 in the personas and a lively pace in `voiceDesign.delivery`.

## Carrying the style into the generators

There is no outline generator: you plan the course in the conversation, then
call `create_stage` and one `generate_scene` per page with an explicit brief.
Page content and narration are written by separate calls that see only the
page's brief, the page content and the roster. So the style has to be carried
there explicitly:

- put the concept → exercise cadence and the closing project into each page's
  `generate_scene` `brief`;
- put the two-voice facilitation manner into each persona of `set_roster`;
- pass the narration directive for each page in `generate_scene.materialFacts`
  — e.g. 「旁白为引导式短句，一到两句一条，提问多于陈述」「本页先让学员动手，
  结论留到操作之后」. Naming this skill in a prompt does nothing; only the text
  you place in those fields is seen.

## Scene naming

Titles name what the learner does, in the imperative.

- Good: 「把这段循环改成能跑的」「调参数，找出它崩掉的那一刻」「用今天的三块拼一个
  能用的小工具」
- Bad: 「循环的概念」「参数敏感性分析」「综合练习」

## If the request is not a workshop

If the subject has nothing to practise — a historical narrative, an appreciation
course, a body of knowledge the learner only needs to understand — say so in one
sentence and use `lecture-style` instead. Bolting exercises onto a topic with no
task produces busywork, which learners recognize faster than anything else.
