'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { History, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import {
  mergeConversationHistory,
  type LearningConversationEntry,
} from '@/lib/pbl/v3/conversation';

type Source = NonNullable<LearningView['conversationHistory']>[number];
type Page = {
  through: number;
  nextBefore: number | null;
  conversation: LearningConversationEntry[];
};

/** A fixed snapshot, loaded only by explicit clicks, independent of live SSE updates. */
export function ConversationHistory({
  id,
  sources,
  renderEntry,
}: {
  id: string;
  sources: Source[];
  renderEntry: (entry: LearningConversationEntry, dismissForNavigation: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<Source | null>(null);
  const [openedSources, setOpenedSources] = useState<Source[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const navigating = useRef(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const next = pages[0]?.nextBefore;
  const load = async (selected: Source, before?: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({
        id,
        sessionId: selected.sessionId,
        through: String(selected.through),
      });
      if (before !== undefined) params.set('before', String(before));
      const response = await fetch(`/api/pbl/v3/history?${params}`, {
        headers: { 'x-openmaic-sandbox': '1' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('History is unavailable');
      const page = (await response.json()) as Page;
      if (!controller.signal.aborted)
        setPages((older) => (before === undefined ? [page] : [page, ...older]));
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  const select = (selected: Source | null) => {
    request.current?.abort();
    setPages([]);
    setPending(false);
    setFailed(false);
    setSource(selected);
    if (selected) void load(selected);
  };
  useEffect(() => () => request.current?.abort(), []);
  // A workspace can move to another study without unmounting its conversation.
  useEffect(() => {
    request.current?.abort();
    setSource(null);
    setPages([]);
  }, [id]);
  if (!sources.length) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          setPortalContainer(
            trigger.current?.closest<HTMLElement>('[data-pbl-v3-portal]') ??
              (document.fullscreenElement as HTMLElement | null),
          );
          setOpenedSources(sources);
          select(sources[0]);
        }}
        className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <History size={13} />
        {t('pblV3.history.title')}
      </button>
      <Dialog
        open={!!source}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
      >
        <DialogContent
          container={portalContainer}
          overlayClassName="z-[140]"
          className="z-[150] flex max-h-[85dvh] w-[min(56rem,90vw)] flex-col gap-3"
          onCloseAutoFocus={(event) => {
            // The opener is outside DialogTrigger; restore it only for ordinary closes.
            // Accepted navigation supplies its own focus target (IDE/report).
            event.preventDefault();
            if (!navigating.current) trigger.current?.focus();
            navigating.current = false;
          }}
        >
          <DialogTitle className="pr-10">{t('pblV3.history.title')}</DialogTitle>
          <DialogDescription>{t('pblV3.history.description')}</DialogDescription>
          <div className="flex shrink-0 flex-wrap gap-2">
            {openedSources.map((item) => (
              <button
                key={item.sessionId}
                type="button"
                aria-pressed={source?.sessionId === item.sessionId}
                className={`rounded-md px-3 py-1 text-xs ${source?.sessionId === item.sessionId ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => select(item)}
              >
                {t(`pblV3.roles.${item.role}`)}
              </button>
            ))}
          </div>
          <div className="min-h-0 space-y-5 overflow-y-auto" aria-busy={pending}>
            {source && (next || !pages.length) && (
              <button
                type="button"
                disabled={pending}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-60"
                onClick={() => void load(source, next ?? undefined)}
              >
                {pending && <Loader2 size={13} className="animate-spin" />}
                {t(pending ? 'common.loading' : failed ? 'common.retry' : 'pblV3.history.older')}
              </button>
            )}
            {failed && (
              <p role="alert" className="text-xs text-muted-foreground">
                {t('pblV3.history.failed')}
              </p>
            )}
            {mergeConversationHistory(pages.map((page) => page.conversation)).map((entry) => (
              <div key={entry.id}>
                {renderEntry(entry, () => {
                  navigating.current = true;
                  select(null);
                })}
              </div>
            ))}
            {!pending &&
              !failed &&
              pages.length > 0 &&
              pages.every((page) => !page.conversation.length) && (
                <p className="text-xs text-muted-foreground">{t('pblV3.history.empty')}</p>
              )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
