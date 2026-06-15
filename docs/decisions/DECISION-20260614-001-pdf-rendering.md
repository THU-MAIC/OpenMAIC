## DECISION-20260614-001: Server-Side Worksheet PDF Rendering

**Date:** 2026-06-14  
**Proposal:** Apply the upstream Playwright file-tracing workaround in `next.config.ts` so that `playwright-core/browsers.json` is included in the Next.js standalone output, keeping Playwright as the server-side PDF renderer. Accompany the change with an end-to-end PDF generation test and document the rationale in this ADR.  
**Risk Level:** Low  
**Final Decision:** Approved  

### Context

OpenMAIC’s batch-worksheet feature renders personalized worksheets to PDF on the server via `app/api/generate-worksheet-pdf/route.ts`. The implementation uses `playwright` to convert HTML worksheets to PDF. After upgrading to Playwright 1.60.0 and building with `output: 'standalone'`, the API fails at module load with:

```
Error: Failed to load external module playwright-...:
Error: Cannot find module '.../playwright-core/browsers.json'
```

Research identified this as a known Playwright 1.60.0 regression: `microsoft/playwright#41248`. The root cause is that Playwright switched from a statically analyzable `require('../../../browsers.json')` to a computed `require(path.join(packageRoot, 'browsers.json'))`, which Next.js file tracing (`@vercel/nft`) cannot follow, so `browsers.json` is omitted from the standalone bundle. The upstream-recommended workaround is to explicitly include the file via `outputFileTracingIncludes`.

### Council Deliberation

| Persona | Stance | Key Point |
|---|---|---|
| Research Scientist | Endorse | The failure matches `microsoft/playwright#41248` exactly; the workaround is published by the maintainers and targets the root cause, not a symptom. |
| First-Principles Engineer | Endorse | The atomic need is HTML→PDF via Chromium’s print pipeline; Playwright is a thin wrapper around that pipeline, and the workaround restores the wrapper without changing the pipeline. |
| Distributed Systems Architect | Concern | Playwright/Chromium is memory-heavy. Concurrent PDF requests could spike RSS; we should cap concurrency or queue batch jobs if volume grows. |
| Infrastructure-First SRE | Concern | We need runtime observability (PDF latency, failure rate) and a rollback path (revert the config line). Existing logs are a start; metrics can follow. |
| Diagnostic Problem-Solver | Endorse | The manual copy of `browsers.json` failed because the real issue is file-tracing omission, not a missing file. The workaround fixes the actual omission. |
| Ethical Technologist | Endorse | Student data is processed server-side; the workaround does not change data flow. Existing access controls and temp-file cleanup remain in place. |
| Resource Strategist | Concern | Playwright increases deploy size and cold-start cost versus a managed API. Acceptable at current scale, but re-evaluate if batch volume grows. |
| Curious Explorer | Endorse | Validate the fix with an end-to-end test; optionally spike `puppeteer-core` later if Playwright causes further friction. |
| Clarity-Driven Communicator | Endorse | The proposal explicitly includes this ADR and a verification test; knowledge transfer is covered. |
| Inner-Self Guided Builder | Endorse | Fixing the upstream regression with the upstream workaround is the right path; swapping libraries without evidence would have been the easy but wrong move. |

### Rationale

The Council approved the proposal because the root cause is precisely understood and the workaround is the minimal, upstream-sanctioned fix. It preserves the existing worksheet rendering code, avoids a library migration, and keeps the project on the de-facto standard for high-fidelity HTML-to-PDF in Node.js. The non-blocking concerns (concurrency, observability, deploy size) are accepted as future monitoring and scaling work, not reasons to reject the fix.

### Dissent Recorded

- Distributed Systems Architect: concurrent PDF jobs may stress memory; accepted as a monitoring item.
- Infrastructure-First SRE: wants explicit PDF metrics and alerts; accepted as a follow-up observability item.
- Resource Strategist: Playwright/Chromium is heavier than a managed API; accepted because current workload is low-volume and self-hosted.

### Action Items

- [x] Implement `outputFileTracingIncludes` workaround in `next.config.ts`.
- [x] Rebuild the standalone output and restart the server.
- [x] Run an end-to-end test of `/api/generate-worksheet-pdf` and verify a valid PDF is returned.
- [ ] Add PDF generation latency/failure logging or metrics in a future iteration.
- [x] ADR written: `docs/decisions/DECISION-20260614-001-pdf-rendering.md`.
