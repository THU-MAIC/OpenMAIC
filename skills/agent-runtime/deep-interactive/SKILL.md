---
name: deep-interactive
title: "深度交互"
description: Deep Interactive courses. Plans the course so the learner manipulates something on most pages — simulations, diagrams they explore, code they run, games, 3D scenes — with slides reserved for the opening frame and the closing consolidation. Use when the topic has a mechanism, a variable to vary, a process to trace, or a structure to inspect.
---

# Deep Interactive course design

Default to **doing**, not reading. A page earns the `slide` type only when the
learner has nothing to manipulate on it.

## Structure

- Scene 1 is a `slide`: it frames the question the course answers and tells the
  learner what they are about to play with. One page, no more.
- The body is `interactive`. Each body scene isolates **one** mechanism, one
  variable, one structure — so the learner can change it and watch the result.
- The last scene is a `slide` or a `quiz` that consolidates what the
  manipulation showed.
- Consecutive interactive scenes must not use the same `widgetType`. Two
  simulations in a row is a design failure; vary the modality as the concept
  moves from "watch it" to "trace it" to "predict it".

## Choosing a widget type

| widgetType        | Use when the learner should…                                     |
| ----------------- | ---------------------------------------------------------------- |
| `simulation`      | vary parameters and watch a system respond in real time          |
| `diagram`         | explore structure, flow or hierarchy by expanding and following  |
| `code`            | read, modify and run a short program that embodies the idea      |
| `game`            | make repeated decisions under a rule set and see the score move  |
| `visualization3d` | inspect a spatial object or scene from angles a slide cannot show |

## widgetOutline

Every `interactive` scene must carry a `widgetOutline` populated for its type —
an interactive scene with an empty widget outline degrades to a generic page and
defeats the whole point.

- `simulation`: `concept`, `keyVariables` (the actual sliders/inputs)
- `diagram`: `diagramType`, `nodes` (with `label`, and `parentId` for hierarchy)
- `code`: `language`, `concept`
- `game`: `gameType`, `challenge`, `playerControls`
- `visualization3d`: `visualizationType`, `objects`, `interactions`

## Scene naming

Titles name what the learner does or discovers, not the topic heading.

- Good: 「拖动倾角，看射程怎么变」「顺着数据流走一遍」「猜下一步会发生什么」
- Bad: 「抛体运动」「数据流概述」「知识点回顾」

## keyPoints

For an interactive scene, `keyPoints` describe the **interaction and what it
reveals** — what the learner changes, what they observe, what conclusion the
observation forces. Not a bullet list of facts to be read out.
