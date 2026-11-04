# Application workbench integration

The optional application panel sits between the IDE and learning assistant. Narrow workbenches stack the panels. Opening the panel immediately shows startup progress. Collapsing hides and makes it inert without stopping its managed process or reloading its iframe. Fullscreen remains owned by the existing OpenMAIC classroom host; no new portal or runtime is introduced.

## Existing execution boundaries

- Agent execution stays on the server. Learner applications run in the provider sandbox through the existing command registry and isolated preview gateway.
- Explicit open/restart keeps current ownership, study revision, environment epoch, saved-file and busy checks, and idempotent startup receipts. The panel never bypasses these checks or starts applications through Agent diagnostics.
- Standalone startup reserves the sandbox command before releasing admission locks. Provider dispatch runs afterward, so the teaching lock stays available while startup waits. A workspace write or stop can cancel that reservation before the supervisor starts it.
- Formal tests for a standalone preview execute against a private working copy verified against the captured source digest. A running preview remains interactive during tests and the comparison that admits the quiz. Collection still compares the live source fingerprint to the assessed revision. Explicit code writes and durable checkpoints keep their existing writer protections.
- Source changes and assessment can suspend input while keeping the standalone document visible. Read-only teaching can keep a running application interactive. An already open panel checks status when work finishes (or saved-source revision changes): an unchanged running application keeps its document and client state; a stopped application opens again and changed running sources restart through the existing authorized endpoint. The old document remains visible and inert until its replacement loads. No application operation or uncertain mutation is replayed. A declared preview opens automatically when entering a ready workspace. Respect explicit collapse and never auto-restore an unavailable environment. Slow standalone status probes run outside the study lock. Result validation uses a short sandbox lock and checks recorded writers before accepting readiness. Existing shutdown-before-write/evidence/archive protections remain intact.
- Environment changes discard stale responses and previews. Signed grants last five minutes. Real input can renew the embedded cookie and register learner activity. A visible workbench showing a standalone preview also exchanges a fresh owner-authorized grant before its deadline or when returning to the tab. This exchange keeps the existing iframe and is bounded by the live provider lease. It does not count as learner activity or extend the sandbox lifetime. Revoked environments cannot exchange grants. New-tab previews retain fixed expiry.
- Local expiry hides and makes the mounted iframe inert, so an already authenticated renewal response arriving late can restore the same document. A notification never grants server access; expired/revoked cookies still fail gateway checks. When input is suspended the document remains mounted; environment/epoch changes discard it immediately. Automatic recovery is driven by the completed work/revision transition, never an idle timer or passive polling. Embedded and new-tab opens share bounded readiness retries with one launch receipt; failed readiness is visible in the workbench without removing an existing document or retrying indefinitely.
- Periodic dirty-file backup runs alongside a running application and never stops it. The copy is a recovery fallback, not evidence: restored sources are fingerprinted again, and application-owned data may be from mid-run. Explicit evidence, file writes, stage checkpoints and idle release still quiesce applications. The application process uses the existing one-hour supervisor envelope independently of the renewable environment lease; ordinary command timeout limits are unchanged.
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
candidate is ready, including the initial launch. After initial authorization or
readiness failure, explicit reopen obtains a fresh ticket instead of retaining a
never-ready document. A successfully ready document still keeps its client state
when the process is unchanged. Explicit reopen rechecks pending source recovery, including
when its preceding automatic status response crossed the grant-expiry boundary.

The owned gateway shell loads standalone HTML from the root URL with a reserved query selector. Root API requests and ordinary forms reach the application; the selector is stripped from implicit POST submissions. Standalone bootstrap checks the signed binding before setting the cookie. Serving the document still validates the live provider. Legacy applications still load from their own root. The shell reports readiness only after its nested same-origin HTML
document completes. Workbench promotion checks the exact current candidate window
and isolated origin; an application frame's own messages cannot promote it. Shell
load and authorization alone are insufficient. Auth/load failures retain the old
document. Missing readiness exposes a document-only retry after 15 seconds for standalone previews. Legacy previews retain the 60-second readiness budget.
Static bootstrap failure messages contain no credentials and cannot renew access.
After its static bootstrap starts, the shell applies an additional `script-src 'none'`
CSP policy before authorization or app loading. Existing callbacks continue, while
new shell scripts are blocked even with a copied nonce or a nonce learned from CSP
violation reports. Removing or changing the policy element cannot relax the applied
policy. The nested app is a separate document and retains its own script policy.
This hardens shell script-injection readiness claims; it does not introduce a new
isolation boundary between the same-origin app and its shell.
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
