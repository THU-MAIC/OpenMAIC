import type { GradientColor, GradientType } from '@/lib/types/slides';

interface GradientDefsProps {
  id: string;
  type: GradientType;
  colors: GradientColor[];
  rotate?: number;
}

export function GradientDefs({ id, type, colors, rotate = 0 }: GradientDefsProps) {
  if (type === 'linear') {
    return (
      <linearGradient
        id={id}
        x1="0%"
        y1="0%"
        x2="100%"
        y2="0%"
        gradientTransform={`rotate(${rotate},0.5,0.5)`}
      >
        {colors.map((item, index) => (
          <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
        ))}
      </linearGradient>
    );
  }

  return (
    <radialGradient id={id}>
      {colors.map((item, index) => (
        <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
      ))}
    </radialGradient>
  );
}
