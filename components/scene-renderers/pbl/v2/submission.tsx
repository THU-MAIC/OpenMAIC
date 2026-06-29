'use client';

/**
 * PBL v2 — Submission side panel.
 *
 * Right column of the Workspace. Shows the current microtask's
 * description + hints, plus the submission flow (paste text or
 * upload a small file). Existing submissions for the task are
 * listed so the learner can see what they have already submitted.
 *
 * Architecture note (intentional difference from the v1 Python repo):
 *   v2 is client-truth — the project lives in the Stage store, and
 *   the PBL routes are stateless. So submission goes through
 *   `addSubmission` directly on a project clone, and we publish via
 *   `onProjectChange`. NO server route. The submission rides along
 *   on the next `/api/pbl/v2/instructor` or `/api/pbl/v2/evaluate`
 *   POST body (the route reads from the project parameter).
 *
 *   Trade-off: a learner could lose a draft if they close the tab
 *   before publishing. We mitigate by writing to project state on
 *   every "Submit" click — once it's in the Stage store it's
 *   persisted to IndexedDB by the OpenMAIC stage layer. The Modal's
 *   in-progress text remains in component state and is intentionally
 *   ephemeral.
 *
 *   File handling: we read the file via `file.text()` (small text
 *   files only) per the 5MB cap. Binary parsing (PDF, image OCR) is
 *   explicitly out of scope per the PR 6 D2-A decision.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Paperclip,
  Upload,
  X,
} from 'lucide-react';

import { addSubmission, listSubmissionsForMicrotask } from '@/lib/pbl/v2/operations/submission';
import {
  TEXT_PDF_IMAGE_ACCEPT,
  isImageFile,
  isPdfFile,
  isValidTextFile,
} from '@/lib/pbl/v2/operations/file-validation';
import { uploadBlobToStorage } from '@/lib/storage/client';
import type {
  PBLChatMessage,
  PBLEvaluation,
  PBLProjectV2,
  PBLSubmission,
} from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';
import { applyInstructorEvent } from './apply-instructor-event';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { normalizeProjectRuntime } from '@/lib/pbl/v2/operations/progress';
import { trackSubmissionScore } from '@/lib/pbl/v2/operations/dynamic-signals';
import {
  appendTaskCompletionReadyMessage,
  recordPendingTaskCompletionEvidence,
  setPendingTaskCompletion,
  TASK_EVAL_PASS_SCORE,
  taskEvaluationCanComplete,
} from '@/lib/pbl/v2/operations/task-completion';
import { useI18n } from '@/lib/hooks/use-i18n';
import i18n from '@/lib/i18n/config';
import {
  assertNotStreamError,
  isToleratedReactionStreamError,
  type StreamStatus,
} from './use-instructor-stream';

interface Props {
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  /** Notified after a submission is added; the parent decides whether
   *  to auto-trigger task evaluation (PR 6.6). */
  readonly onSubmissionAdded?: (submission: PBLSubmission, microtaskId: string) => void;
  readonly onEvaluationStatusChange?: (status: SubmissionEvaluationStatus | null) => void;
  /** Reports the post-submit evaluation stream's start/end up to a parent that
   *  outlives this panel, so the workspace knows a stream is in flight even
   *  after the learner steps back to the Hero (keeps the "thinking…" indicator
   *  alive across a remount and blocks a reset that would clobber the result).
   *  `onEvaluationStatusChange` is panel-local state and is lost on unmount;
   *  this is not. */
  readonly onInstructorStreamingChange?: (active: boolean) => void;
  /** True while ANY SSE stream is feeding the chat (the instructor's normal
   *  reply, a task evaluation, or a milestone/stage card) — including a stream
   *  started elsewhere. Submitting output during that window would interleave
   *  with the in-flight response and scramble ordering, so submission is locked
   *  while it is true. */
  readonly instructorStreaming?: boolean;
}

/** Submission must be locked while the chat is mid-stream (so a submit can't
 *  interleave with the instructor's in-flight reply / evaluation) and while
 *  this panel's own post-submit evaluation is running (so the learner can't
 *  double-submit). Pure for unit testing. */
export function isSubmitLockedDuringStream(args: {
  instructorStreaming?: boolean;
  evaluating: boolean;
}): boolean {
  return !!args.instructorStreaming || args.evaluating;
}

export interface SubmissionEvaluationStatus {
  readonly microtaskId: string;
  readonly microtaskTitle: string;
  readonly phase: 'evaluating' | 'followup';
  readonly streamStatus?: StreamStatus;
  readonly draft?: string;
  readonly startedAt: string;
}

/** 5 MB cap. Larger than the v1 repo's 1 MB because v2 stores
 *  through IndexedDB which handles bigger blobs fine, and one
 *  good-size code file (500+ lines) can blow past 1 MB easily.
 *  Hard cap; if you raise this, also bump the corresponding
 *  validation copy below so the user sees the right number. */
const FILE_BYTES_CAP = 5 * 1024 * 1024;
// When object storage is unconfigured (e.g. local dev) an image falls back to
// an inline base64 data URL stored on the project. Cap that fallback so a big
// image can't bloat the project JSON / IndexedDB. With storage configured the
// image goes to OSS (a small URL) and this cap doesn't apply.
const IMAGE_BASE64_CAP = 2 * 1024 * 1024;

/** Read a Blob as a base64 data URL (image fallback when OSS is unconfigured). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
const FOLLOWUP_THINKING_MIN_MS = 800;

function parseSSEFrame(frame: string): PBLSSEEvent | null {
  const lines = frame.split('\n');
  let eventName = '';
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLine = line.slice(6);
  }
  if (!eventName || !dataLine) return null;
  try {
    return { type: eventName, ...JSON.parse(dataLine) } as PBLSSEEvent;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function newClientMessageId(): string {
  return 'msg_local_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
}

function submissionReceiptText(submission: PBLSubmission, language?: string): string {
  const lng = language || 'zh-CN';
  const label =
    submission.kind === 'file' && submission.filename
      ? i18n.t('pbl.v2.submission.receiptFile', { lng, filename: submission.filename })
      : i18n.t('pbl.v2.submission.textSubmission', { lng });
  return i18n.t('pbl.v2.submission.receiptTemplate', { lng, label });
}

function appendSubmissionReceiptMessage(
  project: PBLProjectV2,
  submission: PBLSubmission,
): PBLProjectV2 {
  normalizeProjectRuntime(project);
  const instructorId = project.roles.find((r) => r.type === 'instructor')?.id;
  const thread = project.threads.find((t) => t.agentId === instructorId);
  if (!thread) return project;
  const exists = thread.messages.some(
    (m) =>
      m.roleType === 'user' &&
      m.microtaskId === submission.microtaskId &&
      m.ts === submission.createdAt,
  );
  if (exists) return project;
  const message: PBLChatMessage = {
    id: newClientMessageId(),
    roleType: 'user',
    content: submissionReceiptText(submission, project.language),
    ts: submission.createdAt,
    microtaskId: submission.microtaskId,
  };
  thread.messages.push(message);
  project.updatedAt = submission.createdAt;
  return project;
}

function latestTaskEvaluation(
  project: PBLProjectV2,
  microtaskId: string,
): PBLEvaluation | undefined {
  return project.evaluations
    .filter((e) => e.kind === 'task' && e.microtaskId === microtaskId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** An image is graded multimodally only on a vision-capable model. On a
 *  non-vision model the evaluator never sees the picture (it falls back to a
 *  text-only prompt with a placeholder), so a pure-image submission would get
 *  a meaningless score. In that case require a text caption the text-only
 *  evaluator can actually grade. */
export function imageRequiresCaption(args: {
  hasImage: boolean;
  hasVision: boolean;
  hasCaption: boolean;
}): boolean {
  return args.hasImage && !args.hasVision && !args.hasCaption;
}

export function taskEvaluationCanAdvance(evaluation: PBLEvaluation | undefined): boolean {
  return taskEvaluationCanComplete(evaluation);
}

export function buildRevisionGuidanceMessage(args: {
  evaluation: PBLEvaluation;
  instructorId?: string;
  microtaskId: string;
  language?: string;
  revisionAttempt?: number;
}): PBLChatMessage | null {
  if (!args.instructorId) return null;
  const zh = args.language === 'zh-CN' || args.language === 'zh-TW';
  const attempt = Math.max(1, args.revisionAttempt ?? 1);
  const zhOpening =
    attempt <= 1
      ? '这版先别急着往下走。'
      : attempt === 2
        ? '这次还需要再补一轮。'
        : '还需要继续改一下。';
  const enOpening =
    attempt <= 1
      ? "Let's pause here before moving on."
      : attempt === 2
        ? 'This still needs one more revision pass.'
        : 'Please keep revising this before we move on.';
  const content = zh
    ? [
        zhOpening,
        '',
        '先参照上面的任务点评，把最影响下一步的一两处改稳。改好后在右侧重新提交，我再帮你看。',
      ].join('\n')
    : [
        enOpening,
        '',
        "Use the task review above to tighten the one or two points that most affect the next step. Submit the revision on the right, and I'll review it again.",
      ].join('\n');
  return {
    id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
    agentId: args.instructorId,
    roleType: 'instructor',
    content,
    ts: new Date().toISOString(),
    microtaskId: args.microtaskId,
  };
}

export function PBLV2SubmissionPanel({
  project,
  onProjectChange,
  onSubmissionAdded,
  onEvaluationStatusChange,
  onInstructorStreamingChange,
  instructorStreaming,
}: Props) {
  const { t } = useI18n();
  const current = useMemo(() => {
    const ms = project.milestones.find((m) => m.status === 'active');
    if (!ms) return undefined;
    const task = ms.microtasks.find((t) => t.status === 'todo' || t.status === 'in_progress');
    if (!task) return undefined;
    return { milestone: ms, task };
  }, [project.milestones]);

  const existing = useMemo(
    () => (current ? listSubmissionsForMicrotask(project, current.task.id) : []),
    [project, current],
  );

  // ACT MODEL: under a roleplay act the right panel shows the WHOLE act, not a
  // single beat — title = act title, brief = the beats' learnerBriefs merged
  // (what + why for everything this act covers, no answers), hints = all beats'
  // hints. The learner sees everything the act asks of them up front, but is
  // never auto-advanced between beats. Non-roleplay tasks keep single-task display.
  const display = useMemo(() => {
    if (!current) return undefined;
    const { milestone, task } = current;
    if (milestone.scenarioStage !== 'roleplay') {
      return {
        title: task.title,
        brief: task.learnerBrief || task.description || '',
        hints: task.hints ?? [],
      };
    }
    const beats = milestone.microtasks;
    const brief = beats
      .map((b) => b.learnerBrief || b.description || '')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
    const hints = beats.flatMap((b) => b.hints ?? []).filter(Boolean);
    return { title: milestone.title, brief, hints };
  }, [current]);

  // Project-wide submission history (all tasks/stages), newest first, so a
  // learner can always see — and re-open — every output they have produced,
  // even after advancing to later tasks or during a stage handover. This is
  // display only; task evaluation still reads the latest submission via
  // summarizeLatestSubmissionForMicrotask on the server, untouched here.
  const allSubmissions = useMemo(
    () => project.submissions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [project.submissions],
  );
  const taskTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ms of project.milestones) {
      for (const mt of ms.microtasks) map.set(mt.id, mt.title);
    }
    return map;
  }, [project.milestones]);

  const [modalOpen, setModalOpen] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [viewer, setViewer] = useState<PBLSubmission | null>(null);
  // Lock submitting while any stream is feeding the chat (instructor reply /
  // task eval / stage card) or this panel's own eval is running.
  const submitLocked = isSubmitLockedDuringStream({ instructorStreaming, evaluating });
  // Surfaced when the post-submit evaluation stream fails (HTTP non-2xx /
  // no body / SSE error), so the learner isn't left with a silent "已提交"
  // and no evaluation, guidance or progress.
  const [evalError, setEvalError] = useState<string | null>(null);

  // Download the original uploaded file. Non-text uploads (PDF) keep the
  // original at `fileUrl` (object storage) — download straight from there.
  // Text uploads store their full text in `content`, so a Blob from
  // content + filename + mimeType is a byte-faithful copy.
  const downloadSubmission = useCallback((s: PBLSubmission) => {
    if (typeof window === 'undefined') return;
    if (s.fileUrl) {
      const a = document.createElement('a');
      a.href = s.fileUrl;
      a.download = s.filename || 'submission';
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    // No stored original → `content` holds TEXT (raw text for text uploads, or
    // a PDF's parsed text). Always download as plain text so we never emit a
    // corrupt binary (e.g. a `.pdf` whose bytes are actually extracted text).
    const textLike =
      !s.mimeType ||
      s.mimeType.startsWith('text/') ||
      s.mimeType === 'application/json' ||
      s.mimeType === 'application/xml';
    const name = textLike
      ? s.filename || 'submission.txt'
      : `${(s.filename || 'submission').replace(/\.[^.]+$/, '')}.txt`;
    const blob = new Blob([s.content ?? ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const runImmediateTaskEval = async (
    snapshot: PBLProjectV2,
    milestoneId: string,
    microtaskId: string,
    microtaskTitle: string,
  ) => {
    setEvaluating(true);
    onInstructorStreamingChange?.(true);
    setEvalError(null);
    const statusStartedAt = new Date().toISOString();
    const setEvaluationStatus = (patch: Partial<SubmissionEvaluationStatus>) => {
      onEvaluationStatusChange?.({
        microtaskId,
        microtaskTitle,
        phase: 'evaluating',
        streamStatus: 'eval-task',
        draft: '',
        startedAt: statusStartedAt,
        ...patch,
      });
    };

    setEvaluationStatus({
      microtaskId,
      microtaskTitle,
      phase: 'evaluating',
      streamStatus: 'eval-task',
      draft: '',
      startedAt: new Date().toISOString(),
    });
    let workingProject = structuredClone(snapshot);
    try {
      const modelConfig = getCurrentModelConfig();
      const runStream = async (
        endpoint: string,
        body: Record<string, unknown>,
        streamStatus: StreamStatus,
        onPatch?: (patch: Extract<PBLSSEEvent, { type: 'project_patch' }>['patch']) => void,
      ) => {
        let draft = '';
        setEvaluationStatus({
          phase: streamStatus === 'instructor' ? 'followup' : 'evaluating',
          streamStatus,
          draft,
        });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-model': modelConfig.modelString || '',
          'x-api-key': modelConfig.apiKey || '',
        };
        if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
        if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;
        try {
          const stored = localStorage.getItem('locale');
          if (stored) headers['x-user-locale'] = stored;
        } catch {
          /* noop */
        }
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.body) throw new Error('Response has no readable body.');
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const parsed = parseSSEFrame(frame);
            if (!parsed) continue;
            // #593: the chained post-evaluation instructor reaction is best-effort.
            // A soft EMPTY_LLM_OUTPUT there means "no wrap-up", not a failed
            // evaluation — the task eval already succeeded and is recorded. Skip
            // it; real failures and any error on the eval streams still abort.
            if (isToleratedReactionStreamError(streamStatus, parsed)) continue;
            assertNotStreamError(parsed);
            if (parsed.type === 'project_patch') onPatch?.(parsed.patch);
            workingProject = applyInstructorEvent(parsed, workingProject, (fn) => {
              draft = streamStatus === 'eval-task' ? '' : fn(draft);
              setEvaluationStatus({
                phase: streamStatus === 'instructor' ? 'followup' : 'evaluating',
                streamStatus,
                draft,
              });
            });
            if (parsed.type === 'project_patch') {
              onProjectChange(workingProject);
            }
          }
        }
      };
      await runStream(
        '/api/pbl/v2/evaluate',
        {
          project: workingProject,
          kind: 'task',
          milestoneId,
          microtaskId,
        },
        'eval-task',
      );
      onProjectChange(workingProject);
      const evaluation = latestTaskEvaluation(workingProject, microtaskId);
      if (!evaluation) return;
      // The evaluation patch above has already been published to React. Clone
      // before adding the ready state so the next onProjectChange uses a fresh
      // object reference; otherwise React may skip rendering the completion
      // prompt/sidebar button until a later refresh.
      workingProject = structuredClone(workingProject);
      if (typeof evaluation.score === 'number') {
        trackSubmissionScore(workingProject, evaluation.score);
      }
      onEvaluationStatusChange?.({
        microtaskId,
        microtaskTitle,
        phase: 'followup',
        startedAt: new Date().toISOString(),
      });
      if (taskEvaluationCanAdvance(evaluation)) {
        const milestone = workingProject.milestones.find((m) => m.id === milestoneId);
        const microtask = milestone?.microtasks.find((t) => t.id === microtaskId);
        if (milestone && microtask) {
          const reason =
            typeof evaluation.score === 'number'
              ? `Latest task submission passed evaluation (${evaluation.score}/100).`
              : 'Latest task submission passed evaluation.';
          const evidence = {
            path: 'submission_passed' as const,
            signature: `submission_passed_${microtask.id}`,
            label: microtask.title,
            note: reason,
          };
          recordPendingTaskCompletionEvidence(workingProject, milestone, microtask, evidence);
          setPendingTaskCompletion(workingProject, {
            microtaskId,
            milestoneId,
            reason,
            assessment: {
              problems: '',
              resolution: 'submission evaluation passed',
              performance: 'submission met the task threshold',
            },
            evidence,
          });
          appendTaskCompletionReadyMessage(workingProject, microtaskId, {
            afterTs: evaluation.createdAt,
          });
        }
        onProjectChange(workingProject);
        return;
      }
      await delay(FOLLOWUP_THINKING_MIN_MS);
      const guidanceProject = structuredClone(workingProject);
      normalizeProjectRuntime(guidanceProject);
      const instructorId = guidanceProject.roles.find((r) => r.type === 'instructor')?.id;
      const revisionAttempt = guidanceProject.evaluations.filter(
        (e) =>
          e.kind === 'task' &&
          e.microtaskId === microtaskId &&
          typeof e.score === 'number' &&
          e.score < TASK_EVAL_PASS_SCORE,
      ).length;
      const guidance = buildRevisionGuidanceMessage({
        evaluation,
        instructorId,
        microtaskId,
        language: guidanceProject.language,
        revisionAttempt,
      });
      if (!guidance) return;
      const thread = guidanceProject.threads.find((t) => t.agentId === instructorId);
      if (thread && !thread.messages.some((m) => m.id === guidance.id)) {
        thread.messages.push(guidance);
        guidanceProject.updatedAt = guidance.ts;
        workingProject = guidanceProject;
        onProjectChange(guidanceProject);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[PBL v2] task evaluation failed:', msg);
      setEvalError(msg);
    } finally {
      setEvaluating(false);
      onInstructorStreamingChange?.(false);
      onEvaluationStatusChange?.(null);
    }
  };

  return (
    <aside className="pbl-v2-scroll-fade h-full space-y-4 overflow-y-auto p-4">
      {current ? (
        <>
          <div className="rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.46] p-4 shadow-[0_12px_30px_rgba(6,16,34,0.20)]">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('pbl.v2.submission.currentTask')}
            </div>
            <h3 className="text-sm font-semibold text-white">
              {display?.title ?? current.task.title}
            </h3>
            {/* SCENARIO: prefer the learner-facing brief (what + why, no answer)
                over the raw `description` (which doubles as the character's
                established-fact source and may read as a bare action). Under a
                roleplay act this is the merged whole-act brief. Falls back to
                `description` for ordinary projects / older scenarios. */}
            {display?.brief && (
              <p className="text-xs text-muted-foreground mt-1.5 whitespace-pre-wrap">
                {display.brief}
              </p>
            )}
          </div>

          {display && display.hints.length > 0 && (
            <div className="rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.40] p-4">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-cyan-200/80 mb-2">
                <Lightbulb className="w-3 h-3" />
                {t('pbl.v2.submission.hints')}
              </div>
              <ul className="space-y-1.5 text-xs text-foreground/80">
                {display.hints.map((hint, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">{i + 1}.</span>
                    <span>{hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.46] p-3">
            <button
              type="button"
              onClick={() => {
                if (!submitLocked) setModalOpen(true);
              }}
              disabled={submitLocked}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary px-3 py-2 text-xs font-medium text-primary-foreground shadow-[0_0_28px_rgba(155,124,255,0.26)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {t('pbl.v2.submission.submitOutput')}
            </button>
            {evaluating ? (
              <div className="mt-2 text-[10px] text-muted-foreground text-center">
                {t('pbl.v2.submission.evaluating')}
              </div>
            ) : (
              instructorStreaming && (
                <div className="mt-2 text-[10px] text-muted-foreground text-center">
                  {t('pbl.v2.submission.lockedWhileStreaming')}
                </div>
              )
            )}
            {existing.length > 0 && (
              <div className="mt-3 text-[10px] text-muted-foreground text-center">
                {t('pbl.v2.submission.submittedCount', { count: existing.length })}
              </div>
            )}
            {evalError && (
              <div
                role="alert"
                className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] leading-snug text-destructive"
              >
                {t('pbl.v2.submission.evalFailed', { error: evalError })}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.40] p-4 text-xs text-muted-foreground">
          {t('pbl.v2.submission.noActiveTask')}
        </div>
      )}

      {allSubmissions.length > 0 && (
        <SubmissionHistory
          submissions={allSubmissions}
          taskTitleById={taskTitleById}
          onView={(s) => setViewer(s)}
          onDownload={downloadSubmission}
        />
      )}

      {modalOpen && current && (
        <SubmissionModal
          project={project}
          microtaskId={current.task.id}
          milestoneId={current.milestone.id}
          microtaskTitle={current.task.title}
          existing={existing}
          submitLocked={submitLocked}
          onClose={() => setModalOpen(false)}
          onSubmit={(args) => {
            // Apply the submission to a clone so React picks up the
            // change; addSubmission mutates the project, so we clone
            // first to keep render semantics clean.
            const next = structuredClone(project);
            const sub = addSubmission(next, args);
            appendSubmissionReceiptMessage(next, sub);
            onProjectChange(next);
            onSubmissionAdded?.(sub, args.microtaskId);
            setModalOpen(false);
            void runImmediateTaskEval(next, args.milestoneId, args.microtaskId, current.task.title);
          }}
        />
      )}

      {viewer && (
        <SubmissionViewer
          submission={viewer}
          onClose={() => setViewer(null)}
          onDownload={downloadSubmission}
        />
      )}
    </aside>
  );
}

function SubmissionHistory({
  submissions,
  taskTitleById,
  onView,
  onDownload,
}: {
  readonly submissions: PBLSubmission[];
  readonly taskTitleById: Map<string, string>;
  readonly onView: (s: PBLSubmission) => void;
  readonly onDownload: (s: PBLSubmission) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-cyan-100/[0.12] bg-slate-800/[0.38] p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        {t('pbl.v2.submission.submissionHistory')}
      </div>
      <ul className="space-y-1.5">
        {submissions.map((s) => {
          const isFile = s.kind === 'file';
          const isImageSub = s.mimeType?.startsWith('image/') ?? false;
          // Images and text are "viewed" (preview); other files (PDF, text
          // files) are downloaded.
          const viewable = isImageSub || !isFile;
          const taskTitle = taskTitleById.get(s.microtaskId);
          const label = isFile && s.filename ? s.filename : t('pbl.v2.submission.textSubmission');
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => (viewable ? onView(s) : onDownload(s))}
                title={
                  viewable ? t('pbl.v2.submission.viewSubmission') : t('pbl.v2.submission.download')
                }
                className="w-full rounded-lg border border-cyan-100/[0.12] bg-slate-700/[0.32] px-2.5 py-1.5 text-left text-[11px] leading-snug text-foreground/80 transition-colors hover:bg-slate-700/[0.46] focus:outline-none focus:ring-1 focus:ring-primary/40"
              >
                <div className="flex items-center gap-1.5">
                  {isImageSub ? (
                    <ImageIcon className="w-3 h-3 shrink-0 text-muted-foreground" />
                  ) : isFile ? (
                    <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  {viewable ? (
                    <Eye className="w-3 h-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <Download className="w-3 h-3 shrink-0 text-muted-foreground" />
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/75">
                  {taskTitle && (
                    <span className="min-w-0 truncate">
                      {t('pbl.v2.submission.fromTask', { title: taskTitle })}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SubmissionViewer({
  submission,
  onClose,
  onDownload,
}: {
  readonly submission: PBLSubmission;
  readonly onClose: () => void;
  readonly onDownload: (s: PBLSubmission) => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const title =
    submission.kind === 'file' && submission.filename
      ? submission.filename
      : t('pbl.v2.submission.textSubmission');
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/48 p-4 backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-cyan-100/[0.14] bg-background shadow-[0_24px_70px_rgba(6,16,34,0.42)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('pbl.v2.submission.viewSubmission')}
      >
        <div className="flex items-center justify-between gap-3 border-b border-cyan-100/[0.12] px-5 py-4">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold leading-tight">{title}</h3>
          <button
            type="button"
            onClick={() => onDownload(submission)}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label={t('pbl.v2.submission.download')}
            title={t('pbl.v2.submission.download')}
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 -m-1"
            aria-label={t('pbl.v2.hero.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="pbl-v2-scroll-fade flex-1 overflow-y-auto px-5 py-4">
          {submission.mimeType?.startsWith('image/') && submission.fileUrl ? (
            <div className="space-y-3">
              <img
                src={submission.fileUrl}
                alt={submission.filename || 'submission'}
                className="mx-auto max-h-[60vh] rounded-lg border border-cyan-100/[0.14] object-contain"
              />
              {submission.content?.trim() && (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
                  {submission.content}
                </pre>
              )}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
              {submission.content ?? ''}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

interface SubmissionModalProps {
  project: PBLProjectV2;
  microtaskId: string;
  milestoneId: string;
  microtaskTitle: string;
  existing: PBLSubmission[];
  /** True when a chat stream started while the modal is open — block submit so
   *  it can't interleave with the instructor's in-flight response. */
  submitLocked?: boolean;
  onClose: () => void;
  onSubmit: (args: {
    microtaskId: string;
    milestoneId: string;
    kind: 'text' | 'file';
    content: string;
    filename?: string;
    mimeType?: string;
    fileUrl?: string;
  }) => void;
}

function SubmissionModal({
  project: _project,
  microtaskId,
  milestoneId,
  microtaskTitle,
  existing,
  submitLocked,
  onClose,
  onSubmit,
}: SubmissionModalProps) {
  const { t } = useI18n();
  // Whether the currently-selected model can read images. Reactive so that
  // switching models (in Settings) updates the image-caption gating live.
  const hasVision = useSettingsStore((s) => {
    const model = s.providersConfig[s.providerId]?.models.find((m) => m.id === s.modelId);
    return !!model?.capabilities?.vision;
  });
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [mimeType, setMimeType] = useState('');
  const [fileUrl, setFileUrl] = useState<string | undefined>(undefined);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Aborts the in-flight file parse / upload so it doesn't keep running in the
  // background after the modal is closed (which would otherwise occupy the
  // (serialized) parse backend and stall the next upload).
  const abortRef = useRef<AbortController | null>(null);
  // Tracks whether the current `text` came from a file (text upload / parsed
  // PDF) rather than being a caption the learner typed. Lets us clear stale
  // file-derived text when a new file is selected while preserving a typed
  // image caption.
  const textFromFileRef = useRef(false);

  // Confirm before discarding an in-flight parse/upload, then actually abort it.
  const handleClose = useCallback(() => {
    if (parsing || uploading) {
      if (!window.confirm(t('pbl.v2.submission.cancelProcessingConfirm'))) return;
      abortRef.current?.abort();
    }
    onClose();
  }, [parsing, uploading, onClose, t]);

  // Focus the textarea on mount so the learner can start typing
  // immediately. Skipping focus when they're in file mode (the file
  // picker is the natural first action there).
  useEffect(() => {
    if (mode === 'paste') {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Abort any in-flight parse/upload when the modal unmounts so it never
  // continues in the background after close.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Esc-to-close as a soft affordance. Click-outside is handled by
  // the backdrop's onClick (with stopPropagation on the modal body).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  // Drop the previously-selected attachment so a rejected or failed
  // replacement (oversize / unsupported / parse / upload error) can never
  // leave the prior file silently staged for submit. A caption the learner
  // typed by hand is kept; only file-derived text is cleared.
  const resetAttachment = () => {
    setFileUrl(undefined);
    setFilename('');
    setMimeType('');
    if (textFromFileRef.current) {
      setText('');
      textFromFileRef.current = false;
    }
  };

  const handleFile = async (file: File) => {
    setError(null);
    resetAttachment();
    if (file.size > FILE_BYTES_CAP) {
      setError(t('pbl.v2.submission.fileTooLarge'));
      return;
    }
    // Cancel any prior in-flight parse/upload, then scope this run to a fresh
    // controller so closing the modal (or starting a replacement) can abort it.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Image / screenshot: store via OpenMAIC's existing object storage
    // (reused, not modified); fall back to an inline base64 data URL only when
    // storage is unconfigured (capped to avoid bloating the project). The image
    // itself is the submission and is fed to a vision-capable evaluator.
    if (isImageFile(file)) {
      setUploading(true);
      try {
        let src = await uploadBlobToStorage(file, 'media', ac.signal);
        if (ac.signal.aborted) return;
        if (!src) {
          if (file.size > IMAGE_BASE64_CAP) {
            setError(t('pbl.v2.submission.imageTooLargeNoStorage'));
            return;
          }
          src = await blobToDataUrl(file);
          if (ac.signal.aborted) return;
        }
        setFileUrl(src);
        setFilename(file.name);
        setMimeType(file.type || 'image/png');
        // Keep any caption the learner already typed (don't clobber it).
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(
          t('pbl.v2.submission.imageUploadFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        if (!ac.signal.aborted) setUploading(false);
      }
      return;
    }
    // PDF: parse to text via OpenMAIC's existing /api/parse-pdf (reused, not
    // modified), so the parsed text flows through the unchanged text-based
    // evaluator. The original PDF is kept at `fileUrl` (object storage,
    // best-effort) for download/view.
    if (isPdfFile(file)) {
      setParsing(true);
      try {
        const fd = new FormData();
        fd.append('pdf', file);
        const res = await fetch('/api/parse-pdf', { method: 'POST', body: fd, signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (ac.signal.aborted) return;
        const parsed: string =
          json?.data?.markdown ?? json?.data?.text ?? json?.markdown ?? json?.text ?? '';
        if (!parsed.trim()) {
          setError(t('pbl.v2.submission.pdfNoText'));
          return;
        }
        setText(parsed);
        textFromFileRef.current = true;
        setFilename(file.name);
        setMimeType('application/pdf');
        const url = await uploadBlobToStorage(file, 'media', ac.signal);
        if (ac.signal.aborted) return;
        setFileUrl(url ?? undefined);
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(
          t('pbl.v2.submission.parsePdfFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        if (!ac.signal.aborted) setParsing(false);
      }
      return;
    }
    if (!isValidTextFile(file)) {
      setError(t('pbl.v2.submission.unsupportedFileType'));
      return;
    }
    try {
      const content = await file.text();
      setText(content);
      textFromFileRef.current = true;
      setFilename(file.name);
      setMimeType(file.type || '');
      setFileUrl(undefined);
    } catch (e) {
      setError(
        t('pbl.v2.submission.readFileFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  // Paste a screenshot / image straight from the clipboard.
  const handlePaste = (e: React.ClipboardEvent) => {
    if (parsing || uploading) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          // Stay in the current tab — the pasted image shows as a thumbnail
          // chip and any typed text becomes its caption.
          void handleFile(file);
        }
        return;
      }
    }
  };

  // An image submission is the picture itself; the textarea is an optional
  // caption, so it may be submitted with no text.
  const hasImage = !!fileUrl && mimeType.startsWith('image/');
  // On a non-vision model the evaluator can't see the picture, so a pure-image
  // submission needs a text caption to grade against.
  const captionRequired = imageRequiresCaption({
    hasImage,
    hasVision,
    hasCaption: !!text.trim(),
  });

  const clearImage = () => {
    setFileUrl(undefined);
    setFilename('');
    setMimeType('');
    setError(null);
  };

  const handleSubmit = () => {
    if (!text.trim() && !hasImage) {
      setError(t('pbl.v2.submission.contentRequired'));
      return;
    }
    if (captionRequired) {
      setError(t('pbl.v2.submission.imageNeedsCaptionNoVision'));
      return;
    }
    setBusy(true);
    setError(null);
    // addSubmission is synchronous; the only "async-ish" thing here
    // is the upstream onProjectChange + downstream evaluator
    // invocation (in PR 6.6). Wrapping in a microtask ensures the
    // disabled button state is rendered before we re-enter.
    queueMicrotask(() => {
      try {
        onSubmit({
          microtaskId,
          milestoneId,
          kind: fileUrl || mode === 'file' ? 'file' : 'text',
          content: text,
          filename: filename || undefined,
          mimeType: mimeType || undefined,
          fileUrl: fileUrl || undefined,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    });
  };

  return (
    <div
      onClick={handleClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/48 p-4 backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-cyan-100/[0.14] bg-background shadow-[0_24px_70px_rgba(6,16,34,0.42)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('pbl.v2.submission.submitOutput')}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-cyan-100/[0.12] px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-tight">
              {t('pbl.v2.submission.modalTitle')}
            </h3>
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {t('pbl.v2.submission.modalTaskLabel', { title: microtaskTitle })}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground p-1 -m-1"
            aria-label={t('pbl.v2.hero.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div
          className="pbl-v2-scroll-fade flex-1 overflow-y-auto px-5 py-4 space-y-3"
          onPaste={handlePaste}
        >
          {/* Mode toggle */}
          <div className="inline-flex rounded-full border border-cyan-100/[0.12] bg-slate-700/[0.26] p-1">
            {(['paste', 'file'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-4 py-1.5 text-xs font-medium rounded-full transition-colors ${
                  mode === m
                    ? 'bg-primary/90 shadow-sm text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                type="button"
              >
                {m === 'paste' ? t('pbl.v2.submission.pasteTab') : t('pbl.v2.submission.uploadTab')}
              </button>
            ))}
          </div>

          {mode === 'file' && (
            <label className="block cursor-pointer rounded-xl border border-dashed border-cyan-100/[0.14] bg-slate-700/[0.24] px-4 py-4 text-center text-xs text-muted-foreground transition-colors hover:bg-slate-700/[0.34]">
              <input
                type="file"
                accept={TEXT_PDF_IMAGE_ACCEPT}
                className="hidden"
                disabled={parsing || uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              {parsing ? (
                <span className="text-foreground">{t('pbl.v2.submission.parsingPdf')}</span>
              ) : uploading ? (
                <span className="text-foreground">{t('pbl.v2.submission.processing')}</span>
              ) : hasImage ? (
                <span className="text-foreground">
                  {t('pbl.v2.submission.imageSelectedReplace')}
                </span>
              ) : filename ? (
                <span className="text-foreground">
                  {t('pbl.v2.submission.fileRead', {
                    filename,
                    size: (text.length / 1024).toFixed(1),
                  })}
                </span>
              ) : (
                <span>{t('pbl.v2.submission.selectFileHint')}</span>
              )}
            </label>
          )}

          {hasImage && (
            <div className="flex items-center gap-2.5 rounded-xl border border-cyan-100/[0.14] bg-slate-700/[0.24] p-2">
              <img
                src={fileUrl}
                alt={filename}
                className="h-14 w-14 shrink-0 rounded-md border border-cyan-100/[0.14] object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{filename}</span>
              <button
                type="button"
                onClick={clearImage}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-slate-700/[0.4] hover:text-foreground"
                aria-label={t('pbl.v2.submission.removeImage')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {captionRequired && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-snug text-amber-200/90">
              {t('pbl.v2.submission.imageNeedsCaptionNoVision')}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              textFromFileRef.current = false;
            }}
            rows={mode === 'file' ? 8 : 10}
            placeholder={
              hasImage
                ? t('pbl.v2.submission.imageCaptionPlaceholder')
                : mode === 'file'
                  ? t('pbl.v2.submission.uploadPlaceholder')
                  : t('pbl.v2.submission.pastePlaceholder')
            }
            className={`w-full resize-y rounded-xl border border-cyan-100/[0.13] bg-slate-950/[0.26] p-3 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/35 ${
              mode === 'paste' ? 'font-mono' : ''
            }`}
          />

          {error && (
            <div
              role="alert"
              className="text-xs px-3 py-2 rounded-md bg-destructive/10 text-destructive border border-destructive/30"
            >
              {error}
            </div>
          )}

          {existing.length > 0 && (
            <div className="pt-3 border-t">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                {t('pbl.v2.submission.submittedBadge', { count: existing.length })}
              </div>
              <ul className="space-y-2">
                {existing
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((s) => (
                    <li
                      key={s.id}
                      className="rounded-lg border border-cyan-100/[0.12] bg-slate-700/[0.32] px-2.5 py-2 text-[11px] leading-snug"
                    >
                      <div className="flex items-center gap-1.5">
                        {s.mimeType?.startsWith('image/') ? (
                          <>
                            <ImageIcon className="w-3 h-3 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate font-medium">
                              {s.filename || t('pbl.v2.submission.textSubmission')}
                            </span>
                          </>
                        ) : s.kind === 'file' && s.filename ? (
                          <>
                            <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate font-medium">{s.filename}</span>
                          </>
                        ) : (
                          <>
                            <FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
                            <span className="font-medium">
                              {t('pbl.v2.submission.textSubmission')}
                            </span>
                          </>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {(s.content ?? '').trim() && (
                        <p className="mt-1 text-muted-foreground/90 line-clamp-2">
                          {(s.content ?? '').slice(0, 200)}
                          {(s.content ?? '').length > 200 ? '…' : ''}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-cyan-100/[0.12] bg-slate-700/[0.22] px-5 py-3">
          {submitLocked && (
            <span className="mr-auto text-[11px] leading-snug text-muted-foreground">
              {t('pbl.v2.submission.lockedWhileStreaming')}
            </span>
          )}
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-cyan-100/[0.12] bg-slate-700/[0.24] px-3 py-1.5 text-xs transition-colors hover:bg-slate-700/[0.34]"
          >
            {t('pbl.v2.submission.canceling')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={
              busy ||
              parsing ||
              uploading ||
              submitLocked ||
              (!text.trim() && !hasImage) ||
              captionRequired
            }
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {busy ? t('pbl.v2.submission.submitting') : t('pbl.v2.submission.submitOutput')}
          </button>
        </div>
      </div>
    </div>
  );
}
