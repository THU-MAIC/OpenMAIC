# Workspace guide

A short introduction to progress/tasks, the assistant, code, application preview
when present, and replay. A declared application opens automatically once its
environment is ready; closing it is remembered for this workspace visit. The
application guide page lights both its visible panel and its toolbar toggle.
There are five pages (four without an application).
The task bar provides the current learning stage's instructions. Its drawer is
available from the first step and begins with the current milestone's authored
goal and outcome; changing milestones replaces this summary.

## Learner-wide V3 entry

The guide auto-opens once per learner across V3 projects. The server aggregates
receipts and existing learning progress across that owner's V3 studies; no
course ID, recruitment flag, referrer, browser preference or PBL V2 history is used.
Existing V3 stage advancement, completed projects, real learner messages,
orchestration progress and durable learner file/command/terminal activity count
as seen, including progress reset/archive discard. Assistant-generated evidence
does not exempt a learner.
Preparation and the automatic assistant opening alone do not count as learning.
The existing study receipt remains an idempotent storage anchor, but its effect
is learner-wide; no additional preference table or migration is required.

An unseen learner's guide opens after Hero expansion, environment preparation
and a current connected workspace snapshot. Docking during restoration does not
cancel eligibility. Restored drafts, focus in an editable field or actual editing during restoration defer
automatic entry for this visit, even if that draft is later cleared. They never
prevent manual replay. A layout effect transfers modal ownership before paint
when eligible; the assistant's opening reply can continue in the background.

Previous, Next, Finish, Close and Escape remain available. Outside clicks do not
close the guide. Close, Escape and Finish close immediately and restore focus,
then send an owner-checked background receipt to `POST /api/pbl/v3/onboarding`.
Failure or a bounded-out request never blocks learning; the next untouched entry
may show the guide again and retry. The receipt changes no learning state,
revision, files or environment. Header replay remains available to everyone,
including completed read-only projects.

Only a new project's initial Hero entry uses the loading barrier, and only while
open/prepare is actually in flight. Continue Project, busy/completed studies and
idle recovery states remain usable. A bounded wait releases the barrier without
cancelling or repeating an unconfirmed request; error/recovery controls and return
remain accessible. Tutorial eligibility is independent of this loading policy:
an unseen learner with no drafting interaction can still see the guide after recovery.
Transient visibility/online reconnection and HTTP/SSE revision gaps keep the current
page. Real unavailability or actionable errors interrupt it, including completed
projects with saved files: those files bypass environment requirements only. Completed read-only
workspaces need no execution environment to replay the guide.

A fresh study begins at the authored overview when it becomes visible, even if
the learner already completed the guide in another project. Automatic welcome
output does not move that initial reading position. Sending a message or choosing
Latest resumes the existing follow-tail behavior; upward reading still releases
it. Returning to an existing transcript and replaying the guide do not reset the
reading position to the overview.

## Interaction boundary

Radix modals portal inside the workspace, preserving native fullscreen and focus
isolation. Closing restores focus immediately without waiting for acknowledgement.
Native fullscreen changes rebuild only the modal focus/aria boundary; the guide
step, workbench and preview stay mounted. The background is dimmed except for the introduced region, which remains
blocked for interaction. The assistant page lights the whole panel; the progress page lights the whole task bar. Targets are clipped to each overflow ancestor’s visible viewport and scroll
into view before measurement and are resolved again when DOM nodes change.
Collapsed code/preview areas use their own toolbar controls; unavailable/off-screen
targets use a centered card without an unrelated spotlight. Copy names regions
rather than directions. Page changes focus Next; completion restores a usable entry point.

The conversation jump control floats in a fixed right gutter outside the text,
so appearing/disappearing never resizes the viewport or interrupts follow-tail.
Hide this control while a modal blocks its interaction; it resumes after dismissal.
On narrow assistant pages, the card sits above the reading viewport with a bounded,
scrollable body. At 320px, compact header/footer spacing and a footer counter leave
room for the guide’s own explanation without covering the reading viewport.
The modal forwards wheel and single-touch reading gestures only
inside the highlighted conversation viewport, allowing later paragraphs and a
streaming welcome's closing question to be read. Clicks remain blocked and focus
stays in the guide; reading never submits a learning command.
Page navigation performs no learning commands, preview launches, report requests
or file edits. Finish only records guide completion. Background work continues.
An open application receives inputPaused; readiness, candidate promotion and document
identity continue independently. Input resumes only when normal readiness/save gates allow.

## Verification

Unit tests cover learner-wide eligibility, drafting deferral and manual replay,
entry/recovery and legacy browser records. Real PostgreSQL tests cover cross-project
receipts, owner isolation, existing V3 progress, real first-stage workspace
operations, automatic openings and unchanged learning state. Browser tests cover background receipt failures and hung requests,
continued typing during restore, completed read-only entry, visible small-screen
assistant text, reconnects, narrow expanded/docked layouts and native fullscreen.

Browser fixtures use synthetic courses and mocked learning/preview endpoints with
the real UI/stream parser. They do not establish live model, cloud or production
execution. Other learning specs explicitly represent studies whose guide is complete.
All twelve locales use the same short guide structure and terminology.
