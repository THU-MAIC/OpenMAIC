'use client';

import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** One library view; only its navigation container changes on phones. */
export function HomeLibrary({
  mobile,
  open,
  onOpenChange,
  title,
  headerAction,
  children,
}: {
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  if (!mobile)
    return (
      <div
        data-testid="home-library-inline"
        className="home-library-inline relative z-10 mt-10 w-full max-w-6xl flex flex-col items-center"
      >
        {children}
      </div>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="home-library-drawer"
        className="home-library-drawer"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (
            (event.target as HTMLElement)?.matches(
              '[data-home-course-rename], [data-home-folder-rename]',
            )
          )
            event.preventDefault();
        }}
      >
        <div className="home-library-header">
          <DialogTitle className="home-library-title">{title}</DialogTitle>
          {headerAction && <div className="home-library-header-action">{headerAction}</div>}
        </div>
        <div className="home-library-scroll">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
