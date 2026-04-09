import { useState, useEffect, useMemo } from 'react';
import type { Slide, PPTElement } from '@/lib/types/slides';

// Reflow configuration
const PORTRAIT_WIDTH = 800; // Virtual width for portrait mode
const PADDING_X = 40;
const USABLE_WIDTH = PORTRAIT_WIDTH - PADDING_X * 2;

function boostHtmlFontSize(html: string, multiplier: number): string {
  // Regex to match font-size: Xpx
  return html.replace(/font-size:\s*([\d.]+)px/gi, (match, p1) => {
    const size = parseFloat(p1);
    return `font-size: ${Math.round(size * multiplier)}px`;
  });
}

function estimateTextHeight(html: string, width: number): number {
  // A rough heuristic based on char count, considering font boosting
  const textContent = html.replace(/<[^>]+>/g, '') || '';
  const charCount = textContent.length;
  // Assume an average font size of 24px (boosted). Average char width is ~12px
  const charsPerLine = width / 12;
  const lines = Math.ceil(charCount / charsPerLine) || 1;
  return lines * 36; // ~36px line height
}

export function reflowToPortrait(originalSlide: Slide): Slide {
  // Deep clone to prevent mutating original data
  const slide: Slide = JSON.parse(JSON.stringify(originalSlide));

  // Set new virtual dimensions (9:16 aspect ratio)
  slide.viewportSize = PORTRAIT_WIDTH;
  slide.viewportRatio = 9 / 16;

  if (!slide.elements || slide.elements.length === 0) {
    return slide;
  }

  // Sort elements: top-to-bottom
  const sortedElements = [...slide.elements].sort((a, b) => a.top - b.top);

  // Group elements that overlap significantly into rows (for multi-column layouts)
  const rows: PPTElement[][] = [];
  let currentRow: PPTElement[] = [];
  let currentTop = sortedElements[0].top;

  for (const el of sortedElements) {
    if (Math.abs(el.top - currentTop) < 60) {
      currentRow.push(el);
    } else {
      if (currentRow.length > 0) {
        // Sort the row left-to-right
        currentRow.sort((a, b) => a.left - b.left);
        rows.push(currentRow);
      }
      currentRow = [el];
      currentTop = el.top;
    }
  }
  if (currentRow.length > 0) {
    currentRow.sort((a, b) => a.left - b.left);
    rows.push(currentRow);
  }

  // Now place them vertically
  let currentY = 40;

  for (const row of rows) {
    for (const item of row) {
      const el = item as any;
      el.top = currentY;

      if (el.type === 'text') {
        el.left = PADDING_X;
        el.width = USABLE_WIDTH;
        el.height = Math.max(el.height, estimateTextHeight(el.content, USABLE_WIDTH));
        el.content = boostHtmlFontSize(el.content, 1.8); // 1.8x font boost
      } else if (el.type === 'image' || el.type === 'shape') {
        const ratio = el.height / (el.width || 1);
        el.width = Math.min(el.width * 1.5, USABLE_WIDTH);
        el.height = el.width * ratio;
        el.left = (PORTRAIT_WIDTH - el.width) / 2; // Center media
        if (el.type === 'shape' && el.text) {
          el.text.content = boostHtmlFontSize(el.text.content, 1.8);
        }
      } else if (el.type === 'chart' || el.type === 'table' || el.type === 'latex') {
        const ratio = el.height / (el.width || 1);
        el.width = USABLE_WIDTH;
        el.height = el.width * ratio;
        el.left = PADDING_X;
      } else {
        // Fallback for line, video, audio
        el.left = PADDING_X;
        el.width = USABLE_WIDTH;
      }

      currentY += el.height + 40; // 40px gap below elements
    }
  }

  return slide;
}

export function usePortraitReflow(slide: Slide): Slide {
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    // Only apply reflow to mobile screens in portrait mode
    const mediaQuery = window.matchMedia('(orientation: portrait) and (max-width: 640px)');
    
    // Initial check
    setIsPortrait(mediaQuery.matches);

    // Listener for orientation changes
    const handleOrientationChange = (e: MediaQueryListEvent) => {
      setIsPortrait(e.matches);
    };

    mediaQuery.addEventListener('change', handleOrientationChange);
    return () => mediaQuery.removeEventListener('change', handleOrientationChange);
  }, []);

  return useMemo(() => {
    if (!slide) return slide;
    return isPortrait ? reflowToPortrait(slide) : slide;
  }, [slide, isPortrait]);
}
