interface RotateHandlerProps {
  readonly style?: React.CSSProperties;
  readonly className?: string;
  readonly onMouseDown?: (e: React.MouseEvent) => void;
}

export function RotateHandler({ style, className, onMouseDown }: RotateHandlerProps) {
  return (
    <div
      className={`rotate-handler absolute w-[10px] h-[10px] -top-[25px] -ml-[5px] border border-primary bg-white rounded-[1px] cursor-grab active:cursor-grabbing ${className || ''}`}
      style={style}
      onMouseDown={onMouseDown}
    />
  );
}
