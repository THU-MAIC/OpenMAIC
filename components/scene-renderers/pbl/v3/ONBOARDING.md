# Workbench onboarding

The v3 workbench guide connects the live interface to the installed learning
journey: teaching, decisions, plan, implementation, tests, quiz and reflection.
It has 13 pages, or 12 when the project has no application capability. Tour
pages do not count as learning steps. The progress explanation reads the real
milestone and installed steps; it never changes progress or opens future tasks.

## Entry and persistence

A new project starts the guide after the Hero expansion has settled, the learning
environment is ready, and the connected stream supplies a matching current
workbench snapshot. It does not wait for the assistant's opening response to finish.
Browsing the layout while connecting does not cancel automatic entry. Actual
input or retained drafts defer it; interaction after readiness also takes precedence.
Existing studies use the **Workbench guide** toolbar button once the workspace is ready.
The button also replays the guide after skipping or finishing it.

Skipping, closing and finishing share the device-local preference
`openmaic:pbl-v3:onboarding:v1=seen`. It applies across projects in this browser,
not across devices or accounts. A denied browser store falls back to the current
tab's memory. This optional preference is separate from study and editor drafts.
Actionable workspace/assistant errors and the report take precedence over the guide.
Connection or environment loss closes an open guide; reconnecting does not reopen it
automatically during the same visit. A completed read-only workspace can replay it
without preparing an execution environment.
An ordinary HTTP reply can advance the learning revision before its SSE workspace
snapshot arrives; this temporarily defers entry without closing an already open guide.

## Interaction boundary

The guide uses the existing Radix modal primitives, portalled inside the
workspace so it remains in the native fullscreen subtree. The spotlight marks
real visible regions; unavailable or collapsed targets fall back to an existing
toolbar control. The highlighted region remains blocked for interaction.
The card traps focus, supports Escape, and returns focus to a connected, usable
entry point. The task drawer and milestone menu retain their own state while
deferring Escape to the modal.

Opening, moving through and closing the guide sends no learning commands,
preview launches, report generation requests or file edits. Existing background
learning work continues. An open application receives `inputPaused` only:
its authorization shell blocks nested input while readiness, candidate promotion
and document identity continue independently. Closing the guide restores input
only when the ordinary environment, save, update and readiness gates permit it.

## Verification

- `tests/pbl/v3/onboarding.test.ts`: capability routing and optional storage.
- `tests/pbl/v3/application-preview-client.test.ts`: readiness during a modal,
  document identity, no relaunch and continued enforcement of dirty-file gates.
- `e2e/tests/pbl-v3-onboarding.spec.ts`: first entry, replay, completion,
  keyboard/focus, current quiz and drafts, missing application and narrow layouts.
- `e2e/tests/pbl-v3-application.spec.ts`: the actual gateway shell, nested input
  isolation, autofocus attempts and native fullscreen with a running application.

The browser fixtures use synthetic course data and mocked learning/preview
endpoints. They exercise the real classroom, UI and stream parser, and make no
claim about real model, runner, cloud or production execution. Existing learning
specs mark this optional guide as seen; guide specs opt into first-entry behavior.
Copy is under `pblV3.onboarding` in all twelve locale resources.
