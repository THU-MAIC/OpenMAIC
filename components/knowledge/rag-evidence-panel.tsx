'use client';

import { Database, FileText } from 'lucide-react';
import type { RagEvidence, RagHit } from '@/lib/types/rag';
import { cn } from '@/lib/utils';

type EvidenceData = Pick<RagEvidence, 'query' | 'hits' | 'sources'> &
  Partial<Pick<RagEvidence, 'config'>>;

export function RagEvidencePanel({
  evidence,
  compact = false,
  className,
}: {
  evidence: EvidenceData;
  compact?: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-md border border-border bg-background text-left',
        compact ? 'w-full p-3' : 'p-4',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="size-4 shrink-0 text-emerald-600" />
          <h3 className="truncate text-sm font-semibold">本次检索依据</h3>
        </div>
        <span className="shrink-0 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
          {evidence.sources.length} 份文档 / {evidence.hits.length} 个片段
        </span>
      </div>
      {!compact && evidence.query && (
        <div className="mb-4 space-y-2 text-xs text-muted-foreground">
          <p>
            检索问题：<span className="text-foreground">{evidence.query}</span>
          </p>
          {evidence.config && (
            <p>
              参数：Top-K {evidence.config.topK} / 最低相似度{' '}
              {(evidence.config.minSimilarity * 100).toFixed(0)}% / 上下文上限{' '}
              {evidence.config.maxContextChars.toLocaleString()} 字符
            </p>
          )}
        </div>
      )}
      <div className={cn('space-y-2 overflow-y-auto', compact ? 'max-h-40' : 'max-h-[55vh]')}>
        {evidence.hits.map((hit) => (
          <EvidenceHit key={`${hit.documentId}-${hit.chunkIndex}`} hit={hit} compact={compact} />
        ))}
      </div>
    </section>
  );
}

function EvidenceHit({ hit, compact }: { hit: RagHit; compact: boolean }) {
  return (
    <article className="rounded-md border border-border/70 bg-muted/25 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{hit.documentName}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          片段 {hit.chunkIndex + 1} · {(hit.score * 100).toFixed(1)}%
        </span>
      </div>
      <p
        className={cn(
          'whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground',
          compact && 'line-clamp-2',
        )}
      >
        {hit.excerpt}
      </p>
    </article>
  );
}
