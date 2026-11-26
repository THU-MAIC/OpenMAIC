'use client';

/**
 * The course's issues list — the phase-2 surface of `collectCourseIssues`
 * (RFC #1899 / issue #2329). The list appears in the workspace pane and
 * standalone classroom headers and groups problems by page: the page name is
 * itself a "Go to" button, each issue is a non-interactive text row, and one
 * "Fix with AI" appears per page (and one for the whole course in the header).
 *
 * It shows what the current document says, so an entry disappears the moment
 * its cause is fixed — the same derivation, never bookkeeping. Narration
 * issues whose device-local audio evidence has not been checked yet stay
 * hidden, exactly as the thumbnail marker hides them, so the list never
 * guesses. An interactive page's runtime errors are not listed here: they are
 * reported to the agent by the tool that wrote the page.
 */
import { useMemo, useState } from 'react';
import { CheckCircle, TriangleAlert } from 'lucide-react';
import type { CourseIssue, CourseIssueKind } from '@openmaic/dsl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ctrlBtn } from '@/components/canvas/canvas-toolbar';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseIssues } from '@/lib/edit/use-course-issues';
import { useStageStore } from '@/lib/store/stage';
import { agentFixPageLabel, useAgentFix } from '@/lib/workbench/agent-fix-handoff';
import { cn } from '@/lib/utils';
import { DockBarTip } from './dock-context';

const KIND_LABEL_KEY: Record<CourseIssueKind, string> = {
  'speech-without-audio': 'edit.issues.kind.speechWithoutAudio',
  'media-not-generated': 'edit.issues.kind.mediaNotGenerated',
  'dangling-cue': 'edit.issues.kind.danglingCue',
  'empty-actions': 'edit.issues.kind.emptyActions',
  'empty-speech': 'edit.issues.kind.emptySpeech',
  'unbound-cue': 'edit.issues.kind.unboundCue',
  'empty-discussion': 'edit.issues.kind.emptyDiscussion',
};

export function CourseIssuesButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const scenes = useStageStore((s) => s.scenes);
  const courseId = useStageStore((s) => s.stage?.id);
  const setCurrentSceneId = useStageStore((s) => s.setCurrentSceneId);
  const { handOff } = useAgentFix();
  const collected = useCourseIssues();
  const issues = useMemo(
    () => collected.filter((issue) => issue.evidence !== 'local-audio-unchecked'),
    [collected],
  );
  const hasError = issues.some((issue) => issue.severity === 'error');
  const groups = useMemo(() => {
    const byScene = new Map<string, { sceneId: string; page: string; issues: CourseIssue[] }>();
    for (const [index, scene] of scenes.entries()) {
      byScene.set(scene.id, {
        sceneId: scene.id,
        page: agentFixPageLabel(t, index, scene.title),
        issues: [],
      });
    }
    for (const issue of issues) byScene.get(issue.sceneId)?.issues.push(issue);
    return [...byScene.values()].filter((group) => group.issues.length > 0);
  }, [scenes, issues, t]);
  const fixPage = (pageIssues: CourseIssue[], page: string) => {
    if (!handOff || !courseId) return;
    // Fix the first issue on the page; if there are multiple, the agent can
    // call list_course_issues to find the rest.
    const issue = pageIssues[0]!;
    const kindText = t(KIND_LABEL_KEY[issue.kind]);
    let prefill = t('edit.issues.fixPrefillIssue', { page, issue: kindText });
    const target = issue.actionId ?? issue.elementId;
    if (target) prefill += ` (${target})`;
    handOff({ courseId, prefill });
    setOpen(false);
  };
  const fixCourse = () => {
    if (!handOff || !courseId) return;
    handOff({ courseId, prefill: t('edit.issues.fixPrefillCourse') });
    setOpen(false);
  };
  const fixEnabled = handOff !== null && !!courseId;
  const goTo = (sceneId: string) => {
    setCurrentSceneId(sceneId);
    setOpen(false);
  };
  const count = issues.length;
  const buttonLabel =
    count > 0 ? t('edit.issues.buttonLabelWithCount', { count }) : t('edit.issues.buttonLabel');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <DockBarTip label={buttonLabel}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="edit-course-issues"
            aria-label={buttonLabel}
            className={cn(
              ctrlBtn,
              'relative h-6 w-6',
              count === 0
                ? 'text-gray-400 dark:text-gray-500'
                : hasError
                  ? 'text-red-500 dark:text-red-400'
                  : 'text-amber-500 dark:text-amber-400',
            )}
          >
            <TriangleAlert className="size-3.5" />
            {count > 0 ? (
              <span
                data-testid="edit-course-issues-count"
                data-severity={hasError ? 'error' : 'warning'}
                className={cn(
                  'absolute -right-1.5 -top-1 min-w-3.5 rounded-full px-0.5 text-[9px] leading-[14px] font-semibold text-white',
                  hasError ? 'bg-red-500' : 'bg-amber-500',
                )}
              >
                {count > 9 ? '9+' : count}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
      </DockBarTip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-96 p-0"
        data-testid="course-issues-popover"
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
            {count > 0 ? t('edit.issues.summary', { count }) : t('edit.issues.buttonLabel')}
          </span>
          {count > 0 && fixEnabled ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="course-issues-fix-all"
              onClick={fixCourse}
            >
              {t('edit.issues.fixWithAgent')}
            </Button>
          ) : null}
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-2 py-4 text-xs text-gray-400 dark:text-gray-500">
              <CheckCircle className="size-4" aria-hidden />
              <p>{t('edit.issues.empty')}</p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.sceneId} className="mb-1 last:mb-0">
                {/* Page row: clicking goes to the page. */}
                <div className="flex items-center justify-between gap-1 rounded-md px-1 py-0.5 hover:bg-gray-100/70 dark:hover:bg-gray-800/60">
                  <button
                    type="button"
                    data-testid={`course-issue-goto-${group.sceneId}`}
                    onClick={() => goTo(group.sceneId)}
                    className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    aria-label={t('edit.issues.goToPage', { page: group.page })}
                  >
                    {group.page}
                  </button>
                  {fixEnabled ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`course-issue-fix-page-${group.sceneId}`}
                      onClick={() => fixPage(group.issues, group.page)}
                      aria-label={t('edit.issues.fixPageWithAgent', { page: group.page })}
                    >
                      {t('edit.issues.fixWithAgent')}
                    </Button>
                  ) : null}
                </div>
                {/* Issue rows: non-interactive text lines with severity dot. */}
                {group.issues.map((issue) => (
                  <div
                    key={issue.id}
                    data-testid="course-issue-item"
                    data-kind={issue.kind}
                    data-severity={issue.severity}
                    className="flex items-start gap-2 px-2 py-1"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-1.5 shrink-0 rounded-full',
                        issue.severity === 'error'
                          ? 'bg-red-500'
                          : 'bg-amber-400 dark:bg-amber-500',
                      )}
                    />
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      {t(KIND_LABEL_KEY[issue.kind])}
                    </p>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
