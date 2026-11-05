'use client';

import { Dialog } from 'radix-ui';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Modal entry barrier; failures release it so recovery controls remain usable. */
export function WorkbenchLoading({ root }: { root: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  );
  useEffect(() => {
    const sync = () => setNativeFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  return (
    <Dialog.Root open>
      <Dialog.Portal container={root.current}>
        <Dialog.Overlay
          className="absolute inset-0 z-[60] bg-black/70"
          data-testid="pbl-workbench-loading"
        />
        <Dialog.Content
          // Rebuild only the modal boundary when the workspace portal reparents.
          key={nativeFullscreen ? 'native' : 'page'}
          ref={content}
          className="absolute left-1/2 top-1/2 z-[61] w-[min(22rem,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-popover p-6 text-center text-popover-foreground shadow-2xl outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            root.current?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <LoaderCircle className="mx-auto mb-3 animate-spin text-primary" aria-hidden="true" />
          <Dialog.Title className="text-base font-semibold">
            {t('pblV3.onboarding.loading')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {t('pblV3.onboarding.loadingDetail')}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
