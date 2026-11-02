# Workspace guide

A short introduction to progress/tasks, the assistant, code, application preview
when present, and replay. There are five pages (four without an application).
The task bar provides the current learning stage's instructions.

## Required V3 project entry

Every V3 workbench entry reads the server's guide completion for the authenticated
owner's study. There is no hard-coded course ID, recruitment flag or referrer test.
A study identifies this learner's V3 project; PBL V2 history and legacy browser
preferences never exempt entry. The same rule covers direct links, platform
browsing, existing studies and interrupted first visits.

An unfinished guide opens once Hero expansion, environment preparation and a
current connected workspace snapshot are ready. Missing completion metadata also
counts as unfinished. A layout effect transfers loading/modal ownership before
paint. Eligibility follows the Hero visit even if the learner docks the workbench
before restoration finishes; the initial expansion still must settle. The assistant's opening reply can continue in the background. Restored
drafts remain intact and no longer suppress this required guide.

The card has Previous, Next, Finish and Close controls. Escape also closes it;
outside clicks do not. Close, Escape and Finish all count as seen and send an
idempotent, owner-scoped acknowledgement to
`POST /api/pbl/v3/onboarding`. Only a confirmed response closes it. Failure keeps
the card open with a retry message. The service records `onboarding_completed_at`
on this V3 study without changing its learning state, revision, files or environment.
The completion timestamp means the learner finished or explicitly closed the guide.
It survives refresh and device changes; a different owner or V3 project
has its own record. Completed guides do not auto-open; toolbar replay remains available.

Only a new project's initial Hero entry uses the loading barrier, and only while
open/prepare is actually in flight. Continue Project, busy/completed studies and
idle recovery states remain usable. A bounded wait releases the barrier without
cancelling or repeating an unconfirmed request; error/recovery controls and return
remain accessible. Tutorial eligibility is independent of this loading policy:
an unseen V3 project still shows its guide once ready, including after recovery.
Transient visibility/online reconnection and HTTP/SSE revision gaps keep the current
page. Real unavailability or actionable errors interrupt it, including completed
projects with saved files: those files bypass environment requirements only. Completed read-only
workspaces need no execution environment to replay the guide.

## Interaction boundary

Radix modals portal inside the workspace, preserving native fullscreen and focus
isolation. The background is dimmed except for the introduced region, which remains
blocked for interaction. The assistant page lights the whole panel; the progress page lights the whole task bar. Targets scroll
into view before measurement and are resolved again when DOM nodes change.
Collapsed code/preview areas use their own toolbar controls; unavailable/off-screen
targets use a centered card without an unrelated spotlight. Copy names regions
rather than directions. Page changes focus Next; completion restores a usable entry point.

The conversation jump control has a reserved lane outside the text viewport.
Page navigation performs no learning commands, preview launches, report requests
or file edits. Finish only records guide completion. Background work continues.
An open application receives inputPaused; readiness, candidate promotion and document
identity continue independently. Input resumes only when normal readiness/save gates allow.

## Verification

Unit tests cover entry/recovery, completed studies, legacy browser records and
completion API validation. A real PostgreSQL test covers migration, owner/project
isolation, idempotency and unchanged learning progress. Browser tests cover mandatory
entry with drafts, interrupted existing studies, absent metadata, acknowledgement
failure/retry, online/visibility reconnects, live anchors, collapsed regions, narrow
expanded/docked layouts and application input isolation/native fullscreen.

Browser fixtures use synthetic courses and mocked learning/preview endpoints with
the real UI/stream parser. They do not establish live model, cloud or production
execution. Other learning specs explicitly represent studies whose guide is complete.
All twelve locales use the same short guide structure and terminology.
