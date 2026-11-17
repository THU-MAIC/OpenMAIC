# Maintaining OpenMAIC

How maintainers run the issue tracker. Contributor-facing rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Issue lifecycle

Issues are for bugs. Feature ideas go to [Discussions → Ideas](https://github.com/THU-MAIC/OpenMAIC/discussions/categories/ideas) and usage questions to [Discussions → Q&A](https://github.com/THU-MAIC/OpenMAIC/discussions/categories/q-a); an accepted idea becomes an issue.

Every open issue is in exactly one state, read from its assignee, its status label and whether it is open:

| State | How it looks | Who moves it on |
| --- | --- | --- |
| **Untriaged** | No assignee, no `status:needs-info`, no `status:blocked`, no `help wanted`, no linked open PR | A maintainer, at the weekly sweep. The AI triage bot has usually commented and added type/area labels already |
| **Accepted** | Assigned to a maintainer, or labelled `help wanted` (open to outside contributors) | The assignee, or a contributor who claims it |
| **Needs info** | `status:needs-info` plus a question in a comment | The reporter. A reply removes the label (back to Untriaged); no reply within 14 days closes it as not planned |
| **Blocked on maintainers** | `status:blocked` (design undecided, waiting on an RFC) | Maintainers |
| **In progress** | An assignee or a linked open PR. There is no "in progress" label | The PR author |
| **Done** | Closed by a merged PR (`Closes #N`), or at release time for work merged on an integration branch | — |

"Not an issue" is a triage outcome, not a state: close duplicates (label `duplicate`, link the original) and things we will not do (`wontfix`, closed as not planned); move feature ideas to Discussions → Ideas and usage questions to Discussions → Q&A ("Convert to discussion" in the issue sidebar).

Triage has only four outcomes: **accept** (assign, or `help wanted`), **needs info**, **blocked**, or **not an issue**.

## Weekly sweep

The [Maintainer Sweep Digest](.github/workflows/maintainer-digest.yml) updates a single issue titled "Maintainer sweep" every Monday with the lists below. Work through them in order:

1. **Untriaged issues**, oldest first: give each one of the four outcomes. [Search](https://github.com/THU-MAIC/OpenMAIC/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+-linked%3Apr+-label%3A%22status%3Aneeds-info%22+-label%3A%22status%3Ablocked%22+-label%3A%22help+wanted%22+sort%3Acreated-asc)
2. **Blocked** (`status:blocked`): is the decision made? If so, accept or close. [Search](https://github.com/THU-MAIC/OpenMAIC/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3Ablocked%22+sort%3Acreated-asc)
3. **Needs info that got a reply**: the bot removes the label, so these come back as untriaged; the digest also lists any still labelled. [Search](https://github.com/THU-MAIC/OpenMAIC/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3Aneeds-info%22+sort%3Aupdated-desc)
4. **Pull requests ready for review**: not a draft, no conflicts, CI green, every Codex review thread resolved, and no maintainer review since the latest push. [Search](https://github.com/THU-MAIC/OpenMAIC/pulls?q=is%3Apr+is%3Aopen+draft%3Afalse+status%3Asuccess+sort%3Aupdated-asc)
5. **Provider PRs awaiting a decision** (`area:providers`, from contributors, no maintainer review yet): accept or decline within 7 days of opening, before code review. Accept only with a real call against the provider and a named maintainer for the integration. [Search](https://github.com/THU-MAIC/OpenMAIC/pulls?q=is%3Apr+is%3Aopen+draft%3Afalse+label%3Aarea%3Aproviders+sort%3Acreated-asc)

Useful extra views: [assigned, least recently updated](https://github.com/THU-MAIC/OpenMAIC/issues?q=is%3Aissue+is%3Aopen+-no%3Aassignee+sort%3Aupdated-asc) and [help wanted, least recently updated](https://github.com/THU-MAIC/OpenMAIC/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22+sort%3Aupdated-asc).

## Bots

| Workflow | When | What it does | Switch |
| --- | --- | --- | --- |
| [Issue Triage](.github/workflows/issue-triage.yml) | New issue | Comments with an assessment, adds type/area labels and, for a missing detail, `status:needs-info`. Feature requests are pointed to Discussions → Ideas, questions to Q&A | `ISSUE_TRIAGE_MODE` (see [.github/triage/README.md](.github/triage/README.md)) |
| [Issue Lifecycle Reminders](.github/workflows/issue-reminders.yml) | Daily | The needs-info and staleness rules below | `ISSUE_REMINDERS_MODE=apply` |
| [Maintainer Sweep Digest](.github/workflows/maintainer-digest.yml) | Mondays | Updates the "Maintainer sweep" issue | `MAINTAINER_DIGEST_MODE=apply` |
| [Stuck PR Reminders](.github/workflows/pr-reminders.yml) | Daily | Conflicts, pending workflow approval, unresolved Codex threads | `PR_REMINDERS_MODE=apply` |

Each switch is a repository variable. Without it, scheduled runs are dry runs that only write the job summary; manual runs are dry runs unless `dry_run` is unchecked. The reminders write at most 20 times per run.

Issue lifecycle rules:

- **Needs info, author replied**: the issue author commented after `status:needs-info` was added. The label is removed and nothing else changes.
- **Needs info, no reply**: 14 days after the label was added (or after the issue was reopened) with no comment from the issue author, the bot comments that the issue can be reopened once the information is added, and closes it as not planned.
- **Assigned, stale**: no activity for 60 days. One comment asks the assignees whether it is still planned; otherwise unassign and mark `help wanted`, or close. The bot never unassigns or closes these itself. Another reminder comes only after new activity and another 60 quiet days.
- **Help wanted, stale**: unassigned, labelled `help wanted`, no activity for 90 days. The bot comments, suggesting Discussions → Ideas, and closes it as not planned.

"Activity" is the latest of: the issue being opened or reopened, a comment by a human (bot comments never count), a label or assignee change, and an update to a linked PR.

Exempt from the closes and reminders (but not from the needs-info label removal): `status:blocked`, `type:epic`, `type:rfc`, `priority:P0`, `priority:P1`, pinned issues, and issues with a linked open PR. Pull requests that close an issue, PRs linked in the Development sidebar and same-repository PRs that mention the issue all count as linked.

## Releases

As part of the release checklist, **close the issues delivered in this release**. Work merged to `main` with `Closes #N` closes its issues automatically; work merged on an integration or release branch does not. For each such PR in the release, close its linked issues as completed with a comment naming the version, for example:

```sh
gh pr list --repo THU-MAIC/OpenMAIC --state merged --base <branch> --limit 200 \
  --json number,title,closingIssuesReferences
```

## Labels

The full list with descriptions is in [.github/labels.md](.github/labels.md). In short:

- **Type**: `bug`, `enhancement`, `documentation`, `question`, `type:rfc`, `type:epic`
- **Status**: `status:needs-info`, `status:blocked` (nothing else: an assignee or a linked PR already says "in progress")
- **Contributors**: `help wanted`, `good first issue`
- **Area**: `area:generation`, `area:playback`, `area:editor`, `area:providers`, `area:import-export`, `area:storage`, `area:infra`
- **Priority**: `priority:P0`, `priority:P1` (no label means normal priority)
- **Resolution**: `duplicate`, `wontfix`
- **Automation**: `flaky-report`

Retired: `invalid`, `status:ready`, `status:in-progress`, `status:icebox`, `type:task`, `type:question`, `priority:P2`.
