# Issue and pull request labels

The intended label set for the [issue lifecycle](../MAINTAINING.md). Labels are managed by hand in the repository settings; this file is the reference. Automation that adds labels (the [issue triage](triage/README.md) bot) only uses labels listed under **Keep**.

## Keep

| Label | Meaning |
| --- | --- |
| `bug` | Something isn't working |
| `enhancement` | New feature or request (accepted ideas; new ideas start in Discussions → Ideas) |
| `documentation` | Improvements or additions to documentation |
| `question` | A usage question; usually moved to Discussions → Q&A |
| `duplicate` | This issue or pull request already exists |
| `wontfix` | This will not be worked on |
| `good first issue` | Good for newcomers |
| `help wanted` | Accepted and open to outside contributors |
| `status:needs-info` | Waiting for details from the reporter; removed when they reply, closed after 14 days without a reply |
| `status:blocked` | Waiting on maintainers: a design decision, an RFC or an external dependency |
| `type:rfc` | Architecture or design proposal requiring a decision |
| `type:epic` | Umbrella outcome composed of multiple deliverable issues |
| `area:generation` | Course and scene generation pipeline |
| `area:playback` | Classroom playback, discussion, audio, and runtime behavior |
| `area:editor` | MAIC editor and content authoring surfaces |
| `area:providers` | Model, media, search, TTS, ASR, and extraction providers |
| `area:import-export` | Document import, ETL, PPTX, HTML, ZIP, and video export |
| `area:storage` | Persistence, IndexedDB, server storage, and runtime records |
| `area:infra` | Build, deployment, CI, security, and repository infrastructure |
| `priority:P0` | Production outage, data loss, or critical security issue |
| `priority:P1` | High-impact correctness or usability issue |
| `flaky-report` | Weekly flaky CI report (used by automation) |

## Remove

| Label | Replaced by |
| --- | --- |
| `invalid` | Close as not planned, or `duplicate` / `wontfix` |
| `status:ready` | An assignee or `help wanted` |
| `status:in-progress` | An assignee or a linked open PR |
| `status:icebox` | Close as not planned and move the idea to Discussions → Ideas |
| `type:task` | A plain issue linked from its `type:epic` or `type:rfc` |
| `type:question` | `question` |
| `priority:P2` | No priority label (normal priority) |

Before deleting a label, relabel the open issues that carry it so they keep their meaning (for example `type:question` to `question`, `status:icebox` closed or moved to Discussions).
