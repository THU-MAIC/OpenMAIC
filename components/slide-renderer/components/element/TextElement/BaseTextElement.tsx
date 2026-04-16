'use client';

import type { PPTTextElement } from '@/lib/types/slides';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { usePlaybackTextReveal } from '@/components/slide-renderer/Editor/PlaybackTextRevealContext';
import { slideTextRevealMaskStyle } from '@/lib/utils/slide-text-reveal-mask';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const playbackReveal = usePlaybackTextReveal();
  const localReveal =
    target === 'thumbnail' ? null : playbackReveal?.getLocalProgress(elementInfo.id) ?? null;
  const revealMask = slideTextRevealMaskStyle(localReveal, elementInfo.vertical);

  return (
    <div
      className="base-element-text absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className="element-content relative p-[10px] leading-[1.5] break-words"
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            backgroundColor: elementInfo.fill,
            opacity: elementInfo.opacity,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            className={`text ProseMirror-static relative ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
            style={revealMask}
            dangerouslySetInnerHTML={{ __html: elementInfo.content }}
          />
        </div>
      </div>
    </div>
  );
}
