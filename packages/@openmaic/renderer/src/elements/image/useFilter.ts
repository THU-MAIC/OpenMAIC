import { useMemo } from 'react';
import type { ImageElementFilterKeys, ImageElementFilters } from '@openmaic/dsl';

const FILTER_UNITS: Record<ImageElementFilterKeys, string> = {
  blur: 'px',
  brightness: '%',
  contrast: '%',
  grayscale: '%',
  saturate: '%',
  'hue-rotate': 'deg',
  sepia: '%',
  invert: '%',
  opacity: '%',
};

export function useFilter(filters?: ImageElementFilters) {
  const filter = useMemo(() => {
    return imageFiltersToCss(filters);
  }, [filters]);

  return { filter };
}

export function imageFiltersToCss(filters?: ImageElementFilters): string {
  if (!filters) return '';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(filters) as [ImageElementFilterKeys, string][]) {
    if (value === undefined || value === null || value === '') continue;
    const unit = FILTER_UNITS[name] ?? '';
    const rendered = unit && !value.endsWith(unit) ? `${value}${unit}` : value;
    parts.push(`${name}(${rendered})`);
  }
  return parts.join(' ');
}
