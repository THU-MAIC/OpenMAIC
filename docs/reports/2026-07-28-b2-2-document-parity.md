# B2.2 Report: DocumentStore dual-read parity observation

Date: 2026-07-28
Scope: observe parity between the legacy Dexie course document and the B2.1
DocumentStore shadow copy. This change does not make DocumentStore an active
read or write source.

## Safety boundary

- The UI continues to load course documents from the existing Dexie path.
- A parity check is scheduled only after that Dexie load succeeds.
- It is enabled only when both `NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE=1` and
  `NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK=1` are set. Both default to off.
- Bridge then comparison share one idle-time serial queue. The comparison sees
  the shadow copy after a successful bridge attempt without blocking the user.
- Missing DocumentStore data, a mismatch, authentication failure, or IndexedDB
  failure is logged as an observation and returns control to the legacy path;
  it cannot throw into course loading.

## What is compared

The fingerprint is SHA-256 over a stable JSON representation of the stage,
the scenes sorted by `order` then `id`, and the optional outline record. This
compares document meaning rather than IndexedDB implementation details.

## Diagnostics

The authenticated, rate-limited `/api/client-diagnostics` endpoint accepts
`document_parity` events. Successful matches omit the course ID; non-matches
carry it for support triage. Outcomes are `match`, `missing_document`,
`mismatch`, `read_failure`, and `identity`. Every event includes a bounded
duration bucket and parity version, so match rate and latency can be measured.
Diagnostic delivery is best-effort and never participates in the course path.

## Automated verification

- match: reports success without a course ID;
- absent shadow document: reports `missing_document`;
- changed document: reports `mismatch`;
- IndexedDB exception: reports `read_failure` and resolves safely;
- disabled parity flag: does not authenticate or open DocumentStore;
- existing B2.1 bridge fallback tests remain in the same focused suite.

## B2.3 gate

Do not switch any course read/write path to DocumentStore until a controlled
deployment has collected representative parity data with the flags enabled.
The evidence must show no unexplained mismatch/read-failure pattern, and the
kill switch must remain tested before proposing a primary-read task.
