import { useState, useEffect, useMemo } from 'react';
import type { Slide, PPTElement } from '@/lib/types/slides';
import { useSettingsStore } from '@/lib/store/settings';
import { useCanvasStore } from '@/lib/store/canvas';

const ASPECT_RATIO_PORTRAIT = 5 / 4; // 4:5
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

function isIntersecting(a: any, b: any): boolean {
  const rectA = {
    left: a.left,
    top: a.top,
    right: a.left + (a.width || 0),
    bottom: a.top + (a.height || 0),
  };
  const rectB = {
    left: b.left,
    top: b.top,
    right: b.left + (b.width || 0),
    bottom: b.top + (b.height || 0),
  };
  // Small 5px tolerance to group elements intended to be together
  const margin = 5;
  return !(
    rectA.right + margin < rectB.left ||
    rectA.left - margin > rectB.right ||
    rectA.bottom + margin < rectB.top ||
    rectA.top - margin > rectB.bottom
  );
}

export function reflowToPortrait(originalSlide: Slide): Slide {
  const slide: Slide = JSON.parse(JSON.stringify(originalSlide));
  slide.viewportSize = PORTRAIT_WIDTH;
  slide.viewportRatio = ASPECT_RATIO_PORTRAIT;

  if (!slide.elements || slide.elements.length === 0) return slide;

  const elements = slide.elements as any[];
  const n = elements.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i: number): number {
    if (parent[i] === i) return i;
    return (parent[i] = find(parent[i]));
  }

  function union(i: number, j: number) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  }

  // Connect overlapping elements into clusters
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isIntersecting(elements[i], elements[j])) {
        union(i, j);
      }
    }
  }

  // Group elements by cluster
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(i);
  }

  // Build cluster objects with bounding boxes
  const clusters = Array.from(clusterMap.values()).map((indices) => {
    const clusterElements = indices.map((idx) => elements[idx]);
    const minL = Math.min(...clusterElements.map((el) => el.left));
    const minT = Math.min(...clusterElements.map((el) => el.top));
    const maxR = Math.max(...clusterElements.map((el) => el.left + (el.width || 0)));
    const maxB = Math.max(...clusterElements.map((el) => el.top + (el.height || 0)));
    return {
      indices,
      elements: clusterElements,
      left: minL,
      top: minT,
      width: maxR - minL,
      height: maxB - minT,
    };
  });

  // Sort clusters by their original vertical position
  clusters.sort((a, b) => a.top - b.top);

  let currentY = 40;
  for (const cluster of clusters) {
    const clusterWidth = cluster.width || 1;
    // Scale cluster to fit usable width if it's too large, or if it's a primary content cluster
    let k = 1;
    if (clusterWidth > 950) {
      // Full-width elements (like stripes or backgrounds) should span the entire PORTRAIT_WIDTH
      k = PORTRAIT_WIDTH / clusterWidth;
    } else if (clusterWidth > USABLE_WIDTH) {
      k = USABLE_WIDTH / clusterWidth;
    } else if (cluster.elements.some((el) => el.type === 'text' && el.width > 300)) {
      k = Math.min(USABLE_WIDTH / clusterWidth, 1.25);
    }

    const clusterLeftOffset = (PORTRAIT_WIDTH - clusterWidth * k) / 2;

    let maxClusterHeight = 0;
    for (const el of cluster.elements) {
      // Calculate new position relative to cluster bounds
      const relL = el.left - cluster.left;
      const relT = el.top - cluster.top;

      el.left = clusterLeftOffset + relL * k;
      el.top = currentY + relT * k;
      
      const oldWidth = el.width || 0;
      const oldHeight = el.height || 0;

      if (el.type === 'text') {
        el.width = oldWidth * k;
        // Text height is hard to predict after boosting, so we estimate and set a safe minimum
        el.content = boostHtmlFontSize(el.content, 1.6); // 1.6x boost
        el.height = Math.max(oldHeight * k, estimateTextHeight(el.content, el.width));
      } else if (el.type === 'image' || el.type === 'shape') {
        el.width = oldWidth * k;
        el.height = oldHeight * k;
        if (el.type === 'shape' && el.text) {
          el.text.content = boostHtmlFontSize(el.text.content, 1.6);
        }
      } else if (el.type === 'line') {
        // Line uses start/end instead of width/height
        const relStart = [el.start[0] - cluster.left, el.start[1] - cluster.top];
        const relEnd = [el.end[0] - cluster.left, el.end[1] - cluster.top];
        el.start = [clusterLeftOffset + relStart[0] * k, currentY + relStart[1] * k];
        el.end = [clusterLeftOffset + relEnd[0] * k, currentY + relEnd[1] * k];
      } else {
        el.width = oldWidth * k;
        el.height = oldHeight * k;
      }

      maxClusterHeight = Math.max(maxClusterHeight, relT * k + (el.height || 0));
    }

    currentY += maxClusterHeight + 40; // Gap between clusters
  }

  return slide;
}

export function usePortraitReflow(slide: Slide, options: { syncToStore?: boolean } = {}): Slide {
  const { syncToStore = false } = options;
  const mobileReflowPreferred = useSettingsStore((state) => state.mobileReflowPreferred);
  const setViewportRatio = useCanvasStore((state) => state.setViewportRatio);
  const setViewportSize = useCanvasStore((state) => state.setViewportSize);

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

  const active = isPortrait && mobileReflowPreferred;

  // Sync with CanvasStore if requested
  useEffect(() => {
    if (!syncToStore) return;

    if (active) {
      setViewportSize(PORTRAIT_WIDTH);
      setViewportRatio(ASPECT_RATIO_PORTRAIT); // Portrait ratio (4:5)
    } else {
      // Restore standard 16:9
      setViewportSize(1000);
      setViewportRatio(0.5625);
    }
  }, [active, syncToStore, setViewportSize, setViewportRatio]);

  return useMemo(() => {
    if (!slide) return slide;
    return active ? reflowToPortrait(slide) : slide;
  }, [slide, active]);
}
