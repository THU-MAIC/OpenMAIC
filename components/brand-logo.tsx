import { cn } from '@/lib/utils';

type BrandLogoSize = 'hero' | 'sidebar';

interface BrandLogoProps {
  readonly className?: string;
  readonly size?: BrandLogoSize;
}

const SIZE_STYLES: Record<BrandLogoSize, { wrapper: string; icon: string; text: string }> = {
  hero: {
    wrapper: 'gap-2 md:gap-3',
    icon: 'h-11 w-[3.25rem] md:h-14 md:w-[4.1rem]',
    text: 'text-[2.4rem] md:text-[3.3rem]',
  },
  sidebar: {
    wrapper: 'gap-1.5',
    icon: 'h-6 w-[1.8rem]',
    text: 'text-[1.35rem]',
  },
};

export function BrandLogo({ className, size = 'hero' }: BrandLogoProps) {
  const styles = SIZE_STYLES[size];

  return (
    <div
      className={cn(
        'inline-flex items-center whitespace-nowrap select-none',
        styles.wrapper,
        className,
      )}
      aria-label="MU-OpenMAIC"
    >
      <span
        aria-hidden="true"
        className={cn('shrink-0 rounded-[0.45em]', styles.icon)}
        style={{
          backgroundImage: "url('/logo-horizontal.png')",
          backgroundPosition: 'left center',
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'auto 100%',
        }}
      />
      <span
        className={cn(
          'inline-flex items-baseline font-black leading-none tracking-[-0.08em]',
          styles.text,
        )}
      >
        <span className="bg-gradient-to-r from-violet-600 via-fuchsia-600 to-pink-500 bg-clip-text pr-[0.04em] text-transparent drop-shadow-[0_1px_1px_rgba(0,0,0,0.08)] dark:from-violet-300 dark:via-fuchsia-300 dark:to-pink-300">
          MU-
        </span>
        <span className="bg-gradient-to-r from-slate-900 via-slate-700 to-violet-700 bg-clip-text text-transparent dark:from-white dark:via-slate-100 dark:to-violet-200">
          OpenMAIC
        </span>
      </span>
    </div>
  );
}