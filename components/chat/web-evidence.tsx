'use client';

import { useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, Search, TriangleAlert } from 'lucide-react';
import type { ClassroomWebEvidence } from '@/lib/types/chat';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Never make model prose the authority for a source badge. */
function safeHref(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function WebEvidence({ items, active }: { items: ClassroomWebEvidence[]; active: boolean }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const running = active && items.some((item) => item.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!items.length) return null;

  return (
    <div
      className="mt-1.5 space-y-1 text-[11px] text-gray-600 dark:text-gray-300"
      aria-label={t('chat.webEvidence.label')}
    >
      {items.map((item) => {
        const status = item.status === 'running' && !active ? 'cancelled' : item.status;
        const reading = item.kind === 'read';
        const elapsed = Math.max(0, Math.floor(((item.finishedAt ?? now) - item.startedAt) / 1000));
        // A read links only to the page it actually retrieved (a URL that passed
        // the trust gate); a running or failed read shows the requested URL as text.
        const href = status === 'done' ? safeHref(item.url) : undefined;
        const Icon =
          status === 'running'
            ? LoaderCircle
            : status === 'done'
              ? reading
                ? Check
                : Search
              : TriangleAlert;
        const label =
          status === 'running'
            ? reading
              ? 'reading'
              : 'searching'
            : status === 'done'
              ? reading
                ? 'read'
                : 'searched'
              : status === 'cancelled'
                ? 'cancelled'
                : reading
                  ? 'failed'
                  : 'searchFailed';
        return (
          <div
            key={item.id}
            className="rounded-lg border border-gray-200/80 bg-white/70 p-2 dark:border-gray-700 dark:bg-gray-900/40"
            data-web-status={status}
          >
            <div className="flex items-center gap-1.5" role="status" aria-live="polite">
              <Icon
                size={12}
                className={status === 'running' ? 'animate-spin shrink-0' : 'shrink-0'}
              />
              <span>{t(`chat.webEvidence.${label}`)}</span>
              {status === 'running' && <span className="ml-auto tabular-nums">{elapsed}s</span>}
            </div>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex items-start gap-1 text-violet-600 dark:text-violet-300 underline underline-offset-2 break-all"
              >
                <span>{item.title || href}</span>
                <ExternalLink size={11} className="mt-0.5 shrink-0" />
              </a>
            )}
            {href && item.title && (
              <p className="mt-0.5 truncate text-[10px] text-gray-500">{new URL(href).hostname}</p>
            )}
            {!href && reading && item.url && (
              <p className="mt-1 break-all text-gray-500">{item.url}</p>
            )}
            {!reading && item.query && (
              <p className="mt-1 break-words line-clamp-2" title={item.query}>
                {item.query}
              </p>
            )}
            {reading && status === 'done' && (
              <p className="mt-1 text-gray-500">
                {t('chat.webEvidence.range', {
                  start: (item.offset ?? 0) + 1,
                  end: (item.offset ?? 0) + (item.chars ?? 0),
                  total: item.totalChars ?? item.chars ?? 0,
                })}
              </p>
            )}
            {reading && status === 'error' && (
              <p className="mt-1">
                {t(
                  item.reason === 'timeout'
                    ? 'chat.webEvidence.timeout'
                    : 'chat.webEvidence.unverified',
                )}
              </p>
            )}
            {status === 'done' && !reading && (
              <details className="mt-1 space-y-1">
                <summary className="cursor-pointer text-violet-600 dark:text-violet-300">
                  {t('chat.webEvidence.sourceCount', { count: item.sources?.length ?? 0 })}
                </summary>
                <p className="text-gray-500">{t('chat.webEvidence.excerpts')}</p>
                {item.sources?.map((source) => {
                  const url = safeHref(source.url);
                  return url ? (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block break-words underline text-violet-600 dark:text-violet-300"
                    >
                      {source.title || url}
                    </a>
                  ) : null;
                })}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
