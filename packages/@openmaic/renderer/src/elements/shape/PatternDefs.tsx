interface PatternDefsProps {
  id: string;
  src: string;
}

export function PatternDefs({ id, src }: PatternDefsProps) {
  return (
    <pattern
      id={id}
      patternContentUnits="objectBoundingBox"
      patternUnits="objectBoundingBox"
      width="1"
      height="1"
    >
      <image href={src} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
    </pattern>
  );
}
