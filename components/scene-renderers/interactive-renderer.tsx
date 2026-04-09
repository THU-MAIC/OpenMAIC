'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import type { TeacherAction } from '@/lib/types/widgets';
import { TeacherOverlay } from '@/components/widgets/TeacherOverlay';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function InteractiveRenderer({ content, mode, sceneId }: InteractiveRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [widgetConfig, setWidgetConfig] = useState<InteractiveContent['widgetConfig']>(undefined);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Extract widget config from HTML on mount
  useEffect(() => {
    if (content.widgetConfig) {
      setWidgetConfig(content.widgetConfig);
    } else if (content.html) {
      // Try to extract from embedded JSON
      const match = content.html.match(/<script type="application\/json" id="widget-config">([\s\S]*?)<\/script>/);
      if (match) {
        try {
          setWidgetConfig(JSON.parse(match[1]));
        } catch {
          // Ignore parse errors
        }
      }
    }
  }, [content.html, content.widgetConfig]);

  const hasWidget = content.widgetType && widgetConfig;
  const hasTeacherActions = hasWidget && (content.teacherActions?.length ?? 0) > 0;
  const inPlaybackMode = mode === 'playback';

  return (
    <div className="w-full h-full relative">
      <iframe
        ref={iframeRef}
        srcDoc={patchedHtml}
        src={patchedHtml ? undefined : content.url}
        className="absolute inset-0 w-full h-full border-0"
        title={`Interactive Scene ${sceneId}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />

      {/* Teacher overlay for widgets with teacher actions */}
      {hasTeacherActions && (
        <TeacherOverlay
          actions={content.teacherActions!}
          iframeRef={iframeRef}
          inPlaybackMode={inPlaybackMode}
        />
      )}
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Fixes:
 * - min-h-screen / h-screen → use 100% of iframe viewport
 * - Ensure html/body fill the iframe with no overflow issues
 * - Canvas elements use container sizing instead of viewport
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
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  // Insert right after <head> or at the start of the document
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
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

  // Fallback: prepend
  return iframeCss + html;
}
