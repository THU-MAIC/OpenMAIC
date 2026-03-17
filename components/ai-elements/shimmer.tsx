'use client';

import { cn } from '@/lib/utils';
import { type MotionProps, motion } from 'motion/react';
import { type CSSProperties, type ElementType, type JSX, memo, useMemo, useRef } from 'react';

type MotionComponentType = React.FC<
  MotionProps & React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }
>;

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

/* eslint-disable react-hooks/refs -- Ref-based cache for motion.create component identity */
const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const motionRef = useRef<MotionComponentType | null>(null);
  const prevComponentRef = useRef(Component);
  if (!motionRef.current || prevComponentRef.current !== Component) {
    motionRef.current = motion.create(
      Component as keyof JSX.IntrinsicElements,
    ) as unknown as MotionComponentType;
    prevComponentRef.current = Component;
  }
  const MotionComponent = motionRef.current;

  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: 'linear',
      }}
    >
      {children}
    </MotionComponent>
  );
};
/* eslint-enable react-hooks/refs */

export const Shimmer = memo(ShimmerComponent);
