import { useMemo } from 'react';

export function useElementFlip(flipH?: boolean, flipV?: boolean) {
  const flipStyle = useMemo(() => {
    let style = '';
    if (flipH && flipV) style = 'rotateX(180deg) rotateY(180deg)';
    else if (flipV) style = 'rotateX(180deg)';
    else if (flipH) style = 'rotateY(180deg)';
    return style;
  }, [flipH, flipV]);

  return { flipStyle };
}
