# Document Extraction and Course Material Upload

OpenMAIC routes uploaded course material through the document extraction boundary introduced by MAIC ETL:

```text
file -> DocumentExtractorProvider -> DocumentArtifact -> generation compatibility shape
```

The generation flow still consumes the existing `pdfText` / `pdfImages` compatible fields internally, but the upload surface is document-oriented rather than PDF-only.

## Supported File Types

Initial single-file upload support:

| Type | MIME type | Extractor |
| --- | --- | --- |
| PDF | `application/pdf` | `unpdf`, `mineru`, or `mineru-cloud` |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `mineru` |
| PPTX | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `mineru` |
| TXT | `text/plain` | `plain-text` |
| Markdown | `text/markdown`, `text/x-markdown` | `plain-text` |

Only one course material file is accepted per generation session. Multi-document bundles are a later MAIC ETL milestone.

## Provider Selection

Provider selection follows two rules:

1. If the user explicitly selects a PDF parser, that provider is used for PDF uploads.
2. If no explicit provider is supplied, OpenMAIC selects a document extractor by MIME type and required capabilities.

Unsupported combinations should fail clearly. For example, `unpdf` with a DOCX file is invalid because `unpdf` only supports PDF.

## API Usage

### Generic Document Extraction

Use `/api/extract-document` for course material upload:

```ts
const formData = new FormData();
formData.append('file', file);

const response = await fetch('/api/extract-document', {
  method: 'POST',
  body: formData,
});

const result = await response.json();
```

For PDF uploads, callers may optionally pass a PDF provider:

```ts
formData.append('providerId', 'mineru');
formData.append('baseUrl', 'http://localhost:7777');
```

For TXT and Markdown uploads, no MinerU service is needed. OpenMAIC extracts the text locally.

### PDF Compatibility API

`/api/parse-pdf` remains available for compatibility with the older PDF-only route:

```ts
const formData = new FormData();
formData.append('pdf', pdfFile);
formData.append('providerId', 'unpdf');

const response = await fetch('/api/parse-pdf', {
  method: 'POST',
  body: formData,
});
```

New upload UI code should prefer `/api/extract-document`.

## MinerU Setup

MinerU is optional for PDF, but required for DOCX and PPTX in the initial multi-format upload scope.

Set the self-hosted MinerU base URL in `.env.local`:

```env
PDF_MINERU_BASE_URL=http://localhost:7777
PDF_MINERU_API_KEY=
```

Or configure it as a server-managed provider:

```yaml
pdf:
  mineru:
    baseUrl: http://localhost:7777
```

When configured server-side, OpenMAIC treats MinerU as admin-managed and ignores client-supplied base URLs for that provider.

## Response Shape

The document extractor output is normalized internally as `DocumentArtifact`:

```ts
interface DocumentArtifact {
  metadata: {
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    pageCount?: number;
    providerId?: string;
    processingTime?: number;
  };
  blocks: DocumentBlock[];
  assets: DocumentAsset[];
  citations?: DocumentCitation[];
  diagnostics?: DocumentDiagnostic[];
  providerRaw?: unknown;
}
```

The upload/generation compatibility layer returns the existing `ParsedPdfContent` shape:

```ts
interface ParsedPdfContent {
  text: string;
  images: string[];
  tables?: unknown[];
  formulas?: unknown[];
  layout?: unknown[];
  metadata?: {
    pageCount: number;
    parser?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    processingTime?: number;
    imageMapping?: Record<string, string>;
    pdfImages?: Array<{
      id: string;
      src: string;
      pageNumber: number;
      description?: string;
    }>;
  };
}
```

This keeps existing generation prompts and image assignment logic stable while allowing the upload boundary to evolve beyond PDF.

## Current Scope and Non-Goals

Included:

- Single-file course material upload.
- PDF, DOCX, PPTX, TXT, and Markdown validation.
- Provider selection by explicit user choice or capability match.
- Clear errors for unsupported formats and unsupported provider/format combinations.

Not included:

- Multi-document bundles.
- Long-document transforms or chapter slicing.
- RAG, vector storage, or persistent knowledge workspaces.
- A general knowledge-base UI.
