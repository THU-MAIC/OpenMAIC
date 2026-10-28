'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ProjectHero } from '../project-hero';
import { PBLWorkspaceLayer } from '../workspace-layer';
import { ProjectReport } from './project-report';
import { PBLV3Workspace, pblRequest } from './workspace';

export function PBLV3Container({ sceneId }: { sceneId: string }) {
  const stageId = useStageStore((state) => state.stage?.id);
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [entrance, setEntrance] = useState<{
    hero: ProjectHeroDetails;
    started: boolean;
    studyId?: string | null;
    reportAvailable?: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [autoExpand, setAutoExpand] = useState(false);
  const [fullscreenRoot, setFullscreenRoot] = useState<Element | null>(null);
  const [portalHost] = useState(() => {
    if (typeof document === 'undefined') return null;
    const host = document.createElement('div');
    host.dataset.pblV3Portal = '';
    return host;
  });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!stageId) return;
    const controller = new AbortController();
    void pblRequest<{
      hero: ProjectHeroDetails;
      started: boolean;
      studyId?: string | null;
      reportAvailable?: boolean;
    }>(
      `/api/pbl/v3?${new URLSearchParams({ project: '1', stageId, sceneId })}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setEntrance(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [stageId, sceneId, reload]);
  useEffect(() => {
    const sync = () => setFullscreenRoot(document.fullscreenElement);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useLayoutEffect(() => {
    if (!portalHost) return;
    // React keeps the workspace instance when its portal target stays identical.
    // Move that same host inside native fullscreen so it remains visible there.
    (fullscreenRoot ?? document.body).appendChild(portalHost);
    return () => portalHost.remove();
  }, [fullscreenRoot, portalHost]);
  const launch = () => {
    setAutoExpand(true);
    setReportOpen(false);
    setEntered(true);
  };
  const returnToHero = useCallback(() => {
    setReportOpen(false);
    setEntered(false);
    setExpanded(false);
    setAutoExpand(false);
    setReload((value) => value + 1);
  }, []);
  return (
    <div ref={hostRef} className="h-full w-full" data-testid="pbl-v3-entry">
      {!entered &&
        (entrance ? (
          <ProjectHero
            details={entrance.hero}
            started={entrance.started}
            completed={!!entrance.reportAvailable}
            onReport={
              entrance.reportAvailable && entrance.studyId
                ? () => {
                    setAutoExpand(true);
                    setReportOpen(true);
                  }
                : undefined
            }
            onStart={launch}
            onContinue={launch}
          />
        ) : error ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-3">
            <p>{error}</p>
            <button
              onClick={() => {
                setError('');
                setReload((value) => value + 1);
              }}
            >
              {t('pblV3.retry')}
            </button>
          </div>
        ) : (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-muted-foreground"
          >
            <LoaderCircle size={16} className="animate-spin" />
            {t('pblV3.loading')}
          </div>
        ))}
      {(entered || reportOpen) &&
        portalHost &&
        createPortal(
          <PBLWorkspaceLayer
            hostRef={hostRef}
            expanded={expanded}
            autoExpand={autoExpand}
            nativeFullscreen={!!fullscreenRoot}
            onExpandedChange={setExpanded}
            onAutoExpandConsumed={() => setAutoExpand(false)}
            showExpandControl
          >
            {reportOpen && entrance?.studyId ? (
              <div className="pbl-workbench relative h-full">
                <ProjectReport
                  studyId={entrance.studyId}
                  title={entrance.hero.title}
                  open
                  onClose={returnToHero}
                  onWorkbench={launch}
                />
              </div>
            ) : (
              <PBLV3Workspace sceneId={sceneId} onReturnToHero={returnToHero} />
            )}
          </PBLWorkspaceLayer>,
          portalHost,
        )}
    </div>
  );
}
