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

## Before You Report

* Reproduce the issue on the latest release or on `main`. A report that only affects a version already fixed by a published release is closed as a duplicate.
* Search the published [security advisories](https://github.com/THU-MAIC/OpenMAIC/security/advisories). Variants of a published advisory are welcome; explain what the existing fix misses.
* Where possible, demonstrate the issue against the default deployment (the shipped `Dockerfile`, `docker-compose.yml`, and `.env.example`). If the finding depends on a non-default setting or a different network topology, name that setting in the report.

## Deployment Assumptions

OpenMAIC's security boundaries are designed around the assumptions below, and reports are assessed against them.

* **`ACCESS_CODE` is a shared site password, not user authentication.** Everyone who knows the code has the same access, and it does not separate users from each other. Its resistance to guessing depends on the code itself, so use a long random value. When the variable is unset (the default in `.env.example`), `middleware.ts` returns `NextResponse.next()` and does not require a credential. There is no second gate, so the API is reachable: that is fail-open, not fail-closed. [GHSA-9m7h-vh2h-rc3w](https://github.com/THU-MAIC/OpenMAIC/security/advisories/GHSA-9m7h-vh2h-rc3w) made outbound URL validation unconditional in v1.0.1; it did not change this middleware behaviour.
* **The render service is an isolation boundary only in its shipped configuration.** It executes untrusted HTML in headless Chromium and relies on the container's egress lockdown (`RENDER_EGRESS_LOCKDOWN=true`, the default, which needs `CAP_NET_ADMIN`) and on an isolated network (`internal: true` in Compose). Disabling the lockdown or placing the service on a routable network is an operator opt-in; see [`render-service/README.md`](render-service/README.md).
* **Forwarding headers are trusted only when `TRUST_PROXY_HEADERS=true`.** Enable it only behind a reverse proxy that overwrites `X-Forwarded-For` and `X-Real-IP`.
* **Server persistence identity is only as strong as the configured owner authenticator.** Every `/api/persistence` request (documents, runtime sessions and assets) is attributed to the owner that `lib/server/identity/` resolves; by default that is the 30-day anonymous cookie, which isolates browsers from each other but authenticates nobody. Document reads, and reads of media a live course references, are capability-by-id (no owner check). Deployments that serve real users should put an identity gateway in front and select the `trustedProxyHeader` built-in (`OWNER_AUTHENTICATOR=trusted-proxy`), or register an authenticator backed by their own accounts. With `trustedProxyHeader`, the gateway secret is the trust boundary: the app must be reachable only through the gateway, and the gateway must strip client-supplied copies of the user, groups and secret headers.
* **Server-side configuration is trusted operator input.** Endpoints an operator sets through environment variables (for example `OLLAMA_BASE_URL` or `RENDER_SERVICE_URL`) are not subject to the outbound URL guard. URLs supplied by end users at request time are untrusted and must pass the guard.

## Triage and Severity

* Maintainers confirm the report, agree on the affected code paths, and assign a severity using CVSS v4.0. The published vector reflects the maintainers' assessment of the default deployment described in this repository (the shipped `Dockerfile`, `docker-compose.yml`, and `.env.example`); deployment-specific amplification is described in the advisory text rather than baked into the base score.
* If you disagree with the proposed severity, say so in the advisory thread before publication. We will answer every severity objection in the thread before we publish, and we will not publish while a metric is still under active discussion.
* Behaviour that an operator explicitly opts into and that is documented as unsafe for public deployments (for example `ALLOW_LOCAL_NETWORKS=true`) is evaluated against its documentation: we treat it as a hardening request when it does what the documentation says, and as a vulnerability when it is unsafe beyond that. Findings that only hold after one of the [Deployment Assumptions](#deployment-assumptions) is broken are evaluated the same way.

## Disclosure Process

When a vulnerability is confirmed and patched, we will publish a GitHub Security Advisory detailing the issue, the impacted versions, and the fix. We will also credit the security researcher who reported the issue (unless they prefer to remain anonymous).

* For every accepted advisory the maintainers request a CVE identifier through GitHub at publication time, so the CVE description, affected versions, and score match the advisory. Please do not request a CVE for an OpenMAIC advisory from another CNA; if one already exists, tell us and we will link it.
* Publication happens after the fix is released. The advisory, the release notes, and the CVE record are published together.
* Advisory collaborators should not edit a published advisory's severity or description without raising it in the thread first; maintainers keep the published advisory consistent with the CVE record.
