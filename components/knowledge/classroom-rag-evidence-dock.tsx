'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Library, Loader2 } from 'lucide-react';
import type { RagEvidence } from '@/lib/types/rag';
import { RagEvidencePanel } from './rag-evidence-panel';

export function ClassroomRagEvidenceDock({
  snapshotId,
  sceneTitle,
}: {
  snapshotId: string;
  sceneTitle: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [result, setResult] = useState<{
    snapshotId: string;
    evidence?: RagEvidence;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/knowledge/snapshots/${encodeURIComponent(snapshotId)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || '无法读取检索依据');
        }
        if (!cancelled) setResult({ snapshotId, evidence: data.evidence });
      })
      .catch((requestError) => {
        if (!cancelled) {
          setResult({
            snapshotId,
            error: requestError instanceof Error ? requestError.message : '无法读取检索依据',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [snapshotId]);
  const activeResult = result?.snapshotId === snapshotId ? result : null;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="hidden h-full w-11 shrink-0 flex-col items-center justify-center gap-3 rounded-md border border-border bg-background text-emerald-700 shadow-sm transition-colors hover:bg-muted lg:flex dark:text-emerald-300"
        title="展开本页参考材料"
      >
        <Library className="size-4" />
        <span className="[writing-mode:vertical-rl] text-xs font-medium">本页参考材料</span>
        <ChevronLeft className="size-3" />
      </button>
    );
  }

  return (
    <aside className="hidden h-full w-80 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-background shadow-sm lg:flex">
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Library className="size-4 text-emerald-600" />
            本页参考材料
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={sceneTitle}>
            {sceneTitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="收起参考材料"
        >
          <ChevronRight className="size-4" />
        </button>
      </header>
      <p className="border-b border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        本页内容与讲解依据本课固定检索快照生成。
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {activeResult?.evidence ? (
          <RagEvidencePanel
            compact
            evidence={activeResult.evidence}
            className="border-0 bg-transparent p-0 shadow-none"
          />
        ) : activeResult?.error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
            {activeResult.error}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取检索依据...
          </div>
        )}
      </div>
    </aside>
  );
}
