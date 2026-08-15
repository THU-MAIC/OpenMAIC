'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Slide } from '@openmaic/dsl';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Clock3,
  Copy,
  Layers3,
  LoaderCircle,
  PencilLine,
  Play,
  RadioTower,
  Save,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CourseCover, OfflineStatusBadge } from '@/components/workspace/course-card';
import {
  createTeacherVariant,
  getWorkspaceCourse,
  upsertCourseMetadata,
  type CourseDomain,
  type WorkspaceCourse,
} from '@/lib/workspace';
import { COURSE_TYPES, GRADE_BANDS, taxonomyForDomain } from '@/lib/workspace/taxonomy';
import { getFirstSlideByStages, revokeThumbnailSlideMediaUrls } from '@/lib/utils/stage-storage';
import { cn } from '@/lib/utils';

const sceneNames: Record<string, string> = {
  slide: '课件',
  quiz: '测验',
  interactive: '互动网页',
  pbl: '项目学习',
};

function MetaEditor({
  course,
  open,
  onOpenChange,
  onSaved,
}: {
  course: WorkspaceCourse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(course.metadata.title || course.stage.name);
  const [summary, setSummary] = useState(course.metadata.summary || course.stage.description || '');
  const [domain, setDomain] = useState<CourseDomain>(course.metadata.domain);
  const [subject, setSubject] = useState(course.metadata.subject || '');
  const [gradeBands, setGradeBands] = useState<string[]>(course.metadata.gradeBands ?? []);
  const [courseType, setCourseType] = useState(
    COURSE_TYPES.find((item) => course.metadata.tags?.includes(item)) || '',
  );
  const [tags, setTags] = useState(
    (course.metadata.tags ?? []).filter((item) => !COURSE_TYPES.includes(item)).join('、'),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(course.metadata.title || course.stage.name);
    setSummary(course.metadata.summary || course.stage.description || '');
    setDomain(course.metadata.domain);
    setSubject(course.metadata.subject || '');
    setGradeBands(course.metadata.gradeBands ?? []);
    setCourseType(COURSE_TYPES.find((item) => course.metadata.tags?.includes(item)) || '');
    setTags((course.metadata.tags ?? []).filter((item) => !COURSE_TYPES.includes(item)).join('、'));
  }, [course, open]);

  const categories = taxonomyForDomain(domain);

  const save = async () => {
    if (!title.trim()) {
      toast.error('课程名称不能为空');
      return;
    }
    setSaving(true);
    try {
      const freeTags = tags
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
      await upsertCourseMetadata(course.stage.id, {
        title: title.trim(),
        summary: summary.trim(),
        domain,
        subject: subject || undefined,
        category: categories.find((item) => item.id === subject)?.label,
        gradeBands,
        tags: [...new Set([...(courseType ? [courseType] : []), ...freeTags])],
      });
      await onSaved();
      window.dispatchEvent(new CustomEvent('openmaic:workspace-changed'));
      onOpenChange(false);
      toast.success('课程信息已保存');
    } catch (error) {
      toast.error('保存失败', {
        description: error instanceof Error ? error.message : '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>整理课程信息</DialogTitle>
          <DialogDescription>
            这些信息用于本机课程检索与资源库分类，不会改变课堂内容。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 py-2 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="course-title">课程名称</Label>
            <Input
              id="course-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="course-summary">课程简介</Label>
            <Textarea
              id="course-summary"
              rows={3}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="教学内容、目标和适用场景"
            />
          </div>
          <div className="space-y-2">
            <Label>资源大类</Label>
            <Select
              value={domain}
              onValueChange={(value) => {
                setDomain(value as CourseDomain);
                setSubject('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="subject">学科课程</SelectItem>
                <SelectItem value="extracurricular">课外知识</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>具体门类</Label>
            <Select value={subject} onValueChange={setSubject}>
              <SelectTrigger>
                <SelectValue placeholder="选择课程门类" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>课程类型</Label>
            <Select
              value={courseType || '__none'}
              onValueChange={(value) => setCourseType(value === '__none' ? '' : value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择课程类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">暂不设置</SelectItem>
                {COURSE_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-tags">知识点标签</Label>
            <Input
              id="course-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="用顿号分隔"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>适用学段</Label>
            <div className="flex flex-wrap gap-2">
              {GRADE_BANDS.map((item) => {
                const selected = gradeBands.includes(item);
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() =>
                      setGradeBands((current) =>
                        current.includes(item)
                          ? current.filter((value) => value !== item)
                          : [...current, item],
                      )
                    }
                    className={cn(
                      'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs transition-colors',
                      selected
                        ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300'
                        : 'bg-background text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {selected && <Check className="size-3" />} {item}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving} className="bg-violet-600 hover:bg-violet-700">
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />} 保存信息
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CourseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const stageId = params.id;
  const [course, setCourse] = useState<WorkspaceCourse | null>(null);
  const [slide, setSlide] = useState<Slide | undefined>();
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [adapting, setAdapting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextCourse = await getWorkspaceCourse(stageId);
      if (!nextCourse) {
        setNotFound(true);
        setCourse(null);
        return;
      }
      setNotFound(false);
      setCourse(nextCourse);
      const nextSlides = await getFirstSlideByStages([stageId]);
      setSlide((current) => {
        if (current) revokeThumbnailSlideMediaUrls({ [stageId]: current });
        return nextSlides[stageId];
      });
    } catch (nextError) {
      setCourse(null);
      setLoadError(nextError instanceof Error ? nextError.message : '无法读取本机课程');
    } finally {
      setLoading(false);
    }
  }, [stageId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (slide) revokeThumbnailSlideMediaUrls({ [stageId]: slide });
    },
    [slide, stageId],
  );

  const estimatedMinutes = useMemo(
    () => course?.metadata.estimatedMinutes ?? Math.max(10, (course?.sceneCount ?? 0) * 4),
    [course],
  );

  const adapt = async () => {
    if (!course) return;
    if (course.metadata.kind === 'teacher_variant') {
      router.push(`/classroom/${course.stage.id}?mode=edit`);
      return;
    }
    setAdapting(true);
    try {
      const variant = await createTeacherVariant(course.stage.id, {
        name: `${course.metadata.title || course.stage.name} · 我的适配版`,
        label: '我的教学版本',
      });
      window.dispatchEvent(new CustomEvent('openmaic:workspace-changed'));
      toast.success('已创建独立适配副本', { description: '原始课程保持不变。' });
      router.push(`/classroom/${variant.stage.id}?mode=edit`);
    } catch (error) {
      toast.error('无法创建适配副本', {
        description: error instanceof Error ? error.message : '请稍后重试',
      });
      setAdapting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] animate-pulse rounded-[28px] bg-white/70 dark:bg-white/5" />
    );
  }

  if (loadError) {
    return (
      <div className="grid min-h-[70vh] place-items-center rounded-[28px] border border-red-200 bg-red-50/70 p-8 text-center dark:border-red-900 dark:bg-red-950/20">
        <div>
          <BookOpen className="mx-auto size-10 text-red-500" />
          <h1 className="mt-4 text-xl font-semibold">无法读取这门课程</h1>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{loadError}</p>
          <Button onClick={() => void load()} className="mt-5 rounded-xl">
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (notFound || !course) {
    return (
      <div className="grid min-h-[70vh] place-items-center rounded-[28px] border border-dashed bg-white/60 p-8 text-center dark:bg-white/[0.03]">
        <div>
          <BookOpen className="mx-auto size-10 text-muted-foreground" />
          <h1 className="mt-4 text-xl font-semibold">找不到这门课程</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            课程可能已从本机删除，或链接已经失效。
          </p>
          <Button asChild className="mt-5 rounded-xl">
            <Link href="/courses">返回我的课程</Link>
          </Button>
        </div>
      </div>
    );
  }

  const title = course.metadata.title || course.stage.name;
  const category = taxonomyForDomain(course.metadata.domain).find(
    (item) => item.id === course.metadata.subject,
  );
  const sourceLabels: Record<string, string> = {
    created: '本机创建',
    imported_zip: '导入资源包',
    imported_folder: '导入文件夹',
    library: '公共资源库',
    legacy: '已有本机课程',
    teacher_variant: '教师适配副本',
  };

  return (
    <div>
      <Link
        href="/courses"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 返回我的课程
      </Link>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.75fr)]">
        <div className="overflow-hidden rounded-[28px] border border-white bg-white/85 shadow-sm shadow-violet-100/60 dark:border-white/10 dark:bg-white/[0.04] dark:shadow-none">
          <CourseCover course={course} slide={slide} />
          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                {course.metadata.domain === 'subject' ? '学科课程' : '课外知识'}
              </Badge>
              {category && <Badge variant="outline">{category.label}</Badge>}
              {course.metadata.kind === 'teacher_variant' && (
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  <PencilLine /> 我的适配版
                </Badge>
              )}
            </div>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-[32px]">{title}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-[15px]">
              {course.metadata.summary ||
                course.stage.description ||
                '这门课程还没有简介。可以点击“整理课程信息”补充教学目标和适用范围。'}
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                asChild
                size="lg"
                className="h-11 rounded-xl bg-violet-600 px-5 hover:bg-violet-700"
              >
                <Link href={`/classroom/${course.stage.id}`}>
                  <Play /> 直接授课
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 rounded-xl bg-white/70 px-5 dark:bg-white/5"
                onClick={adapt}
                disabled={adapting}
              >
                {adapting ? (
                  <LoaderCircle className="animate-spin" />
                ) : course.metadata.kind === 'teacher_variant' ? (
                  <PencilLine />
                ) : (
                  <Copy />
                )}
                {course.metadata.kind === 'teacher_variant' ? '继续备课' : '复制并适配'}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                className="h-11 rounded-xl"
                onClick={() => setEditingMeta(true)}
              >
                <Tag /> 整理课程信息
              </Button>
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-white bg-white/85 p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">离线可用性</h2>
              <OfflineStatusBadge status={course.metadata.offlineStatus} />
            </div>
            <div className="mt-4 rounded-xl bg-emerald-50 p-3.5 text-xs leading-5 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-medium">
                <ShieldCheck className="size-4" /> 核心课程已保存在本机
              </div>
              <p className="mt-1.5 opacity-80">
                课堂页面、已打包音视频可离线打开。AI
                对话、联网搜索和云端语音仍取决于网络或本地模型。
              </p>
            </div>
            {course.metadata.offlineIssueCount > 0 && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <RadioTower className="size-3.5" /> 检测到 {course.metadata.offlineIssueCount}{' '}
                项外部依赖
              </p>
            )}
            <Button asChild variant="ghost" className="mt-2 w-full justify-between rounded-xl">
              <Link href="/offline">查看离线资源管理</Link>
            </Button>
          </div>

          <div className="rounded-2xl border border-white bg-white/85 p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <h2 className="font-semibold">课程概览</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted/60 p-3">
                <Layers3 className="size-4 text-violet-600" />
                <p className="mt-2 text-lg font-semibold">{course.sceneCount}</p>
                <p className="text-[11px] text-muted-foreground">教学场景</p>
              </div>
              <div className="rounded-xl bg-muted/60 p-3">
                <Clock3 className="size-4 text-violet-600" />
                <p className="mt-2 text-lg font-semibold">约 {estimatedMinutes}</p>
                <p className="text-[11px] text-muted-foreground">分钟</p>
              </div>
            </div>
            <div className="mt-4 space-y-2.5 text-xs">
              {Object.entries(course.sceneTypeCounts).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{sceneNames[type] || type}</span>
                  <span>{count} 个</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white bg-white/85 p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <h2 className="font-semibold">来源与适用范围</h2>
            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">来源</dt>
                <dd className="text-right">
                  {sourceLabels[course.metadata.source.kind] || course.metadata.source.kind}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">适用学段</dt>
                <dd className="text-right">
                  {course.metadata.gradeBands.length
                    ? course.metadata.gradeBands.join('、')
                    : '暂未设置'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">作者</dt>
                <dd className="text-right">{course.metadata.author || '暂未标注'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">许可</dt>
                <dd className="text-right">{course.metadata.license || '仅限本机使用'}</dd>
              </div>
            </dl>
            {course.metadata.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {course.metadata.tags.map((item) => (
                  <Badge key={item} variant="outline">
                    {item}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </aside>
      </section>

      <MetaEditor course={course} open={editingMeta} onOpenChange={setEditingMeta} onSaved={load} />
    </div>
  );
}
