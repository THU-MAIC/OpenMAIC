import { useMemo, type CSSProperties } from 'react';
import type { SlideBackground, SlideTheme } from '@openmaic/dsl';

function isColorDark(color?: string): boolean {
  if (!color || typeof color !== 'string') return false;
  const hex = color.trim().toLowerCase();
  if (hex.startsWith('#')) {
    const raw = hex.slice(1);
    if (raw.length === 3) {
      const r = parseInt(raw[0] + raw[0], 16);
      const g = parseInt(raw[1] + raw[1], 16);
      const b = parseInt(raw[2] + raw[2], 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    }
    if (raw.length === 6) {
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    }
  }
  if (hex.startsWith('rgb')) {
    const match = hex.match(/\d+/g);
    if (match && match.length >= 3) {
      const r = Number(match[0]);
      const g = Number(match[1]);
      const b = Number(match[2]);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    }
  }
  return ['black', 'navy', 'darkblue', 'midnightblue', '#000', '#111', '#222'].includes(hex);
}

export function computeSlideBackgroundStyle(
  background: SlideBackground | undefined,
  theme?: SlideTheme,
): CSSProperties {
  if (!background) return { backgroundColor: theme?.backgroundColor ?? '#fff' };

  const { type, color, image, gradient } = background;

  if (type === 'solid') {
    const isThemeLight = !theme?.backgroundColor || !isColorDark(theme.backgroundColor);
    if (isThemeLight && isColorDark(color)) {
      return { backgroundColor: theme?.backgroundColor ?? '#ffffff' };
    }
    return { backgroundColor: color };
  }

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
}

export function useSlideBackgroundStyle(
  background: SlideBackground | undefined,
  theme?: SlideTheme,
) {
  const backgroundStyle = useMemo<CSSProperties>(
    () => computeSlideBackgroundStyle(background, theme),
    [background, theme],
  );

  return { backgroundStyle };
}
