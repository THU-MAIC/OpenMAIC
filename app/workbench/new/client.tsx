'use client';

/**
 * Compatibility bridge for launch links shipped before the workspace composer
 * started creating sessions in place. This route intentionally has no second
 * composer: it consumes the legacy intent once, creates the session, and
 * replaces itself with the canonical workspace URL.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  createWorkbenchSession,
  WorkbenchApiError,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';
import type { CourseRef } from '@/lib/workbench/course-refs';
import { workspaceHref } from '@/lib/workbench/workspace-panes';
import { useI18n } from '@/lib/hooks/use-i18n';

// Older deployed home composers may still write this key during a rolling deploy.
const LEGACY_LAUNCH_HANDOFF_KEY = 'workbench.launchPrompt';

interface LegacyLaunchIntent {
  readonly prompt: string;
  readonly skill?: string;
  readonly materials?: WorkbenchMaterial[];
  readonly courseRefs?: CourseRef[];
}

function parseLegacyHandoff(raw: string): LegacyLaunchIntent {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as LegacyLaunchIntent & { v?: number };
      if (parsed?.v === 1 && typeof parsed.prompt === 'string') return parsed;
    } catch {
      // Old plain-string handoffs are handled below.
    }
  }
  return { prompt: trimmed };
}

export function WorkbenchLaunchBridge() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const launched = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [skillOverride, setSkillOverride] = useState<string | null | undefined>(undefined);
  const intent = useMemo<LegacyLaunchIntent | null>(() => {
    const prompt = searchParams.get('prompt')?.trim();
    if (prompt) {
      const skill = searchParams.get('skill')?.trim();
      return { prompt, ...(skill ? { skill } : {}) };
    }
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(LEGACY_LAUNCH_HANDOFF_KEY);
      return raw?.trim() ? parseLegacyHandoff(raw) : null;
    } catch {
      return null;
    }
  }, [searchParams]);
  const skill = skillOverride === undefined ? intent?.skill : (skillOverride ?? undefined);

  useEffect(() => {
    const launchKey = `${attempt}:${skill ?? ''}`;
    if (launched.current === launchKey) return;
    launched.current = launchKey;
    if (!intent?.prompt.trim()) {
      router.replace('/workspace');
      return;
    }
    createWorkbenchSession({
      prompt: intent.prompt.trim(),
      ...(skill ? { skill } : {}),
      ...(intent.materials?.length ? { materials: intent.materials } : {}),
      ...(intent.courseRefs?.length ? { courseRefs: intent.courseRefs } : {}),
    })
      .then((session) => {
        if (session.courseRefsAccepted === false) {
          toast.warning(t('workspace.courseMention.notAccepted'));
        }
        try {
          window.sessionStorage.removeItem(LEGACY_LAUNCH_HANDOFF_KEY);
        } catch {
          // The session exists; a denied cleanup does not invalidate it.
        }
        router.replace(workspaceHref({ sessionId: session.id, courseId: null }));
      })
      .catch((cause: unknown) => {
        if (
          skill &&
          cause instanceof WorkbenchApiError &&
          cause.status === 400 &&
          /unknown skill/i.test(cause.message)
        ) {
          toast.error(t('workbench.launch.unknownSkill'));
          setSkillOverride(null);
          setAttempt((current) => current + 1);
          return;
        }
        setError(cause instanceof Error ? cause.message : t('workbench.launch.createFailed'));
      });
  }, [attempt, intent, router, skill, t]);

  if (error) {
    return (
      <main className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          onClick={() => {
            setError(null);
            setAttempt((current) => current + 1);
          }}
        >
          {t('common.retry')}
        </button>
        <a className="text-sm font-medium text-primary underline" href="/workspace">
          {t('workbench.common.backToWorkspace')}
        </a>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background">
      <Loader2
        className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
        aria-label={t('workbench.common.loading')}
      />
    </main>
  );
}
