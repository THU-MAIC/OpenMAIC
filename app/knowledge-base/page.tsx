'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type KnowledgeDocument = {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  embeddingModel: string;
  pageCount?: number;
  chunkCount: number;
  errorMessage?: string;
  createdAt: string;
};

function formatSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function KnowledgeBasePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/knowledge/documents');
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '无法加载知识库');
      setDocuments(data.documents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法加载知识库');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const uploadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('目前仅支持 PDF 材料。');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const response = await fetch('/api/knowledge/documents', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '材料入库失败');
      await loadDocuments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '材料入库失败');
      await loadDocuments();
    } finally {
      setUploading(false);
    }
  };

  const deleteDocument = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/documents/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '删除失败');
      setDocuments((previous) => previous.filter((document) => document.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回课堂生成
          </Link>
          <div className="flex items-center gap-3">
            <Button asChild variant="outline" size="sm">
              <Link href="/knowledge-base/settings">
                <SlidersHorizontal className="size-4" />
                检索参数
              </Link>
            </Button>
            <div className="hidden items-center gap-2 text-sm font-medium sm:inline-flex">
              <Database className="size-4" />
              材料知识库
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold">材料知识库</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            上传 PDF 后，文本与原文件将写入 PostgreSQL，并使用 BGE 生成向量索引用于课程检索。
          </p>
        </div>

        <section className="mb-8">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) void uploadFile(file);
            }}
            className={cn(
              'flex h-40 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed transition-colors',
              dragging ? 'border-primary bg-muted' : 'border-border hover:bg-muted/50',
              uploading && 'cursor-wait opacity-70',
            )}
          >
            {uploading ? (
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="size-7 text-muted-foreground" />
            )}
            <div className="text-sm font-medium">
              {uploading ? '正在解析并生成向量...' : '上传 PDF 材料'}
            </div>
            <div className="text-xs text-muted-foreground">最大 50 MB</div>
          </button>
        </section>

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">已入库材料</h2>
            <Button variant="outline" size="sm" onClick={() => void loadDocuments()}>
              刷新
            </Button>
          </div>
          {loading ? (
            <div className="flex h-28 items-center justify-center border border-border">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : documents.length === 0 ? (
            <div className="flex h-28 items-center justify-center border border-border text-sm text-muted-foreground">
              暂无材料
            </div>
          ) : (
            <div className="divide-y divide-border border border-border">
              {documents.map((document) => (
                <div
                  key={document.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{document.fileName}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatSize(document.fileSize)}
                        {document.pageCount ? ` / ${document.pageCount} 页` : ''}
                        {document.chunkCount ? ` / ${document.chunkCount} 个检索片段` : ''}
                        {` / ${document.embeddingModel}`}
                      </div>
                      {document.errorMessage && (
                        <div className="mt-1 text-xs text-destructive">{document.errorMessage}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-xs',
                        document.status === 'ready'
                          ? 'text-emerald-600'
                          : document.status === 'failed'
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                      )}
                    >
                      {document.status === 'ready' ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : document.status === 'failed' ? (
                        <AlertCircle className="size-3.5" />
                      ) : (
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      {document.status === 'ready'
                        ? '已就绪'
                        : document.status === 'failed'
                          ? '失败'
                          : '处理中'}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={deletingId === document.id}
                      onClick={() => void deleteDocument(document.id)}
                      aria-label={`删除 ${document.fileName}`}
                    >
                      {deletingId === document.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
