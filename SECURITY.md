# Security Policy for OpenMAIC

Thank you for helping us keep OpenMAIC secure! We take the security of our platform, multi-agent engine, and users very seriously. 

## Supported Versions

We currently provide security updates for the latest major release and the active `main` branch. Please ensure you are running the most recent version of OpenMAIC before submitting a report.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| Latest Release | :white_check_mark: |
| Older Versions | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in OpenMAIC, **please do not create a public GitHub issue.** Publicly disclosing a vulnerability can put other users and self-hosted instances at risk.

Instead, please report it privately using one of the following methods:
**GitHub Private Vulnerability Reporting:** Go to the [Security tab](https://github.com/THU-MAIC/OpenMAIC/security) of the repository, click on "Advisories", and select "Report a vulnerability".


**What to include in your report:**
* A description of the vulnerability and its potential impact.
* Detailed steps to reproduce the issue.
* Any relevant logs, screenshots, or code snippets.
* (Optional) Suggested mitigation or a patch.

We will acknowledge receipt of your vulnerability report within 48 hours and strive to send you regular updates about our progress.

## Triage and Severity

* Maintainers confirm the report, agree on the affected code paths, and assign a severity using CVSS v4.0. The published vector reflects the maintainers' assessment of the default deployment described in this repository (the shipped `Dockerfile`, `docker-compose.yml`, and `.env.example`); deployment-specific amplification is described in the advisory text rather than baked into the base score.
* If you disagree with the proposed severity, say so in the advisory thread before publication. We will answer every severity objection in the thread before we publish, and we will not publish while a metric is still under active discussion.
* Behaviour that an operator explicitly opts into and that is documented as unsafe for public deployments (for example `ALLOW_LOCAL_NETWORKS=true`) is evaluated against its documentation: we treat it as a hardening request when it does what the documentation says, and as a vulnerability when it is unsafe beyond that.

## Disclosure Process

When a vulnerability is confirmed and patched, we will publish a GitHub Security Advisory detailing the issue, the impacted versions, and the fix. We will also credit the security researcher who reported the issue (unless they prefer to remain anonymous).

* For every accepted advisory the maintainers request a CVE identifier through GitHub at publication time, so the CVE description, affected versions, and score match the advisory. Please do not request a CVE for an OpenMAIC advisory from another CNA; if one already exists, tell us and we will link it.
* Publication happens after the fix is released. The advisory, the release notes, and the CVE record are published together.
* Advisory collaborators should not edit a published advisory's severity or description without raising it in the thread first; maintainers keep the published advisory consistent with the CVE record.
