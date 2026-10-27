# Agent Guidance

Guidance for coding agents working in this repository, including the automated Codex review that runs on every non-draft pull request. The contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Code Review Rules

### Severity

- P1 is only for problems that produce wrong behavior at runtime: user-visible breakage, data loss, data exposed across owners, an authentication or access-control bypass, a storage migration that fails on an existing database, a published package that ships broken, or a leaked secret.
- Inaccuracies that only affect documentation, comments, skill text or the PR description are at most P2. Do not report wording that cannot cause a failure or a wrong action.
- Do not report pure style, naming or readability preferences.

### Context and scope

- Read the PR description before reviewing. Do not raise an issue the description already accounts for (handled in another PR or issue, or a deliberate trade-off with its reason) unless you can show that explanation is wrong.
- Do not raise again an issue whose thread already has a reply explaining why it stays.
- When reviewing new commits, report only problems introduced or exposed by the new or changed code. Do not add edge cases on code the push did not touch.
- Do not report pre-existing behavior that the PR does not change.
- When a fix needs changes outside the PR (callers, documentation, other packages), name the file paths.

### Focus areas

- Owner scoping: reads and writes of courses, sessions, materials and settings stay within the requesting owner.
- Storage schema changes (`packages/@openmaic/storage`): compatible with databases that are already deployed.
- Published packages (`packages/@openmaic/*`): a change to published behavior comes with the version bump described in [Changing a Published Package](CONTRIBUTING.md#changing-a-published-package).
- Provider neutrality: shared layers do not hard-code a specific model or service vendor; vendor-specific behavior stays in that provider's module.
- Server-side requests to user-supplied URLs go through the existing URL guard.
