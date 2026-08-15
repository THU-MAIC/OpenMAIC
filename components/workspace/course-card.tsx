'use client';

import Link from 'next/link';
import type { Slide } from '@openmaic/dsl';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Layers3,
  PencilLine,
  Wifi,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { WorkspaceCourse } from '@/lib/workspace';
import { cn } from '@/lib/utils';

function relativeDate(timestamp: number) {
  const delta = Date.now() - timestamp;
  const minutes = Math.floor(delta / 60_000);
  const hours = Math.floor(delta / 3_600_000);
  const days = Math.floor(delta / 86_400_000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp);
}

export function OfflineStatusBadge({
  status,
}: {
  status: WorkspaceCourse['metadata']['offlineStatus'];
}) {
  if (status === 'complete') {
    return (
      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300">
        <CheckCircle2 /> 离线可用
      </Badge>
    );
  }
  if (status === 'partial') {
    return (
      <Badge className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
        <CircleAlert /> 部分需联网
      </Badge>
    );
  }
  if (status === 'network_required') {
    return (
      <Badge variant="outline" className="bg-white/80 dark:bg-black/20">
        <Wifi /> 需要网络
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-white/80 dark:bg-black/20">
      <CircleAlert /> 待检查
    </Badge>
  );
}

export function CourseCover({
  course,
  slide,
  compact = false,
}: {
  course: WorkspaceCourse;
  slide?: Slide;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative aspect-video overflow-hidden bg-gradient-to-br from-violet-100 via-[#f8efff] to-amber-50 dark:from-violet-950 dark:via-[#2b2033] dark:to-[#33271d]',
        compact ? 'rounded-xl' : 'rounded-t-2xl',
      )}
    >
      {slide ? (
        <SlideThumbnail slide={slide} viewportRatio={0.5625} visible />
      ) : (
        <div className="absolute inset-0 flex flex-col justify-between p-5">
          <div className="grid size-10 place-items-center rounded-2xl bg-white/75 text-violet-600 shadow-sm backdrop-blur dark:bg-black/20 dark:text-violet-300">
            <BookOpen className="size-5" />
          </div>
          <div>
            <p className="line-clamp-2 max-w-[86%] text-lg font-semibold leading-snug text-[#382648] dark:text-white">
              {course.metadata.title || course.stage.name}
            </p>
            <p className="mt-1 text-xs text-[#6f5f78] dark:text-white/60">OpenMAIC 互动课程</p>
          </div>
        </div>
      )}
      <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
        <OfflineStatusBadge status={course.metadata.offlineStatus} />
        {course.metadata.kind === 'teacher_variant' && (
          <Badge className="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/70 dark:text-violet-300">
            <PencilLine /> 我的适配版
          </Badge>
        )}
      </div>
    </div>
  );
}

export function CourseCard({ course, slide }: { course: WorkspaceCourse; slide?: Slide }) {
  const title = course.metadata.title || course.stage.name;
  const subject = course.metadata.subject || course.metadata.category || '未分类课程';

  return (
    <article className="group overflow-hidden rounded-2xl border border-white/90 bg-white shadow-sm shadow-violet-100/60 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-violet-100/80 dark:border-white/10 dark:bg-white/[0.045] dark:shadow-none">
      <CourseCover course={course} slide={slide} />
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href={`/courses/${course.stage.id}`}
              className="line-clamp-1 text-[15px] font-semibold tracking-tight hover:text-violet-700 dark:hover:text-violet-300"
            >
              {title}
            </Link>
            <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
              {course.metadata.summary ||
                course.stage.description ||
                '打开课程详情，补充教学目标与适用年级。'}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span className="rounded-full bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            {subject}
          </span>
          <span className="inline-flex items-center gap-1">
            <Layers3 className="size-3" /> {course.sceneCount} 个场景
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" /> {relativeDate(course.stage.updatedAt)}
          </span>
        </div>

        <div className="mt-4 flex gap-2 border-t pt-3 dark:border-white/10">
          <Button asChild variant="outline" className="h-9 flex-1 rounded-xl bg-transparent">
            <Link href={`/courses/${course.stage.id}`}>课程详情</Link>
          </Button>
          <Button asChild className="h-9 flex-1 rounded-xl bg-violet-600 hover:bg-violet-700">
            <Link href={`/classroom/${course.stage.id}`}>
              直接授课 <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}
