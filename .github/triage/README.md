# Issue triage

This workflow reads an issue, its discussion, cross-references, related issues/PRs and the default-branch source. Codex proposes classification, relevant code, missing information and a next action. Trusted JavaScript validates the output and optionally adds labels and creates or updates one bot comment. It does not execute reproductions or create fixes.

## Enable and roll out

1. Merge the workflow into the default branch. Configure the repository Actions secret `ISSUE_TRIAGE_OPENAI_API_KEY` with a dedicated OpenAI project credential. Configure that project's usage limits; model calls consume API usage even in dry-run mode. Allow the SHA-pinned actions in the organization's Actions policy if necessary.
2. Optionally set the repository variable `ISSUE_TRIAGE_MODEL` to an API model available to the project. When unset, the pinned Codex CLI chooses its default model. The action and CLI are pinned separately; update and smoke-test them together.
3. In **Actions → Issue Triage → Run workflow**, select the default branch, enter a positive issue number and leave **publish** unchecked. Inspect the job summary and the `issue-triage-report-<attempt>` artifact. `report.json` contains the assessment and exact proposed changes, including suggestions that are ineligible for automatic application. `comment.md` is the proposed public comment. Context and reports expire after seven days.
4. Sample 20–30 historical issues across areas, languages, incomplete reports, existing maintainer responses, and linked PRs. Check classification, useful questions, false duplicate/PR associations and comment suppression against maintainer judgment. Suggested initial cases: #1362 (maintainer already requested details), #1434 (PR #1435 already exists), #1438 (maintainer already invited a PR). These are examples, not claims that a live model evaluation has passed.
5. Set `ISSUE_TRIAGE_MODE=dry-run` to generate reports automatically for newly opened human-authored issues. After reviewing quality and usage, change it to `apply` to enable automatic publication. Unset the variable or set it to `off` to stop new automatic runs. Cancel any already running publication jobs when stopping an active rollout.

Manual runs default to report-only even when the repository mode is `apply`. Checking **publish** explicitly applies eligible changes for that one issue, including when automatic mode is off. Manual dispatch requires GitHub repository write access. The workflow only operates in `THU-MAIC/OpenMAIC` on the default branch. Forks, bot-authored automatic events, closed issues and locked issues do not run analysis. To re-evaluate an edited issue or reporter reply, dispatch manually; issue edits, comments, labels and PR events do not trigger this first version.

## Publication rules

- Confidence below 0.85 produces a report with no automatic labels or comment. Confidence is the model's estimate, not a calibrated probability.
- Add only existing allowlisted type/area labels. Any existing label in the corresponding group takes precedence; no label is ever removed. Questions map to the existing `type:question` label. Priorities, duplicate decisions, assignees, closing issues and fixes remain maintainer decisions.
- Add `status:needs-info` only when there is no existing status label and a concrete question will be posted. A selected related open PR prevents a needs-info comment. Existing labels are not automatically corrected or removed on subsequent runs.
- A comment must add useful information. Once a human OWNER, MEMBER or COLLABORATOR has participated, public comments are suppressed. Existing `status:*`, `duplicate`, `invalid` or `wontfix` labels and long/truncated discussions also suppress comments. These cases still produce an assessment and eligible basic labels. Remove a stale status label explicitly before asking the bot to post a new question.
- Reuse only a comment authored by `github-actions[bot]` whose body starts with the versioned marker. A human copying the marker cannot have their comment overwritten. Rerunning an unchanged result does not post another comment.
- Re-read the issue, comments and timeline before applying anything. If the snapshot has changed or the issue is now closed/locked, skip publication and request a manual rerun in the run summary. GitHub does not provide a transaction spanning comments and labels: an edit arriving after that final read can still race with publication, and an API failure can leave a partial application. Re-running is safe and preserves human labels.

## Execution boundaries

The analysis job has read permissions only. It uploads the original context **before** invoking Codex, then runs Codex last with a read-only sandbox and `drop-sudo`. The model has no write-capable GitHub token and does not run project code or install project dependencies. Issue content is untrusted input, never interpolated into shell commands or JavaScript. Public issue authors are explicitly permitted via the action's `allow-users: '*'` only after the automatic-mode opt-in; a ten-minute job timeout bounds each analysis. There is no global request quota in this workflow, so review usage during rollout.

The report job validates output without issue write permissions. Only the separate publish job receives `issues: write`; it re-validates the same bounded schema, references and tracked source paths against the original context. Model output is never executed. Public text is escaped and mentions/external URLs are neutralized; source and issue links are constructed from verified repository paths and supplied candidate numbers.

Candidate retrieval is bounded to recent issues/PRs, two title searches and explicit references/cross-references, with at most 30 issues and 30 PRs sent to the model. It is not an exhaustive duplicate index and cannot establish that no related work exists. Missing source evidence must remain uncertainty. Current main may differ from the reporter's release. No model output establishes that a bug was reproduced, and no fixes or maintainer messages are generated during local tests.

## Local verification

```sh
node --test .github/scripts/issue-triage.test.mjs
```

These dependency-free tests exercise context collection and mocked GitHub publication, including malformed output, unexpected fields, hallucinated references, human-label preservation, comment spoofing, reruns and stale discussions. CI runs them independently of the application tests. They do not call OpenAI or modify GitHub issues. A real GitHub Actions/model smoke test requires the configured secret after merge.

Reference: [Codex GitHub Action documentation](https://learn.chatgpt.com/docs/github-action).
