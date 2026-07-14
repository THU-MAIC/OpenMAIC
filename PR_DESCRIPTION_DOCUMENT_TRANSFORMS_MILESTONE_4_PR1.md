## Summary

Implement the foundation of MAIC ETL Milestone 4 by introducing a provider-neutral document transform pipeline between document extraction and bundle/generation assembly.

This PR adds a small OpenMAIC-owned transform contract, execution history, failure policies, cancellation support, and a registry for composing preprocessing steps. It also provides the first deterministic transforms for content normalization, structure detection, logical fallback sections, and conservative repeated-noise removal.

The pipeline operates on `DocumentArtifact` and preserves the existing extraction, document bundle, PDF compatibility, and generation behavior. It establishes the extension point required by follow-up PRs for chapter selection, hierarchical long-document summarization, educational image filtering, and question-bank/reference-material shaping without adding those AI/UI features to this focused foundation PR.

## Related Issues

Related to #52, #335, #43

## Changes

- Extend `DocumentArtifact` with an optional normalized outline and transform execution history.
- Add `DocumentOutlineNode` with hierarchy, block/asset references, page ranges, text offsets, confidence, and source metadata.
- Add a provider-neutral `DocumentTransform` contract with declared capabilities and transform context.
- Add `transformDocument()` for ordered transform execution over immutable artifact copies.
- Support `fail-fast` and `best-effort` failure policies.
- Record transform version, status, timestamps, input/output counts, options, and diagnostics on the output artifact.
- Add cancellation checks through `AbortSignal` before and between transform steps.
- Add aggregate text/asset metrics for the complete pipeline.
- Add `DocumentTransformRegistry` and a deterministic default transform order.
- Add a normalization transform that:
  - removes invalid control characters and normalizes whitespace/newlines;
  - removes empty text/Markdown blocks while retaining structured blocks;
  - merges compatible adjacent text blocks;
  - remaps citations and outline references after block merging.
- Add a structure detection transform that:
  - preserves provider-supplied outlines;
  - detects extractor heading metadata and layout headings;
  - detects nested Markdown headings and keeps text offsets;
  - recognizes conservative numbered/chapter heading patterns;
  - creates bounded logical sections when no headings are available.
- Add a conservative noise-removal transform that:
  - removes standalone page-number blocks only with positional/role evidence;
  - removes repeated headers/footers only when they repeat across enough pages;
  - does not remove repeated body content without header/footer evidence;
  - removes stale citation/outline references when a noise block is removed.
- Export the transform APIs from the existing `lib/document` boundary.
- Add focused tests for execution order, immutability, failure policy, cancellation, registry behavior, reference remapping, outline hierarchy/fallbacks, and conservative noise removal.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [x] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [x] Documentation update
- [x] Refactoring (no functional changes)
- [ ] CI/CD or build changes

## Verification

### Steps to reproduce / test

1. Install the repository dependencies from the lockfile.
2. Run the focused transform and document compatibility tests.
3. Run TypeScript type checking.
4. Run Prettier, lint, i18n-key, and full-test checks before requesting review.
5. Confirm existing extraction and bundle callers compile without adopting the new optional transform fields.

### What you personally verified

- Transforms execute in declared order over cloned artifacts without mutating caller-owned block/metadata state.
- Successful, skipped, and failed transform steps produce inspectable execution records.
- Best-effort mode preserves the last successful artifact and continues after a failed transform.
- Fail-fast mode stops before later transforms run.
- An already-aborted signal prevents pipeline execution.
- Normalization remaps citation and outline block references after merging adjacent blocks.
- Existing provider outlines are preserved rather than replaced by heuristic output.
- Markdown headings produce nested outline nodes with stable block references and offsets.
- Heading-free long text receives bounded logical sections instead of a single opaque unit.
- Repeated headers, footers, and page numbers are removed only with sufficient layout/role evidence.
- Repeated body warnings remain untouched.
- Existing PDF compatibility and document bundle tests remain green.
- TypeScript type checking passes after building the latest workspace renderer package required by the current `main` baseline.
- Prettier and i18n-key alignment checks pass.
- ESLint completes with no errors; it reports 15 warnings already present in current `main`, none in this PR's files.
- The full suite passes 2,282 tests and exposes two timing-sensitive failures in the existing classroom-generation retry test when run in parallel; that file passes all four tests when rerun independently.

### Evidence

- [x] Focused and compatibility tests pass (23 tests across 7 files)
- [x] TypeScript type checking passes (`pnpm exec tsc --noEmit --pretty false`)
- [x] Formatting passes (`pnpm check`)
- [x] i18n key alignment passes (`pnpm check:i18n-keys`)
- [x] Lint completes with no errors and no warnings in changed files (`pnpm lint`)
- [ ] CI passes (`pnpm check && pnpm lint && npx tsc --noEmit`)
- [ ] Manually tested locally
- [ ] Screenshots / recordings attached (not applicable: no UI changes)

Local verification:

```text
pnpm vitest run \
  tests/document/transform-pipeline.test.ts \
  tests/document/transform-registry.test.ts \
  tests/document/normalize-transform.test.ts \
  tests/document/structure-transform.test.ts \
  tests/document/noise-removal-transform.test.ts \
  tests/document/pdf-compat.test.ts \
  tests/document/bundle.test.ts

pnpm exec tsc --noEmit --pretty false
```

## Compatibility

- All new `DocumentArtifact` fields are optional.
- Existing extractor providers do not need to emit an outline or transform history.
- Existing PDF compatibility adapters continue to consume `blocks` and `assets` as before.
- Existing document bundle and generation paths are not automatically routed through transforms in this PR.
- Existing artifacts and sessions remain valid without migration.
- Provider-specific raw output remains opaque and is not made part of the transform standard.

## Known Limitations / Follow-ups

- This PR does not add chapter-selection UI or persistence.
- This PR does not call an LLM or implement hierarchical summarization.
- This PR does not score/filter images with a vision model.
- This PR does not parse or shape question banks/reference materials.
- Logical fallback sections use deterministic character ranges; semantic/chapter-aware planning belongs to the long-document follow-up.
- Transform execution is not yet wired into the generation preview/API flow; this PR intentionally establishes and tests the reusable boundary first.

## AI Assistance

This PR was implemented with AI assistance. The resulting changes were reviewed against the document extraction/bundle contracts, focused regression tests were added, and local type/test verification was performed before submission.

## Checklist

- [x] My code follows the project's coding style
- [x] I have performed a self-review of my code
- [x] I have added/updated documentation as needed
- [x] My changes do not introduce new warnings
