'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import './workbench.css';

/** Native fullscreen keeps a single scene/workspace instance and restores the host classroom on exit. */
export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  return (
    <div
      ref={ref}
      data-testid="pbl-v3-frame"
      className="wbchat pbl-workbench relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="absolute right-2 top-2 z-10">
        <button
          type="button"
          className="rounded p-1.5 text-sm hover:bg-muted"
          aria-label={t(expanded ? 'pblV3.journey.returnClassroom' : 'pblV3.journey.expand')}
          title={t(expanded ? 'pblV3.journey.returnClassroom' : 'pblV3.journey.expand')}
          onClick={async () => {
            setError(false);
            try {
              if (expanded) await document.exitFullscreen();
              else await ref.current?.requestFullscreen();
            } catch {
              setError(true);
            }
          }}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      {error && (
        <p role="alert" className="px-4 text-sm">
          {t('pblV3.journey.fullscreenUnavailable')}
        </p>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
