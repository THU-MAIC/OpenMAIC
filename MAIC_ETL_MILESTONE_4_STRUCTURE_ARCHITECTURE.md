# MAIC ETL Milestone 4: Document Structure Architecture

## Status

Proposed direction for the structure-detection part of Milestone 4 PR 1.

This decision keeps the public artifact and transform pipeline provider-neutral while allowing each extractor adapter to interpret provider-specific structure semantics.

## Context

Document providers expose structurally different results:

- AliDocMind emits ordered layout blocks and provider-defined title levels.
- MinerU primarily emits a Markdown document whose heading markers carry structure.
- unpdf emits plain text without authoritative structural metadata.
- Office extraction can expose layout or style signals that are not always reliable enough to treat every short paragraph as a heading.

Treating any one of those representations as the universal input model causes two failure modes:

1. preferring a partially populated provider outline can silently discard headings that remain visible in extracted text;
2. applying weak plain-text heuristics to strong provider output can replace or duplicate authoritative structure.

The architecture therefore separates **provider-aware evidence mapping** from **provider-neutral reconciliation and outline construction**.

## Decision

```text
Provider raw output
  -> provider / format adapter
  -> canonical blocks + structure evidence
  -> normalize
  -> remove conservative noise
  -> collect structure candidates
       - provider metadata
       - Markdown headings
       - conservative numbered headings
  -> reconcile ordered candidates
  -> build canonical DocumentOutlineNode[]
  -> logical fallback only when no candidate survives
```

The provider-neutral boundary is the canonical data and behavior after extraction. It does not require every provider's raw response to be interpreted by one universal heuristic.

## Responsibilities

### Extractor adapters

An adapter owns semantics that cannot be inferred safely outside that provider or format:

- map provider title/layout types to canonical block metadata;
- convert provider heading levels to positive, one-based levels;
- preserve page, position, confidence, subtype, and raw provider data when available;
- distinguish explicit Office heading styles from ordinary paragraphs;
- avoid presenting provider-specific field meanings as an OpenMAIC standard.

For AliDocMind, the adapter normalizes a response containing level `0` as a zero-based hierarchy. The official Doc-JSON example shows its root hierarchy node at level `0`; responses that are already one-based remain unchanged. Provider-specific raw data should continue to be exposed only through the existing `providerRaw` escape hatch when an adapter retains it, rather than becoming part of the canonical outline contract.

Reference: [Aliyun Document Mind Doc-JSON structure](https://help.aliyun.com/zh/document-mind/developer-reference/docstructure).

### Structure candidate collection

The transform collects independent ordered candidate streams:

- `provider`: explicit provider heading level;
- `heading`: Markdown heading or unlevelled heading metadata;
- `heuristic`: conservative numbered/chapter/article pattern;
- `logical`: bounded fallback section, created only if no heading candidate survives.

Markdown and numbered headings may coexist in one text block. Finding one Markdown heading must not disable numbered-heading detection for the rest of the block.

Text heuristics run only on text/Markdown blocks. They do not re-parse layout blocks that already carry provider metadata.

### Provider-neutral reconciliation

Reconciliation follows these invariants:

1. A provider candidate never causes all text candidates to be discarded.
2. Provider and text candidates with the same normalized title are matched by occurrence and document order.
3. A matched pair produces one node. An explicit provider level wins, while the text block and offset remain the content anchor.
4. Unmatched provider candidates and unmatched text candidates are retained.
5. Repeated titles are not globally deduplicated by title alone.
6. Same-title candidates without page information remain distinct unless occurrence-level evidence proves they represent the same heading.
7. Adjacent duplicate provider blocks are collapsed only with known equal page, level, title, and adjacent block order.

This is intentionally an ordered occurrence match rather than a `page:level:title` set. A global set cannot distinguish two legitimate `Summary` sections in a DOCX document whose page numbers are unavailable.

### Running headings and page noise

Running headers belong to noise handling, not semantic title deduplication.

The default deterministic order is:

```text
normalize -> remove-noise -> detect-structure
```

Explicit header/footer roles and reliable margin coordinates are preferred. As a secondary structure safeguard, a provider title repeated on at least three pages and on at least 60% of the document pages is treated as a running heading and excluded from the outline. This rule applies only to page-addressable provider heading candidates; it does not collapse same-name sections with unknown pages.

Bare numeric footer content such as `2024` or `512` is preserved unless the provider explicitly labels it as a page number. Positional footer evidence alone removes only decorated page-number forms such as `Page 12` or `— 12 —`.

## Diagnostics

Structure detection reports enough data to expose partial provider coverage:

- selected strategy (`provider`, `heading`, `hybrid`, or `logical`);
- provider and text candidate counts;
- matched candidate count;
- unmatched provider and text counts;
- adjacent provider duplicates removed;
- repeated running headings removed;
- final outline node count.

A caller can therefore distinguish a complete provider mapping from a hybrid result instead of treating missing provider headings as an invisible success.

## Correctness Invariants

- Extracted text is never deleted merely because it was not recognized as a heading.
- Partial provider structure cannot suppress a distinct text heading.
- Matching two sources creates one outline occurrence, not two.
- Two legitimate same-name sections are retained when occurrence evidence differs or is unavailable.
- Provider levels are normalized in the adapter, not guessed in the shared transform.
- Sentence-like body paragraphs mislabeled as titles are rejected conservatively.
- Logical sections never replace available provider, Markdown, or numbered headings.

## Scope and Follow-ups

This foundation remains deterministic. It does not add:

- LLM chapter detection;
- chapter-selection UI;
- semantic long-document summarization;
- provider-specific vector indexes;
- a guarantee that every visually styled heading can be recovered from plain text.

Follow-up work should add sanitized real-extraction fixtures for AliDocMind, MinerU, unpdf, DOCX, and DOC. Those fixtures should measure known-heading recall, duplicate occurrences, hierarchy accuracy, source coverage, and logical fallback ranges without requiring cloud credentials in CI.
