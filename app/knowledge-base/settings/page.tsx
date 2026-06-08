'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  DEFAULT_RAG_RETRIEVAL_CONFIG,
  RAG_CONFIG_LIMITS,
  RAG_CONFIG_STORAGE_KEY,
  normalizeRagRetrievalConfig,
  readStoredRagRetrievalConfig,
} from '@/lib/rag/config';
import type { RagRetrievalConfig } from '@/lib/types/rag';

export default function KnowledgeSettingsPage() {
  const [config, setConfig] = useState<RagRetrievalConfig>(DEFAULT_RAG_RETRIEVAL_CONFIG);
  const [saved, setSaved] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- Local browser preferences hydrate after mount. */
  useEffect(() => {
    setConfig(readStoredRagRetrievalConfig(localStorage));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateConfig = (next: Partial<RagRetrievalConfig>) => {
    setConfig((previous) => normalizeRagRetrievalConfig({ ...previous, ...next }));
    setSaved(false);
  };

  const saveConfig = () => {
    const normalized = normalizeRagRetrievalConfig(config);
    setConfig(normalized);
    localStorage.setItem(RAG_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
    setSaved(true);
  };

  const restoreDefaults = () => {
    setConfig(DEFAULT_RAG_RETRIEVAL_CONFIG);
    localStorage.setItem(RAG_CONFIG_STORAGE_KEY, JSON.stringify(DEFAULT_RAG_RETRIEVAL_CONFIG));
    setSaved(true);
  };

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link
            href="/knowledge-base"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回材料知识库
          </Link>
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal className="size-4" />
            RAG 检索参数
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">RAG 检索参数</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            参数将在开启本地知识库后的下一次课程生成中使用，并随检索快照保存。
          </p>
        </div>

        <section className="divide-y divide-border border-y border-border">
          <ParameterRow
            id="rag-top-k"
            label="Top-K 检索片段数"
            value={`${config.topK} 个`}
            description="从向量库中选取并交给生成模型的最相关片段数量。"
          >
            <div className="flex items-center gap-4">
              <Slider
                id="rag-top-k"
                min={RAG_CONFIG_LIMITS.topK.min}
                max={RAG_CONFIG_LIMITS.topK.max}
                step={1}
                value={[config.topK]}
                onValueChange={([value]) => updateConfig({ topK: value })}
              />
              <Input
                type="number"
                min={RAG_CONFIG_LIMITS.topK.min}
                max={RAG_CONFIG_LIMITS.topK.max}
                value={config.topK}
                onChange={(event) => updateConfig({ topK: Number(event.target.value) })}
                className="w-20"
                aria-label="Top-K 检索片段数"
              />
            </div>
          </ParameterRow>

          <ParameterRow
            id="rag-min-similarity"
            label="最低相似度"
            value={`${Math.round(config.minSimilarity * 100)}%`}
            description="低于该相似度的片段不会进入课程生成上下文。"
          >
            <div className="flex items-center gap-4">
              <Slider
                id="rag-min-similarity"
                min={RAG_CONFIG_LIMITS.minSimilarity.min}
                max={RAG_CONFIG_LIMITS.minSimilarity.max}
                step={0.05}
                value={[config.minSimilarity]}
                onValueChange={([value]) => updateConfig({ minSimilarity: value })}
              />
              <Input
                type="number"
                min={0}
                max={95}
                step={5}
                value={Math.round(config.minSimilarity * 100)}
                onChange={(event) =>
                  updateConfig({ minSimilarity: Number(event.target.value) / 100 })
                }
                className="w-20"
                aria-label="最低相似度百分比"
              />
            </div>
          </ParameterRow>

          <ParameterRow
            id="rag-context-chars"
            label="上下文字符上限"
            value={`${config.maxContextChars.toLocaleString()} 字符`}
            description="限制检索材料注入提示词的总长度，以控制上下文占用。"
          >
            <div className="flex items-center gap-4">
              <Slider
                id="rag-context-chars"
                min={RAG_CONFIG_LIMITS.maxContextChars.min}
                max={RAG_CONFIG_LIMITS.maxContextChars.max}
                step={1000}
                value={[config.maxContextChars]}
                onValueChange={([value]) => updateConfig({ maxContextChars: value })}
              />
              <Input
                type="number"
                min={RAG_CONFIG_LIMITS.maxContextChars.min}
                max={RAG_CONFIG_LIMITS.maxContextChars.max}
                step={1000}
                value={config.maxContextChars}
                onChange={(event) => updateConfig({ maxContextChars: Number(event.target.value) })}
                className="w-28"
                aria-label="上下文字符上限"
              />
            </div>
          </ParameterRow>
        </section>

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-emerald-700 dark:text-emerald-300">
            {saved ? '配置已保存' : '修改后请保存配置'}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={restoreDefaults}>
              <RotateCcw className="size-4" />
              恢复默认
            </Button>
            <Button type="button" onClick={saveConfig}>
              <Save className="size-4" />
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function ParameterRow({
  id,
  label,
  value,
  description,
  children,
}: {
  id: string;
  label: string;
  value: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4 py-6 md:grid-cols-[210px_minmax(0,1fr)]">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-2 text-lg font-medium">{value}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}
