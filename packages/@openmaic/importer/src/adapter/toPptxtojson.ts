/**
 * Adapter: PresentationData + PptxFiles → pptxtojson/PPTist output format.
 * All dimensions in output are in pt (px * 0.75).
 * Delegates slide serialization to the serializer layer (slideToSlide).
 */

import type { PresentationData } from '../model/Presentation';
import type { PptxFiles } from '../parser/ZipParser';
import type { Output, Slide, Size } from './types';
import { slideToSlide } from '../serializer/slideSerializer';
import { prefetchTexmath } from '../serializer/mathSerializer';
import type { SlideNode } from '../model/Slide';
import type { MediaMode } from '../serializer/RenderContext';

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return px * PX_TO_PT;
}

function getThemeColors(presentation: PresentationData): string[] {
  const themeColors: string[] = [];
  const firstTheme = presentation.themes.values().next().value;
  if (!firstTheme) return ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'];
  for (let i = 1; i <= 6; i++) {
    const hex = firstTheme.colorScheme.get(`accent${i}`) ?? '000000';
    themeColors.push(hex.startsWith('#') ? hex : `#${hex}`);
  }
  return themeColors;
}

/** Collect every OMML string from a slide's top-level nodes (standalone math
 *  elements + inline math runs inside text shapes). Group children are raw XML
 *  parsed later in the serializer, so any (rare) group math falls back to the
 *  JS conversion. */
function collectOmml(nodes: SlideNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.nodeType === 'math') {
      if (n.ommlXmls && n.ommlXmls.length) out.push(...n.ommlXmls);
      else if (n.ommlXml) out.push(n.ommlXml);
    } else if (n.nodeType === 'shape' && n.textBody) {
      for (const p of n.textBody.paragraphs) {
        for (const r of p.runs) if (r.ommlXml) out.push(r.ommlXml);
      }
    }
  }
}

export async function toPptxtojsonFormat(
  presentation: PresentationData,
  files: PptxFiles,
  mediaMode: MediaMode = 'base64',
): Promise<Output> {
  const size: Size = {
    width: pxToPt(presentation.width),
    height: pxToPt(presentation.height),
  };
  const themeColors = getThemeColors(presentation);

  // High-fidelity math: pre-convert all OMML via texmath (/api/texmath) before
  // the synchronous serializer runs. Best-effort — falls back to the JS
  // omml2mathml pipeline where the endpoint isn't reachable.
  const ommlAll: string[] = [];
  for (const slide of presentation.slides) collectOmml(slide.nodes, ommlAll);
  await prefetchTexmath(ommlAll);

  const slides: Slide[] = [];
  for (const slide of presentation.slides) {
    slides.push(await slideToSlide(presentation, slide, files, mediaMode));
  }
  return {
    slides,
    themeColors,
    size,
  };
}
