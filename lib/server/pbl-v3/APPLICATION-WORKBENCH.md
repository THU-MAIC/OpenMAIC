# Application workbench integration

The optional application panel sits between the IDE and learning assistant. Narrow workbenches stack the panels. Opening the panel immediately shows startup progress. Collapsing hides and makes it inert without stopping its managed process or reloading its iframe. Fullscreen remains owned by the existing OpenMAIC classroom host; no new portal or runtime is introduced.

## Existing execution boundaries

- Agent execution stays on the server. Learner applications run in the provider sandbox through the existing command registry and isolated preview gateway.
- Explicit open/restart keeps current ownership, study revision, environment epoch, saved-file and busy checks, and idempotent startup receipts. The panel never bypasses these checks or starts applications through Agent diagnostics.
- Editing, Agent work and assessment suspend input while keeping the rendered application visible. An already open panel checks status when work finishes (or saved-source revision changes): an unchanged running application keeps its document and client state; a stopped application opens again and changed running sources restart through the existing authorized endpoint. The old document remains visible and inert until its replacement loads. No application operation or uncertain mutation is replayed. Never auto-launch an unopened/collapsed panel, or auto-restore an unavailable environment. Existing shutdown-before-write/evidence/archive protections remain intact.
- Environment changes discard stale responses and previews. Signed preview grants still last five minutes. Authenticated real input in the embedded preview renews its HttpOnly cookie and updates only the workbench's display deadline; passive requests never renew it. Idle/expired or revoked access cannot renew itself. New-tab access obtains a fresh owner-authorized ticket without reloading the embedded document; standalone tabs retain fixed expiry.
- Local expiry hides and makes the mounted iframe inert, so an already authenticated renewal response arriving late can restore the same document. A notification never grants server access; expired/revoked cookies still fail gateway checks. A busy turn keeps the inert document; environment/epoch changes discard it immediately. Automatic recovery is driven by the completed work/revision transition, never an idle timer or passive polling. Embedded and new-tab opens share bounded readiness retries with one launch receipt; failed readiness is visible in the workbench without removing an existing document or retrying indefinitely.
- Periodic dirty-file backup waits for running applications without clearing the dirty marker. Explicit evidence, file writes, checkpoints and idle release still quiesce applications. The application process uses the existing one-hour supervisor envelope independently of the renewable environment lease; ordinary command timeout limits are unchanged.
- Completed applications retain explicit environment restoration and read-only source. Reading source/reports or folding the panel does not allocate an environment or advance teaching.

Pausing evacuates focus only when it belongs to the embedded preview, including
its nested application frame. It never restores stale focus or moves focus away
from an editor/chat control. Production iframe URLs opt into owned-shell input
control with `openmaic-input=1`. The shell starts paused and accepts enable/disable
only from a trusted message with the exact parent window and configured app origin.
It makes the actual application document root inert, preserving its prior inert
value on resume; ordinary autofocus cannot re-enter a paused or collapsed input.
Initial nested documents stay hidden until readiness applies that input state.
Control messages never count as activity. A valid renewal response already in
flight remains accepted during pause; unsent debounced activity is dropped.
If parsing/autofocus still moves focus into an unready or paused frame, a deferred
ownership check returns it only to a connected, usable host target (or the owning
workbench region). It never pulls focus back from another host control or an
inactive window, and does not provide the keyboard security boundary.
Old hosts omit the flag and retain their existing gateway behavior. Direct-HTML
fixtures exercise legacy parent-frame handling, not this production input bridge.
An unchanged `starting` process receives bounded,
read-only status retries; exhaustion keeps its document with a nonfatal starting
message and an explicit reopen control. Changed sources restart even while the
process is `starting`. Automatic recovery checks the latest accepted grant deadline
before each readiness retry and before accepting a result; expiry requires explicit input.

An interrupted, unacknowledged launch retains its exact request and idempotency ID.
Recovery may retry that receipt only in the same study/environment/epoch, revision
and teaching stage; it never changes an old ID's inputs. Any successful response to
that exact launch acknowledges it, including a late response whose document is no
longer accepted. A newer version discards the obsolete request and inspects current
state instead. Document replacement intent remains independent until the current
candidate is ready. Explicit reopen rechecks pending source recovery, including
when its preceding automatic status response crossed the grant-expiry boundary.

The owned gateway shell reports readiness only after its nested same-origin HTML
document completes. Workbench promotion checks the exact current candidate window
and isolated origin; an application frame's own messages cannot promote it. Shell
load and authorization alone are insufficient. Auth/load failures retain the old
document, and missing readiness becomes an explicit error/reopen state after 60 seconds.
Static bootstrap failure messages contain no credentials and cannot renew access.
Deploy the main app and preview gateway from the same revision. An old workbench
ignores new readiness messages; a new workbench with an old gateway reaches that
bounded failure rather than silently discarding the previous page or waiting forever.

## Course guidance

Keep the application description short. Put ordinary actions in the application itself and explain unfinished functions or operation errors when they occur. Application-specific state persistence belongs in the course guide, not a universal platform notice. The optional help control contains secondary instructions. Agents must describe the dock and current controls from product context; no course should continue directing learners to an application dialog.

## Sharing and Java integration

Open in new tab is temporary preview access, not public publication. This change introduces no public sharing/revocation API and does not make preview grants into stable work links. Public sharing still needs an explicit audience/interface policy, revocation and coordination with environment inactivity and cost management. Standalone input remains unobserved by the workbench and cannot be promised to renew activity.

The existing application package contract currently admits Python entrypoints. This layout does not add the Java artifact/startup/readiness adapter required by the future FS course, nor import OpenPBL RuntimeHost/SQLite/ECS orchestration.

## Beta review follow-ups

- File-link ranges are one-shot navigation requests, consumed in the workspace after Monaco applies them. Switching files cannot replay an old selection; clicking the link again creates a fresh request.
- Collapsed application panels cannot participate in user resizing. The iframe remains mounted, while the visible workspace/assistant divider resizes only the visible panes.
- Recovering an acknowledged learner save uses authoritative change ranges, including an empty list, without erasing later typing. Retrying a teaching turn uses the current UI locale as control metadata, never new learner feedback.
- Reports resolve committed learner handoffs before sampling. Hidden SDK message frames do not consume visible-history quotas; oversized canonical handoff text is excerpted with omission markers rather than dropping its identity; ordinary SDK payloads retain their byte ceiling. Raw durable history and the existing projection budgets remain intact.
- Completed learning evidence is immutable. Restoring its runtime application workspace cannot reopen teaching or revoke recorded completion. A state-preserving operational revision carries saved report analysis and any active report claim forward atomically; actual learning changes still invalidate analysis.
- Report analysis retains its existing 90-second budget across model resolution, primary and fallback, below the two-minute claim expiry. This does not limit teaching Agent duration, tool calls, reasoning or output.
