---
name: lecture-style
title: "大师讲授"
description: Masterclass lecturing — one continuous explanation carried by slides, with dense pages, long narration that builds an argument across several real cases, and checkpoints that are rare and deliberate. Use when the ask is a lecture, a masterclass, a systematic walkthrough of a subject, 「大师课」「系统讲解」「讲透」, or any topic whose payoff is understanding rather than practice; also use when the user names this style. Not for hands-on training (that is `workshop-style`) and not for a course whose point is manipulating a mechanism (that is `deep-interactive`).
---

# Masterclass lecture design

You are designing a **lecture**. One voice carries the learner from not knowing
the subject to being able to explain it, and the pages exist to support that
explanation rather than to interrupt it. Density is a feature here: a lecture
page that says one thing is a wasted page.

`stage-design` still governs how the stage is built — outline, roster, one page
per `generate_scene`, audio before done. This skill governs what the stage
contains and how it sounds.

## The shape

- **Scene 1 is a `slide`** that opens the lecture properly — the question the
  subject answers, why it is worth an hour, and the route the lecture takes
  through it. Not a definitions page and not a table of contents.
- **The body is `slide` pages, in arcs.** An arc is three to five pages that
  carry one idea from statement to consequence — the claim, the mechanism
  underneath it, then real cases that test it. Arcs follow each other; the
  lecture never restarts.
- **Checkpoints are rare.** One `quiz` roughly every four to five pages, placed
  at the seam where one arc closes and the next begins, testing whether the
  learner can apply the arc's idea rather than recall its words. Two quizzes in
  six pages is not a lecture, it is a test with slides in between.
- **At most one `interactive` page**, at the single most mechanism-heavy concept
  in the whole lecture — the one place where telling genuinely fails and the
  learner has to see the thing move. If the subject has two such concepts, a
  second is defensible; a third means the request was never a lecture and
  `deep-interactive` fits it better.
- **Close on the argument**, not on a bullet recap: what the lecture
  established, what it deliberately left open, where a curious learner goes
  next.

## Page density

Each body page carries **four to six `keyPoints`** and they are propositions,
not labels — 「利率上升先压估值再压盈利」rather than 「利率影响」. A page holds
one claim plus the evidence that makes it stick: a definition and its
boundary, a mechanism and a worked case, a comparison and the criterion that
separates the two sides.

Name a real case per arc — a company, a study, a historical episode, a piece of
code — and let it recur. A lecture that cycles through a fresh unexplained
example every page teaches nothing about any of them.

## Narration is the lecture

This is where the style is heard, so it is the part to get right.

- Every body page gets **a long, continuous stretch of teacher speech** — four
  to six sentences per line rather than a caption, and several lines to a page.
  The learner should be able to close their eyes and still follow.
- Narration **moves forward**. Each line picks up the last one's final idea:
  state it, explain the mechanism, then walk a concrete case through that
  mechanism until the conclusion is unavoidable.
- The register is an authority thinking aloud in front of a room — full
  sentences, confident, unhurried, occasionally naming what is hard about the
  idea before resolving it.
- The assistant speaks **rarely**, and only to ask the question the room is
  already thinking, which the teacher then answers at length. One such
  exchange per arc, at most.
- Forbidden in this style: 「大家想一想」-style prompts with nothing behind
  them, one-line captions that restate the slide's title, and cheerleading
  (「太棒了」「让我们开始吧」).

Examples of the right length and motion:

- Good: 「我们先把定义钉住——所谓久期，不是债券还剩多少年，而是价格对利率的
  敏感度……接下来看 2022 年的例子，同样的加息幅度，为什么二十年期的跌幅是五年期
  的四倍多。」
- Bad: 「这一页讲久期。久期很重要。下面我们来看例子。」

## The roster

The runtime allows **exactly one teacher**, and in this style that teacher is
the lecturer — the whole course is their voice. Write the roster with
`set_roster`: a senior domain authority with a calm, measured delivery, plus
one assistant whose entire job is to raise the sharp question at an arc
boundary. Keep the roster small; a crowded classroom fragments a lecture. Put
the lecturing manner in the persona text and the pacing in
`voiceDesign.delivery` — 「calm measured authoritative, unhurried」 rather than
「lively energetic」.

## Carrying the style into the generators

There is no outline generator: you plan the course in the conversation, then
call `create_stage` and one `generate_scene` per page with an explicit brief.
Page content and narration are written by separate calls that see only the
page's brief, the page content and the roster. So the style has to be carried
there explicitly:

- put the arc structure and the density expectation into each page's
  `generate_scene` `brief`;
- put the lecturing manner into each persona of `set_roster`;
- pass the narration directive for each page in `generate_scene.materialFacts`
  — e.g. 「旁白为连续讲述，四到六句一段，先定义再机制再案例」「本页复用前一页
  的同一家公司作为案例」. Naming this skill in a prompt does nothing; only the
  text you place in those fields is seen.

## Scene naming

Titles are the lecture's own steps, in the language of the subject.

- Good: 「久期到底在度量什么」「同样加息，为什么长债跌得更狠」「三个反例，和它们
  的共同点」
- Bad: 「概念介绍」「案例分析」「本课总结」

## If the request is not a lecture

If the user wants to practise a skill, produce something of their own, or work
through exercises, say so in one sentence and use `workshop-style` instead.
Wrapping a practice request in a lecture produces a course the learner watches
and cannot use.
