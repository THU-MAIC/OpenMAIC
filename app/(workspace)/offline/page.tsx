'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  CheckCircle2,
  CloudOff,
  HardDrive,
  LoaderCircle,
  Play,
  RadioTower,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StorageStatusCard, NetworkStatusBadge } from '@/components/offline';
import { WorkspacePageHeader } from '@/components/workspace/page-header';
import { OfflineStatusBadge } from '@/components/workspace/course-card';
import { useWorkspaceCourses } from '@/components/workspace/use-workspace-courses';
import { auditCourseOfflineCapability, type CourseOfflineAudit } from '@/lib/offline';
import { upsertCourseMetadata } from '@/lib/workspace';
import { getDocumentStore } from '@/lib/document-store';
import { manifestAgentFromConfig } from '@/lib/export/classroom-zip-types';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { assetRefExists } from '@/lib/media/use-asset-url';
import { db, mediaFileKey } from '@/lib/utils/database';

async function durableLocalAssetExists(stageId: string, ref: string): Promise<boolean> {
  if (await assetRefExists(ref).catch(() => false)) return true;

  // v0.3.2 reads the asset pool first, but deliberately retains these Dexie
  // rows as a reload-safe compatibility source for older/imported courses.
  const [mediaRow, audioRow] = await Promise.all([
    db.mediaFiles.get(mediaFileKey(stageId, ref)),
    db.audioFiles.get(ref),
  ]);
  return Boolean(
    (mediaRow && !mediaRow.error && mediaRow.blob.size > 0) || (audioRow && audioRow.blob.size > 0),
  );
}

export default function OfflinePage() {
  const { courses, loading, refresh } = useWorkspaceCourses();
  const [auditing, setAuditing] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, CourseOfflineAudit>>({});

  const auditCourse = useCallback(async (stageId: string, quiet = false) => {
    setAuditing(stageId);
    try {
      const document = await getDocumentStore().loadDocument(stageId);
      if (!document) throw new Error('课程不存在');
      const { stage, scenes } = document;
      const assetRefs = collectStageAssetRefs(document, {
        mediaRows: [],
        audioRows: [],
      });
      const localAssetRefs = [...assetRefs.document].filter(
        (ref) => !isConcreteMediaAddress(ref) || ref.trimStart().startsWith('blob:'),
      );
      const localAssetPresence = await Promise.all(
        localAssetRefs.map((ref) => durableLocalAssetExists(stageId, ref)),
      );
      const missingLocalAssetRefs = localAssetRefs.filter(
        (_ref, index) => !localAssetPresence[index],
      );
      const report = auditCourseOfflineCapability({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        appVersion: 'local',
        stage: {
          name: stage.name,
          description: stage.description,
          language: stage.languageDirective,
          style: stage.style,
          videoManifest: stage.videoManifest,
          whiteboard: stage.whiteboard,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
        },
        agents: (stage.generatedAgentConfigs ?? []).map(manifestAgentFromConfig),
        scenes: scenes.map((scene) => ({
          type: scene.type,
          title: scene.title,
          order: scene.order,
          content: scene.content,
          actions: scene.actions,
          whiteboards: scene.whiteboards,
        })),
        mediaIndex: {},
      });
      for (const assetRef of missingLocalAssetRefs) {
        report.issues.push({
          code: 'missing-package-asset',
          severity: 'degraded',
          message: assetRefs.speechAudioId.has(assetRef)
            ? '旁白音频已从本机资产池中缺失'
            : '课件图片或视频已从本机资产池中缺失',
          path: `assets.${assetRef}`,
        });
      }
      if (missingLocalAssetRefs.length) {
        report.summary.degraded += missingLocalAssetRefs.length;
        if (report.capability !== 'requires-network') {
          report.capability = 'basic';
          report.label = '基础离线';
          report.description = `课程主体可离线打开，但有 ${missingLocalAssetRefs.length} 个本机媒体资源缺失。`;
        }
      }
      setReports((current) => ({ ...current, [stageId]: report }));
      const offlineStatus =
        report.capability === 'fully'
          ? 'complete'
          : report.capability === 'basic'
            ? 'partial'
            : 'network_required';
      await upsertCourseMetadata(stageId, {
        offlineStatus,
        offlineIssueCount: report.issues.length,
        offlineCheckedAt: Date.now(),
      });
      if (!quiet) toast.success('离线检查已完成', { description: report.description });
    } catch (error) {
      if (!quiet)
        toast.error('离线检查失败', {
          description: error instanceof Error ? error.message : '请稍后重试',
        });
    } finally {
      setAuditing(null);
    }
  }, []);

  const auditAll = async () => {
    for (const course of courses) await auditCourse(course.stage.id, true);
    await refresh();
    toast.success('全部课程检查完成');
  };

  const complete = courses.filter((course) => course.metadata.offlineStatus === 'complete').length;
  const partial = courses.filter((course) => course.metadata.offlineStatus === 'partial').length;
  const network = courses.filter(
    (course) => course.metadata.offlineStatus === 'network_required',
  ).length;

  return (
    <div>
      <WorkspacePageHeader
        eyebrow="Offline first"
        title="离线资源"
        description="课程内容保存在浏览器本机存储中。这里能检查外部依赖、保护存储，并清楚区分离线可播放与联网增强能力。"
        actions={
          <>
            <NetworkStatusBadge onlineLabel="网络增强可用" offlineLabel="当前离线" />
            <Button
              onClick={() => void auditAll()}
              disabled={Boolean(auditing) || loading}
              className="h-10 rounded-xl bg-violet-600 px-4 hover:bg-violet-700"
            >
              <RefreshCw className={auditing ? 'animate-spin' : ''} /> 检查全部
            </Button>
          </>
        }
      />

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <StorageStatusCard className="h-full rounded-[24px] border-white bg-white/80 p-5 dark:border-white/10 dark:bg-white/[0.04]" />
        <div className="rounded-[24px] border border-white bg-gradient-to-br from-emerald-50 to-white p-5 dark:border-white/10 dark:from-emerald-950/30 dark:to-white/[0.04]">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <ShieldCheck className="size-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">离线能力分三层</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">状态具体到每一门课程</p>
            </div>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex items-start gap-2 rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              <span>
                <b>完整离线：</b>课程与互动资源均能断网打开。
              </span>
            </div>
            <div className="flex items-start gap-2 rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <CloudOff className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <span>
                <b>基础离线：</b>主体可用，少量媒体或链接需网络。
              </span>
            </div>
            <div className="flex items-start gap-2 rounded-xl bg-white/70 p-3 dark:bg-white/5">
              <RadioTower className="mt-0.5 size-4 shrink-0 text-orange-600" />
              <span>
                <b>网络必需：</b>关键互动页面或脚本仍在公网。
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: '完整离线', value: complete, icon: CheckCircle2, className: 'text-emerald-600' },
          { label: '基础离线', value: partial, icon: CloudOff, className: 'text-amber-600' },
          { label: '需要网络', value: network, icon: RadioTower, className: 'text-orange-600' },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="flex items-center gap-3 rounded-2xl border border-white bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.04]"
            >
              <Icon className={`size-5 ${item.className}`} />
              <div>
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="mt-0.5 text-xl font-semibold">{loading ? '—' : item.value}</p>
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-7 overflow-hidden rounded-[24px] border border-white bg-white/80 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between border-b p-5 dark:border-white/10">
          <div>
            <h2 className="font-semibold">本机课程检查</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              静态检查不会运行课程中的 HTML 或脚本。
            </p>
          </div>
          <HardDrive className="size-5 text-muted-foreground" />
        </div>
        {loading ? (
          <div className="grid min-h-56 place-items-center">
            <LoaderCircle className="size-6 animate-spin text-violet-600" />
          </div>
        ) : courses.length === 0 ? (
          <div className="grid min-h-56 place-items-center p-8 text-sm text-muted-foreground">
            导入课程后即可检查离线能力
          </div>
        ) : (
          <div className="divide-y dark:divide-white/10">
            {courses.map((course) => {
              const report = reports[course.stage.id];
              return (
                <article
                  key={course.stage.id}
                  className="grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/courses/${course.stage.id}`}
                        className="truncate text-sm font-semibold hover:text-violet-700 dark:hover:text-violet-300"
                      >
                        {course.metadata.title || course.stage.name}
                      </Link>
                      <OfflineStatusBadge status={course.metadata.offlineStatus} />
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {report?.description ||
                        (course.metadata.offlineCheckedAt
                          ? `上次检查：${new Intl.DateTimeFormat('zh-CN').format(course.metadata.offlineCheckedAt)}`
                          : '尚未进行离线依赖检查')}
                    </p>
                    {report?.issues.length ? (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                        {report.issues.length} 项依赖 · {report.issues[0].message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="h-9 rounded-xl bg-transparent"
                      disabled={auditing === course.stage.id}
                      onClick={() => void auditCourse(course.stage.id)}
                    >
                      {auditing === course.stage.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <RefreshCw />
                      )}{' '}
                      检查
                    </Button>
                    <Button asChild className="h-9 rounded-xl bg-violet-600 hover:bg-violet-700">
                      <Link href={`/classroom/${course.stage.id}`}>
                        <Play /> 打开
                      </Link>
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
