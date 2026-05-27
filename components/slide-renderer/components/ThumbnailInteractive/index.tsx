import { useMemo, useRef, useState, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

interface ThumbnailInteractiveProps {
  /** Interactive content to render */
  readonly content: InteractiveContent;
  /** Thumbnail width in pixels */
  readonly size: number;
  /** Viewport width base (default 1000px) */
  readonly viewportSize?: number;
}

/**
 * Thumbnail interactive component
 *
 * Renders a thumbnail preview of interactive HTML content via iframe.
 * Uses IntersectionObserver for lazy loading - only mounts iframe when visible.
 * Uses CSS transform scale to resize the entire view for better performance.
 */
export function ThumbnailInteractive({
  content,
  size,
  viewportSize = 1000,
}: ThumbnailInteractiveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Intersection observer for lazy loading
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          setIsVisible(entry.isIntersecting);
        });
      },
      { threshold: 0.1, rootMargin: '50px' }, // Pre-load when within 50px of viewport
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Calculate scale ratio
  const scale = useMemo(() => size / viewportSize, [size, viewportSize]);

  // Patch HTML for iframe rendering (only when visible to save memory)
  const patchedHtml = useMemo(
    () => (isVisible && content.html ? patchHtmlForIframe(content.html) : undefined),
    [isVisible, content.html],
  );

  // Calculate thumbnail height (16:9 aspect ratio)
  const height = size * 0.5625;

  return (
    <div
      ref={containerRef}
      className="thumbnail-interactive overflow-hidden select-none bg-white"
      style={{
        width: `${size}px`,
        height: `${height}px`,
      }}
    >
      {!isVisible ? (
        // Placeholder when not visible
        <div className="w-full h-full flex justify-center items-center bg-gray-100 dark:bg-gray-800 text-gray-400 text-xs">
          Interactive
        </div>
      ) : (
        <div
          className="origin-top-left"
          style={{
            width: `${viewportSize}px`,
            height: `${viewportSize * 0.5625}px`,
            transform: `scale(${scale})`,
            pointerEvents: 'none', // Prevent interaction in thumbnail
          }}
        >
          <iframe
            srcDoc={patchedHtml}
            src={patchedHtml ? undefined : content.url}
            className="w-full h-full border-0"
            title="Interactive Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      )}
    </div>
  );
}
