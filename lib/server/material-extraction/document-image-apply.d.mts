/** Undefined leaves a destination alone; null replaces an unavailable image with its alt text. */
export type RewriteImageTarget = (target: string) => string | null | undefined;
type Range = { start: number; end: number };
interface MarkdownImage extends Range {
  target: string;
  alt: string;
  title?: string | null;
  definition?: Range;
}
interface HtmlImage extends Range {
  target: string;
  alt: string;
  src: Range;
  attributePrefix: string;
  quote: string;
}
export interface ImagePlan {
  markdown: MarkdownImage[];
  html: HtmlImage[];
}

export function applyImagePlan(
  input: string,
  plan: ImagePlan,
  rewriteTarget: RewriteImageTarget,
  refs?: ImageReference[],
): string;
export interface ImageReference {
  start: number;
  end: number;
  key: string;
}
