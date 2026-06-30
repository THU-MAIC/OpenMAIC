import { useMemo } from 'react';
import type { ImageElementFilters } from '@openmaic/dsl';

const FILTER_UNITS: Record<keyof ImageElementFilters, string> = {
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
    if (!filters) return '';
    const parts: string[] = [];
    for (const [name, value] of Object.entries(filters) as [keyof ImageElementFilters, string][]) {
      if (value === undefined || value === null || value === '') continue;
      const unit = FILTER_UNITS[name] ?? '';
      parts.push(`${name}(${value}${unit})`);
    }
    return parts.join(' ');
  }, [filters]);

  return { filter };
}
