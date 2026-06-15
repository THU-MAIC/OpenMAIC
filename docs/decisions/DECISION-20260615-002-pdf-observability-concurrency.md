## DECISION-20260615-002: PDF Generation Concurrency & Observability

**Date:** 2026-06-15  
**Proposal:** Add a dependency-free concurrency limiter (default cap of 3, env-configurable) around Playwright PDF generation, enhance the JSON logger to emit structured fields, and log PDF events with `studentCount`, `topic`, `durationMs`, `success`, and `error` only — no PII. Keep metrics as logs for now; leave Prometheus/OpenTelemetry as a future migration.  
**Risk Level:** Low  
**Final Decision:** Approved  

### Context

`DECISION-20260614-001` restored server-side PDF rendering by fixing Playwright file tracing. The Council accepted three non-blocking concerns for follow-up:

1. Playwright/Chromium can spike memory under concurrent renders.
2. There was no observability plan for PDF latency or failures.
3. A rollback path and runtime metrics were needed.

This decision addresses those concerns.

### Research findings

- **Playwright PDF concurrency:** Headless Chromium contexts commonly consume **200–500 MB RAM each** under load ([microsoft/playwright#38683](https://github.com/microsoft/playwright/issues/38683)). Limiting concurrent renders is a documented best practice for batch PDF workloads ([Docupotion 2026](https://docupotion.com/blog/generate-pdfs-playwright)).
- **Request observability:** The RED method — **Rate, Errors, Duration** — is the minimal complete baseline for monitoring request-driven services ([OneUptime 2026](https://oneuptime.com/blog/post/2026-03-31-dapr-red-metrics/view)).
- **Structured logging:** JSON logs with contextual fields are the recommended first step for Next.js API observability before adding an APM vendor ([Prateeksha 2025](https://prateeksha.com/blog/nextjs-logging-best-practices-structured-logs-production)).
- **Student privacy:** Student data is sensitive under FERPA/GDPR; logs must avoid names, weak topics, or other identifiable details ([MIT Reader 2026](https://thereader.mitpress.mit.edu/privacy-and-paternalism-the-ethics-of-student-data-collection/)).

### Council deliberation

| Persona | Stance | Key point |
|---|---|---|
| Research Scientist | Endorse | Citations support concurrency limiting and RED-style logging for this exact workload. |
| First-Principles Engineer | Endorse | Semaphore + structured logs are the atomic guards and signals needed; no extra concepts. |
| Distributed Systems Architect | Endorse | Cap of 3 is reasonable per 200–500 MB/context; wants env override for tuning. |
| Infrastructure-First SRE | Endorse | `LOG_FORMAT=json` structured fields give the minimum viable observability baseline. |
| Diagnostic Problem-Solver | Concern | Queued jobs must time out; logs must not accidentally capture raw student objects. |
| Ethical Technologist | Endorse | Logging only aggregate count and topic avoids PII; aligned with FERPA/GDPR. |
| Resource Strategist | Endorse | Custom semaphore avoids a new dependency; no new vendor or cost. |
| Curious Explorer | Endorse | Proposes validation experiment across caps 1/3/5 to find the memory/latency knee. |
| Clarity-Driven Communicator | Endorse | Decision must be recorded and the logger enhancement documented for reuse. |
| Inner-Self Guided Builder | Endorse | Simple, protective, trust-preserving follow-up to the PDF fix. |

No blocking concerns.

### Consensus adjustments

1. Use a custom in-process semaphore instead of adding `p-limit`.
2. Make the cap configurable via `PDF_CONCURRENCY_LIMIT` (default 3).
3. Add a 30-second queue timeout so jobs fail fast instead of waiting forever.
4. Log only `studentCount`, `topic`, `durationMs`, `success`, and `error` — no names or individual student data.
5. Enhance `lib/logger.ts` so object arguments merge into top-level JSON fields when `LOG_FORMAT=json`.
6. Record the decision in this ADR.

### Rationale

The Council approved the proposal because it addresses the accepted risks from the previous decision with minimal, proven mechanisms. A dependency-free semaphore keeps the runtime lean, structured logs provide the RED baseline without vendor lock-in, and the PII-free log contract preserves student privacy.

### Action Items

- [x] Implement `lib/worksheet/concurrency-limiter.ts`.
- [x] Wrap PDF generation with the concurrency limiter.
- [x] Enhance `lib/logger.ts` for structured JSON fields.
- [x] Add PDF event logs to `generateWorksheetPDF` / `generateMultipleWorksheetPDFs`.
- [ ] Run validation experiment under caps 1/3/5 (future spike).
- [x] ADR written: `docs/decisions/DECISION-20260615-002-pdf-observability-concurrency.md`.

### References

1. Wilkie, T. (2017). *The RED Method: key metrics for microservices architecture*. Weaveworks. Cited in systems-engineering literature as the canonical request-driven monitoring baseline.
2. Beyer, B., Jones, C., Petoff, J., & Murphy, N. (2016). *Site Reliability Engineering: How Google Runs Production Systems*. O'Reilly Media. Defines the four golden signals and the SRE monitoring culture that RED extends.
3. U.S. Department of Education. *Family Educational Rights and Privacy Act (FERPA)*, 20 U.S.C. § 1232g; 34 CFR Part 99. Defines PII in student education records and its disclosure restrictions.
4. European Parliament and Council of the European Union. (2016). *Regulation (EU) 2016/679 (GDPR)*, Art. 4(1) and Art. 9. Defines personal data and special-category (sensitive) personal data.
5. Microsoft Playwright. (2026). *High concurrency memory usage* (Issue #38683). Empirical report of 200–500 MB RAM per Playwright worker/context under load.
6. Docupotion. (2026). *How to Generate PDFs with Playwright*. Industry tutorial documenting `p-limit` concurrency limiting for batch PDF generation.
7. Prateeksha. (2025). *Next.js Logging Best Practices: Structured Logging in Production*. Recommends JSON structured logs with contextual metadata as the first production observability step.
8. Sweeney, L. (2000). *Simple Demographics Often Identify People Uniquely*. Carnegie Mellon University. Demonstrates re-identification risks from "anonymized" data, reinforcing why logs must exclude even indirect identifiers.
