# Application workbench integration

The optional application panel sits between the IDE and learning assistant. Narrow workbenches stack the panels. Opening the panel immediately shows startup progress. Collapsing hides and makes it inert without stopping its managed process or reloading its iframe. Fullscreen remains owned by the existing OpenMAIC classroom host; no new portal or runtime is introduced.

## Existing execution boundaries

- Agent execution stays on the server. Learner applications run in the provider sandbox through the existing command registry and isolated preview gateway.
- Explicit open/restart keeps current ownership, study revision, environment epoch, saved-file and busy checks, and idempotent startup receipts. The panel never bypasses these checks or starts applications through Agent diagnostics.
- Editing, Agent work, assessment or loss of environment readiness removes the interactive preview. Once ready, the learner explicitly reopens it; mutations are never replayed. Existing shutdown-before-write/evidence/archive protections remain intact.
- Environment changes discard stale responses and previews. Existing five-minute preview grants remain unchanged. After expiry, deliberate reopening obtains access again.
- Completed applications retain explicit environment restoration and read-only source. Reading source/reports or folding the panel does not allocate an environment or advance teaching.

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
