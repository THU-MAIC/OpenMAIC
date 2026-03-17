'use client';

import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideBackground } from '@/lib/types/slides';

/**
 * Viewport background component using Scene Context
 * Renders the slide background from current scene data
 */
export function ViewportBackground() {
  // Subscribe only to background for performance
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );

  const { backgroundStyle: bgStyle } = useSlideBackgroundStyle(background);

  const backgroundStyle: React.CSSProperties = {
    ...bgStyle,
    width: '100%',
    height: '100%',
    backgroundPosition: 'center',
    position: 'absolute',
    pointerEvents: 'none', // Don't block mouse events
  };

  return <div className="viewport-background" style={backgroundStyle} />;
}
