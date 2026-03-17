import { useMemo } from 'react';
import type { SlideBackground } from '@/lib/types/slides';

/**
 * Convert slide background data to CSS styles
 */
export function useSlideBackgroundStyle(background: SlideBackground | undefined) {
  const backgroundStyle = useMemo<React.CSSProperties>(() => {
    if (!background) return { backgroundColor: '#fff' };

    const { type, color, image, gradient } = background;

    // Solid color background
    if (type === 'solid') return { backgroundColor: color };

    // Image background mode
    // Includes: background image, background size, whether to repeat
    if (type === 'image' && image) {
      const { src, size } = image;
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
  }, [background]);

  return {
    backgroundStyle,
  };
}
