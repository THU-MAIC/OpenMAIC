import type { OperateBorderLines } from '@/lib/types/edit';

interface BorderLineProps {
  readonly type: OperateBorderLines;
  readonly isWide?: boolean;
  readonly style?: React.CSSProperties;
  readonly className?: string;
}

export function BorderLine({ type, isWide = false, style, className }: BorderLineProps) {
  const borderClass = {
    top: 'border-t',
    bottom: 'border-b',
    left: 'border-l',
    right: 'border-r',
  }[type];

  const wideBeforeClass = isWide
    ? {
        top: 'before:absolute before:-top-2 before:-left-2 before:w-[calc(100%+16px)] before:h-4 before:bg-transparent before:cursor-move before:content-[""]',
        bottom:
          'before:absolute before:-bottom-2 before:-left-2 before:w-[calc(100%+16px)] before:h-4 before:bg-transparent before:cursor-move before:content-[""]',
        left: 'before:absolute before:-top-2 before:-left-2 before:w-4 before:h-[calc(100%+16px)] before:bg-transparent before:cursor-move before:content-[""]',
        right:
          'before:absolute before:-top-2 before:-right-2 before:w-4 before:h-[calc(100%+16px)] before:bg-transparent before:cursor-move before:content-[""]',
      }[type]
    : '';

  return (
    <div
      className={`border-line absolute inset-0 border-dashed border-primary ${borderClass} ${wideBeforeClass} ${className || ''}`}
      style={style}
    />
  );
}
