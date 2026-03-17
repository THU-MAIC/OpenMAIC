import type { LinePoint } from '@/lib/types/slides';

type NonEmptyLinePoint = Exclude<LinePoint, ''>;

interface LinePointMarkerProps {
  id: string;
  position: 'start' | 'end';
  type: NonEmptyLinePoint;
  baseSize: number;
  color?: string;
}

const pathMap: Record<NonEmptyLinePoint, string> = {
  dot: 'm0 5a5 5 0 1 0 10 0a5 5 0 1 0 -10 0z',
  arrow: 'M0,0 L10,5 0,10 Z',
};

const rotateMap: Record<string, number> = {
  'arrow-start': 180,
  'arrow-end': 0,
};

export function LinePointMarker({ id, position, type, baseSize, color }: LinePointMarkerProps) {
  const path = pathMap[type];
  const rotate = rotateMap[`${type}-${position}`] || 0;
  const size = baseSize < 2 ? 2 : baseSize;

  return (
    <marker
      id={`${id}-${type}-${position}`}
      markerUnits="userSpaceOnUse"
      orient="auto"
      markerWidth={size * 3}
      markerHeight={size * 3}
      refX={size * 1.5}
      refY={size * 1.5}
    >
      <path
        d={path}
        fill={color}
        transform={`scale(${size * 0.3}, ${size * 0.3}) rotate(${rotate}, 5, 5)`}
      />
    </marker>
  );
}
