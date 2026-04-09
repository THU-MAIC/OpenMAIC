import { useMemo } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';

interface ThumbnailInteractiveProps {
  /** Interactive content to render */
  readonly content: InteractiveContent;
  /** Thumbnail width in pixels */
  readonly size: number;
  /** Viewport width base (default 1000px) */
  readonly viewportSize?: number;
  /** Whether visible (for lazy loading optimization) */
  readonly visible?: boolean;
}

/**
 * Thumbnail interactive component
 *
 * Renders a thumbnail preview of interactive HTML content via iframe
 * Uses CSS transform scale to resize the entire view for better performance
 */
export function ThumbnailInteractive({
  content,
  size,
  viewportSize = 1000,
  visible = true,
}: ThumbnailInteractiveProps) {
  // Calculate scale ratio
  const scale = useMemo(() => size / viewportSize, [size, viewportSize]);

  // Patch HTML for iframe rendering (same as InteractiveRenderer)
  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Calculate thumbnail height (16:9 aspect ratio)
  const height = size * 0.5625;

  if (!visible) {
    return (
      <div
        className="thumbnail-interactive bg-gray-100 dark:bg-gray-800 overflow-hidden select-none"
        style={{
          width: `${size}px`,
          height: `${height}px`,
        }}
      >
        <div className="w-full h-full flex justify-center items-center text-gray-400 text-sm">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div
      className="thumbnail-interactive overflow-hidden select-none bg-white"
      style={{
        width: `${size}px`,
        height: `${height}px`,
      }}
    >
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
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 * Same implementation as InteractiveRenderer.
 */
function patchHtmlForIframe(html: string): string {
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  body { min-height: 100vh; }
</style>`;

  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6;
    return html.substring(0, insertPos) + '\n' + iframeCss + html.substring(insertPos);
  }

  const headWithAttrs = html.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = html.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return html.substring(0, insertPos) + '\n' + iframeCss + html.substring(insertPos);
    }
  }

  return iframeCss + html;
}