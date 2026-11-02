# Workspace guide

A short introduction to basic workbench controls: progress/task bar, assistant,
code area, application preview when present, and the replay button. There are
five pages (four without an application). The guide does not explain future
learning stages; the task bar provides the current stage's instructions.

## Entry and persistence

Hero entry shows a modal loading barrier while the environment and project files
connect. It blocks pointer and keyboard interaction, including fullscreen controls.
The barrier releases for errors or repeated stream failures so recovery controls
remain usable. It does not return during ordinary reconnection after initial entry.

A new project opens the guide after Hero expansion settles, the environment is
ready and a connected stream supplies a matching current workbench snapshot.
Entry uses a layout effect to hand off from loading to the guide before paint.
It does not wait for the assistant's opening response to finish. Retained drafts
and actual prior input defer automatic entry. Existing studies use the
**Workspace guide** toolbar button once the workspace is ready.

The card must be completed: it has Previous, Next and Finish controls, with no
skip, close, outside-click or Escape dismissal. Completion records the device-local
preference `openmaic:pbl-v3:onboarding:v1=seen`. This preference applies across
projects in this browser, independently of study/editor drafts. A denied browser
store falls back to the current tab's memory. Replay is always available when ready.

Actionable workspace/assistant errors and reports take precedence. Stream
`connecting`/`retrying` states keep the current guide page through tab switches
and online events; only terminal unavailability or real environment loss closes it.
A current revision is required for entry, but an ordinary HTTP/SSE revision gap
does not interrupt an open guide. Completed read-only workspaces can replay it
without preparing an execution environment.

## Interaction boundary

The existing Radix modal primitives portal inside the workspace, preserving native
fullscreen and focus isolation. The background is dimmed except for the actual
region being introduced, which still cannot be operated during the guide. The
assistant page lights the whole panel. Targets scroll into view before measurement
and are resolved again when the DOM changes. A collapsed code/preview area uses
its own toolbar control; an unavailable or off-screen target uses a centered card
without highlighting an unrelated control. Copy names regions rather than screen
directions. Page changes focus Next, and completion restores a usable entry point.

Guide navigation performs no learning commands, preview launches, report requests
or file edits. Background work continues. An open application receives inputPaused:
readiness, candidate promotion and document identity continue independently. On
completion input returns only when ordinary environment/save/update gates permit it.

## Verification

Unit tests cover capability routing, preference failures and entry prerequisites.
Browser tests cover loading input isolation and recovery, completion/focus, retained
drafts, existing/completed projects, HTTP/SSE gaps, online/visibility reconnects,
live anchors, collapsed panels and narrow expanded/docked layouts. Application
specs cover nested input isolation and native fullscreen without reloading preview.

Fixtures use synthetic courses and mocked learning/preview endpoints with the real
classroom UI and stream parser. They do not establish real model, cloud or production
execution. All twelve locales use the same short guide structure and terminology.
