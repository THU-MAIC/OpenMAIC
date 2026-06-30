import type { ParsedPdfContent } from '@/lib/types/pdf';
import type {
  DocumentArtifact,
  DocumentAsset,
  DocumentBlock,
  DocumentExtractorInput,
} from './types';

function positionToBbox(position?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): DocumentBlock['bbox'] {
  if (!position) return undefined;
  return position;
}

function bboxToPosition(
  bbox?: DocumentBlock['bbox'],
): { x: number; y: number; width: number; height: number } | undefined {
  if (!bbox) return undefined;
  return bbox;
}

function dataUrlMimeType(src: string): string | undefined {
  if (!src.startsWith('data:')) return undefined;
  const metadataEnd = src.indexOf(',');
  const header = src.slice(5, metadataEnd === -1 ? undefined : metadataEnd);
  const mime = header.split(';')[0];
  return mime || undefined;
}

function isParsedPdfContent(value: unknown): value is ParsedPdfContent {
  return (
    !!value &&
    typeof value === 'object' &&
    'text' in value &&
    'images' in value &&
    Array.isArray((value as ParsedPdfContent).images)
  );
}

function pdfLayoutType(value: unknown): NonNullable<ParsedPdfContent['layout']>[number]['type'] {
  return value === 'title' ||
    value === 'text' ||
    value === 'image' ||
    value === 'table' ||
    value === 'formula'
    ? value
    : 'text';
}

export function parsedPdfToDocumentArtifact(
  parsed: ParsedPdfContent,
  input: DocumentExtractorInput,
): DocumentArtifact {
  const blocks: DocumentBlock[] = [];

  if (parsed.text) {
    blocks.push({
      id: 'document-text',
      type: parsed.metadata?.parser === 'mineru' ? 'markdown' : 'text',
      text: parsed.text,
    });
  }

  parsed.tables?.forEach((table, index) => {
    blocks.push({
      id: `table_${index + 1}`,
      type: 'table',
      text: table.caption,
      pageNumber: table.page,
      metadata: { data: table.data, caption: table.caption },
    });
  });

  parsed.formulas?.forEach((formula, index) => {
    blocks.push({
      id: `formula_${index + 1}`,
      type: 'formula',
      text: formula.latex,
      pageNumber: formula.page,
      bbox: positionToBbox(formula.position),
    });
  });

  parsed.layout?.forEach((layout, index) => {
    blocks.push({
      id: `layout_${index + 1}`,
      type: 'layout',
      text: layout.content,
      pageNumber: layout.page,
      bbox: positionToBbox(layout.position),
      metadata: { layoutType: layout.type },
    });
  });

  const pdfImages = parsed.metadata?.pdfImages;
  const assets: DocumentAsset[] =
    pdfImages && pdfImages.length > 0
      ? pdfImages.map((image) => ({
          id: image.id,
          type: 'image',
          mimeType: dataUrlMimeType(image.src),
          data: image.src,
          pageNumber: image.pageNumber,
          description: image.description,
          width: image.width,
          height: image.height,
        }))
      : parsed.images.map((src, index) => ({
          id: `img_${index + 1}`,
          type: 'image',
          mimeType: dataUrlMimeType(src),
          data: src,
        }));

  return {
    metadata: {
      fileName: input.fileName ?? parsed.metadata?.fileName,
      fileSize: input.fileSize ?? parsed.metadata?.fileSize,
      mimeType: input.mimeType,
      pageCount: parsed.metadata?.pageCount,
      providerId: input.config.providerId,
      processingTime: parsed.metadata?.processingTime,
    },
    blocks,
    assets,
    providerRaw: parsed,
  };
}

export function documentArtifactToParsedPdfContent(artifact: DocumentArtifact): ParsedPdfContent {
  const raw = isParsedPdfContent(artifact.providerRaw) ? artifact.providerRaw : undefined;
  const rawMetadata = raw?.metadata;

  const text = artifact.blocks
    .filter((block) => block.type === 'text' || block.type === 'markdown')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n\n');

  const imageAssets = artifact.assets.filter(
    (asset): asset is DocumentAsset & { data: string } =>
      asset.type === 'image' && typeof asset.data === 'string',
  );
  const images = imageAssets.map((asset) => asset.data as string);
  const imageMapping = Object.fromEntries(imageAssets.map((asset) => [asset.id, asset.data]));
  const tables = artifact.blocks
    .filter((block) => block.type === 'table')
    .map((block) => ({
      page: block.pageNumber ?? 0,
      data: Array.isArray(block.metadata?.data) ? (block.metadata.data as string[][]) : [],
      caption: typeof block.metadata?.caption === 'string' ? block.metadata.caption : block.text,
    }));
  const formulas = artifact.blocks
    .filter((block) => block.type === 'formula' && block.text)
    .map((block) => ({
      page: block.pageNumber ?? 0,
      latex: block.text as string,
      position: bboxToPosition(block.bbox),
    }));
  const layout = artifact.blocks
    .filter((block) => block.type === 'layout')
    .map((block) => ({
      page: block.pageNumber ?? 0,
      type: pdfLayoutType(block.metadata?.layoutType),
      content: block.text ?? '',
      position: bboxToPosition(block.bbox),
    }));

  return {
    text,
    images,
    ...(tables.length > 0 ? { tables } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(layout.length > 0 ? { layout } : {}),
    metadata: {
      ...rawMetadata,
      fileName: artifact.metadata.fileName,
      fileSize: artifact.metadata.fileSize,
      pageCount: artifact.metadata.pageCount ?? rawMetadata?.pageCount ?? 0,
      parser: rawMetadata?.parser,
      processingTime: artifact.metadata.processingTime ?? rawMetadata?.processingTime,
      imageMapping,
      pdfImages: imageAssets.map((asset) => ({
        id: asset.id,
        src: asset.data as string,
        pageNumber: asset.pageNumber ?? 0,
        description: asset.description,
        width: asset.width,
        height: asset.height,
      })),
    },
  };
}
