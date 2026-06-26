/**
 * PBL v2 — Submission helpers.
 *
 * Submissions are pieces of learner-produced work (pasted text /
 * uploaded file / link) attached to a microtask. The Instructor
 * reads them when evaluating, and the evaluator includes them in
 * the milestone / final eval prompts.
 *
 * v0 (PR 3): only the helper signatures and minimal append/list
 * behavior. Upload handling lives in the workspace UI (PR 4) and
 * paste-text handling lives in the workspace submission panel.
 */

import type { PBLProjectV2, PBLSubmission, PBLSubmissionKind } from '../types';

function newId(prefix: string): string {
  return (
    prefix + '_' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8)
  );
}

export function addSubmission(
  project: PBLProjectV2,
  args: {
    microtaskId: string;
    milestoneId?: string;
    kind: PBLSubmissionKind;
    content: string;
    filename?: string;
    mimeType?: string;
    fileUrl?: string;
    summary?: string;
  },
): PBLSubmission {
  const sub: PBLSubmission = {
    id: newId('sub'),
    microtaskId: args.microtaskId,
    milestoneId: args.milestoneId,
    kind: args.kind,
    content: args.content,
    filename: args.filename,
    mimeType: args.mimeType,
    fileUrl: args.fileUrl,
    summary: args.summary,
    createdAt: new Date().toISOString(),
  };
  project.submissions.push(sub);
  project.updatedAt = sub.createdAt;
  return sub;
}

export function listSubmissionsForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): PBLSubmission[] {
  return project.submissions.filter((s) => s.microtaskId === microtaskId);
}

export function latestSubmissionForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): PBLSubmission | undefined {
  return listSubmissionsForMicrotask(project, microtaskId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Format only the latest submission for task-level evaluation.
 *
 * Revisions are common: the evaluator should grade the learner's current
 * attempt, not re-score every earlier draft. Older attempts remain available
 * through prior task evaluations and chat memory, but their raw content stays
 * out of the current grading evidence so stale mistakes do not pollute the
 * latest score. */
export function summarizeLatestSubmissionForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
  maxChars = 4000,
): string {
  const sub = latestSubmissionForMicrotask(project, microtaskId);
  if (!sub) return '';

  const headerBits: string[] = [`Latest submission (${sub.kind}`];
  if (sub.filename) headerBits.push(`, ${sub.filename}`);
  headerBits.push(`, ${sub.createdAt})`);
  const header = `\n--- ${headerBits.join('')} ---\n`;
  // Image submissions carry the picture as a multimodal message part (see the
  // evaluator); their text `content` is just an optional caption. Tell the LLM
  // to grade the attached image when there's no caption text.
  const isImage = sub.mimeType?.startsWith('image/') ?? false;
  const content = sub.content?.trim()
    ? sub.content
    : isImage
      ? '(Image submission — grade the attached image.)'
      : (sub.content ?? '');
  const room = Math.max(0, maxChars - header.length);
  const snippet = content.length > room ? content.slice(0, room) : content;
  const truncated = content.length > snippet.length;
  return header + snippet + (truncated ? '\n[...latest submission truncated]' : '');
}

/**
 * Pack every submission for a microtask into a single text block,
 * capped at ``maxChars`` so an enormous file upload can't blow the
 * evaluator prompt over its token budget.
 *
 * Returns the empty string when no submissions exist — the caller
 * (task evaluator) skips the section entirely in that case, which is
 * how the D1-B branch (skip task eval when nothing was submitted)
 * stays clean: even if the prompt builder is invoked with an empty
 * task, the produced prompt simply has no submission section.
 *
 * Concatenation is plain text with a per-submission header so the
 * LLM can tell submissions apart (kind, filename, timestamp). When
 * the budget runs out we append a single ``[...older submissions
 * truncated]`` marker so the LLM doesn't think the truncation is
 * part of the learner's actual output.
 */
export function summarizeSubmissionsForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
  maxChars = 4000,
): string {
  const subs = listSubmissionsForMicrotask(project, microtaskId);
  if (subs.length === 0) return '';

  const parts: string[] = [];
  let remaining = maxChars;
  let truncated = false;
  subs.forEach((s, idx) => {
    if (truncated) return;
    const headerBits: string[] = [`Submission ${idx + 1} (${s.kind}`];
    if (s.filename) headerBits.push(`, ${s.filename}`);
    headerBits.push(`, ${s.createdAt})`);
    const header = `\n--- ${headerBits.join('')} ---\n`;
    const content = s.content ?? '';
    const room = Math.max(0, remaining - header.length);
    if (room <= 0) {
      truncated = true;
      return;
    }
    const snippet = content.length > room ? content.slice(0, room) : content;
    parts.push(header + snippet);
    remaining -= header.length + snippet.length;
    if (content.length > snippet.length) truncated = true;
    if (remaining <= 0) truncated = true;
  });
  if (truncated) parts.push('\n[...older submissions truncated]');
  return parts.join('');
}
