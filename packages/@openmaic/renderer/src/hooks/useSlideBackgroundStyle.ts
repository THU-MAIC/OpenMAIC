import { useMemo, type CSSProperties } from 'react';
import type { SlideBackground } from '@openmaic/dsl';

export function useSlideBackgroundStyle(background: SlideBackground | undefined) {
  const backgroundStyle = useMemo<CSSProperties>(() => {
    if (!background) return { backgroundColor: '#fff' };

    const { type, color, image, gradient } = background;

    if (type === 'solid') return { backgroundColor: color };

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

    if (type === 'gradient' && gradient) {
      const { type: gradientType, colors, rotate } = gradient;
      const list = colors.map((item) => `${item.color} ${item.pos}%`);

      if (gradientType === 'radial') {
        return { backgroundImage: `radial-gradient(${list.join(',')})` };
      }
      return {
        backgroundImage: `linear-gradient(${rotate}deg, ${list.join(',')})`,
      };
    }

    return { backgroundColor: '#fff' };
  }, [background]);

  return { backgroundStyle };
}
