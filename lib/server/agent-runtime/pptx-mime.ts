export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function isPptxMaterial(input: {
  mime?: string | null;
  originalName?: string | null;
}): boolean {
  const mime = (input.mime ?? '').toLowerCase();
  const name = (input.originalName ?? '').toLowerCase();
  return mime === PPTX_MIME || name.endsWith('.pptx');
}
