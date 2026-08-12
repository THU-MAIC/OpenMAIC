import { useMemo } from 'react';
import type { SlideBackground } from '@openmaic/dsl';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { renderableMediaUrl, useResolvedMediaRef } from '@/lib/media/resolve-media-ref';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Convert slide background data to CSS styles
 */
export function useSlideBackgroundStyle(background: SlideBackground | undefined) {
  const stageId = useMediaStageId();
  const ref = background?.type === 'image' ? background.image?.src : undefined;
  const task = useMediaGenerationStore((state) => {
    if (!ref || !stageId) return undefined;
    const direct = state.tasks[ref];
    if (direct?.stageId === stageId) return direct;
    return Object.values(state.tasks).find(
      (candidate) => candidate.stageId === stageId && candidate.placeholderRef === ref,
    );
  });
  const imageGenerationDisabled = useSettingsStore((state) => !state.imageGenerationEnabled);
  const resolution = useResolvedMediaRef(ref, task, imageGenerationDisabled);
  const resolvedSrc = renderableMediaUrl(resolution);
  const backgroundStyle = useMemo<React.CSSProperties>(() => {
    if (!background) return { backgroundColor: '#fff' };

    const { type, color, image, gradient } = background;

    // Solid color background
    if (type === 'solid') return { backgroundColor: color };

    // Image background mode
    // Includes: background image, background size, whether to repeat
    if (type === 'image' && image) {
      const { size } = image;
      const src = resolvedSrc ?? '';
      if (!src) return { backgroundColor: '#fff' };
      if (size === 'repeat') {
        return {
          backgroundImage: `url(${src})`,
          backgroundRepeat: 'repeat',
          backgroundSize: 'contain',
        };
      }
      return {
        backgroundImage: `url(${src})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: size || 'cover',
      };
    }

    // Gradient background
    if (type === 'gradient' && gradient) {
      const { type, colors, rotate } = gradient;
      const list = colors.map((item) => `${item.color} ${item.pos}%`);

      if (type === 'radial') {
        return { backgroundImage: `radial-gradient(${list.join(',')})` };
      }
      return {
        backgroundImage: `linear-gradient(${rotate}deg, ${list.join(',')})`,
      };
    }

    return { backgroundColor: '#fff' };
  }, [background, resolvedSrc]);

  return {
    backgroundStyle,
  };
}
