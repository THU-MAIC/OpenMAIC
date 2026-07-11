/**
 * PBL v2 — Instructor agent.
 *
 * Drives one Instructor turn end-to-end: builds the system prompt
 * with the current milestone / microtask anchored at the tail
 * (positional recency), streams tokens, processes the three teaching
 * tools (`record_observation`, `adjust_difficulty`), and yields a
 * stream of `PBLSSEEvent` for the SSE route handler.
 *
 * Scope: the Instructor teaches the active task. Completion readiness is
 * owned by the right-side submission/evaluation flow, not by chat.
 */

import { streamText, tool, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';

import { createLogger } from '@/lib/logger';
import { resolveThinkingProviderOptions } from '@/lib/ai/llm';
import { loadPBLV2Prompt } from '../prompts/loader';
import type { ThinkingConfig } from '@/lib/types/provider';
import { tierGuidanceBlock } from './tier-guidance';
import { compressIfNeeded } from './instructor-memory';
import { withThinkingDisabled } from './runtime-thinking';

import type {
  PBLProjectV2,
  PBLMilestone,
  PBLMicrotask,
  PBLRole,
  PBLChatMessage,
  PBLEngagementSummary,
  PBLProficiency,
} from '../types';
import type { PBLSSEEvent } from '../api/sse';
import { RecordObservationArgs, AdjustDifficultyArgs } from '../operations/schemas';
import {
  recordEvent,
  microtaskEngagement,
  milestoneSynthesisSatisfied,
} from '../operations/engagement';
import {
  currentMicrotask,
  advanceMicrotask as advanceMicrotaskOp,
  normalizeProjectRuntime,
} from '../operations/progress';
import { summarizeLatestSubmissionForMicrotask } from '../operations/submission';
import {
  applyProficiencyDirective,
  tickTurnOnProject,
  trackObservation,
} from '../operations/dynamic-signals';
import { DEFAULT_TIER, proficiencyDirectiveFromTarget } from '../operations/proficiency';
import { buildAdvanceProjectPatch } from '../operations/advance-patch';
import { formatScenarioTranscript } from '../operations/eval-prompts';

const log = createLogger('PBL v2 Instructor');

export type InstructorPhase = 'greeting' | 'setup' | 'instructing';

// Step budget for a teaching turn (tool call + prose).
const MAX_INSTRUCTOR_STEPS = 7;
const MAX_HISTORY_MESSAGES = 24;

// ---------------------------------------------------------------------------
// Phase blocks — appended to the system prompt last (recency).
// ---------------------------------------------------------------------------

const PHASE_BLOCKS: Record<InstructorPhase, string> = {
  greeting: `
## Right now: GREETING phase

This is the learner's very first turn on this project. They have not seen any messages from you yet.

Your job in this single reply:
1. Warmly welcome them by name if you have it (project metadata may include their nickname).
2. State, in one sentence, what the whole project is going to be about.
3. Hand off into the first microtask gently — give them a single concrete next step they can act on.

Keep it to 4-6 short sentences. Don't list every milestone. Don't ask whether they're ready — invite them in.
`.trim(),

  setup: `
## Right now: SETUP phase

A new microtask just became active. The learner has either clicked it in the sidebar or just completed the previous one. They have NOT spoken yet on this microtask.

Your job in this single reply:
1. Open ONLY the newly active microtask. If this follows a task divider, the previous task has already been wrapped up — do not praise, evaluate, or restate that previous task again.
2. If this setup follows a milestone Continue / stage handover, first give 1-2 short sentences about the NEW milestone as a whole: its goal, what capability it adds, and why it matters.
3. Then name the concrete next action for this active microtask. Avoid vague handoffs like "follow this little plan" unless the actual action is stated immediately.
4. In the spirit of the "Opening tone — critical" section above, add why-this-matters and an invitation, NOT a checklist.
5. Optionally include one light orienting question if the next step genuinely depends on knowing where they are; otherwise just hand off the first concrete attempt.

Do NOT call any tools in a SETUP turn. Just speak.
`.trim(),

  instructing: `
## Right now: INSTRUCTING phase

Normal teaching turn. Read what the learner just said, decide whether they are mid-task, asking for help, or sharing work meant for review, and respond accordingly. Follow the conversation-rhythm and required-tools rules above. Do not mark the task complete from chat; if the learner posts task deliverables here, guide them to submit the work in the right-side submission panel for evaluation.
`.trim(),
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildProjectBlock(project: PBLProjectV2): string {
  const lines = ['## Project', `Title: ${project.title}`, `Description: ${project.description}`];
  if (project.learningObjective) {
    lines.push(
      `Learning objective (what the learner wants to LEARN): ${project.learningObjective}`,
    );
  }
  if (project.proficiency) {
    lines.push(`Learner proficiency tier: ${project.proficiency}`);
  }
  if (project.languageDirective) {
    lines.push(`Content-language policy: ${project.languageDirective}`);
  } else if (project.language) {
    lines.push(`Language (BCP-47): ${project.language}`);
  }
  return lines.join('\n');
}

function buildMilestoneBlock(milestone: PBLMilestone): string {
  const lines = [
    `## Current milestone — ${milestone.title}`,
    milestone.description ? milestone.description : '',
  ];
  if (milestone.briefing) {
    lines.push('### Stage briefing (your script)', milestone.briefing);
  }
  if (milestone.completionCriteria) {
    lines.push('### Stage completion criteria', milestone.completionCriteria);
  }
  return lines.filter(Boolean).join('\n\n');
}

function buildMicrotaskBlock(microtask: PBLMicrotask, position: number, total: number): string {
  const lines = [
    `## Active microtask (${position + 1}/${total}) — ${microtask.title}`,
    microtask.description ?? '',
  ];
  if (microtask.hints?.length) {
    lines.push(
      '### Hints you can offer if the learner gets stuck',
      microtask.hints.map((h, i) => `${i + 1}. ${h}`).join('\n'),
    );
  }
  return lines.filter(Boolean).join('\n\n');
}

function buildAnchor(microtask: PBLMicrotask): string {
  return `[ACTIVE-TASK ANCHOR]\nThe active microtask is "${microtask.title}". Anything the learner says next, interpret as their attempt at THIS task first.`;
}

function newestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  return items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function latestSubmission(project: PBLProjectV2, microtaskId: string) {
  return newestByCreatedAt(project.submissions.filter((s) => s.microtaskId === microtaskId));
}

function latestTaskEvaluation(project: PBLProjectV2, microtaskId: string) {
  return newestByCreatedAt(
    project.evaluations.filter((e) => e.kind === 'task' && e.microtaskId === microtaskId),
  );
}

export function taskEvaluationStatusForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): string {
  const latestSub = latestSubmission(project, microtaskId);
  const latestEval = latestTaskEvaluation(project, microtaskId);
  if (!latestSub) return 'no submission yet';
  if (!latestEval) return 'latest submission has no task evaluation yet';
  if (latestEval.createdAt < latestSub.createdAt) {
    return 'latest submission is newer than the latest task evaluation';
  }
  if (typeof latestEval.score === 'number') {
    const pass = latestEval.score >= 60 ? 'passes the 60-point threshold' : 'below 60, not passing';
    return `latest task evaluation score ${latestEval.score} (${pass})`;
  }
  return 'latest task evaluation recorded without a numeric score';
}

function truncateForPrompt(text: string | undefined, max = 260): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function buildTaskEvaluationBlock(project: PBLProjectV2, microtaskId: string): string {
  const latestSub = latestSubmission(project, microtaskId);
  if (!latestSub) return '';
  const latestEval = latestTaskEvaluation(project, microtaskId);
  if (!latestEval || latestEval.createdAt < latestSub.createdAt) {
    return [
      '## Task evaluation status',
      latestEval
        ? 'The learner has a newer submission than the latest task evaluation.'
        : 'The learner has submitted work for this task, but no task evaluation is recorded yet.',
      'Do not advance this microtask until the latest submission has been evaluated or the platform has already provided evaluation results.',
    ].join('\n');
  }
  return [
    '## Latest task evaluation for active microtask',
    `Score: ${typeof latestEval.score === 'number' ? latestEval.score : 'not scored'}`,
    latestEval.feedback ? `Feedback: ${latestEval.feedback}` : '',
    latestEval.strengths?.length ? `Strengths: ${latestEval.strengths.join('; ')}` : '',
    latestEval.improvements?.length ? `Improvements: ${latestEval.improvements.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSubmissionContextBlock(project: PBLProjectV2, microtaskId: string): string {
  const summary = summarizeLatestSubmissionForMicrotask(project, microtaskId, 3000);
  if (!summary) return '';
  const evalStatus = buildTaskEvaluationBlock(project, microtaskId);
  return [
    '## Latest learner submission for active microtask',
    'The learner may have submitted earlier drafts, but this block contains only the latest submitted artifact. Judge current progress from this latest submission plus the latest task evaluation status.',
    'If the latest submission is missing key requirements, give corrective guidance first; do not advance yet.',
    summary,
    evalStatus,
  ].join('\n\n');
}

/**
 * Bounded digest of the learner's submissions on OTHER (already-worked)
 * microtasks — across every milestone — together with how each was assessed.
 * The ACTIVE microtask is excluded (its full submission + evaluation are shown
 * by `buildSubmissionContextBlock`).
 *
 * Why this exists (#519): the Instructor previously only saw the active task's
 * submission, so when a learner referred to something they submitted earlier
 * (a pasted doc, an uploaded file) on another task/stage, the Instructor said it
 * "could only rely on the current task's visible submission". The submission and
 * evaluation data already live on the project (client-truth, sent every turn) —
 * there is no separate pipeline to fetch from; we just surface it.
 *
 * Bounded for long projects: latest submission per task only, a capped snippet
 * each (prefers the LLM `summary` when present), most-recent-first, and a hard
 * total-char budget with a truncation marker. Exported for unit testing.
 */
export function buildPriorSubmissionsBlock(
  project: PBLProjectV2,
  activeMicrotaskId: string,
  opts?: { maxChars?: number; perSnippetChars?: number },
): string {
  const maxChars = opts?.maxChars ?? 2600;
  const perSnippet = opts?.perSnippetChars ?? 220;

  const entries: Array<{ ts: string; text: string }> = [];
  for (const milestone of project.milestones) {
    for (const task of milestone.microtasks) {
      if (task.id === activeMicrotaskId) continue;
      const sub = latestSubmission(project, task.id);
      if (!sub) continue;
      const evalRec = latestTaskEvaluation(project, task.id);
      const kindLabel =
        sub.kind === 'file'
          ? `file${sub.filename ? ` "${sub.filename}"` : ''}`
          : sub.kind === 'link'
            ? 'link'
            : 'text';
      const body =
        sub.summary && sub.summary.trim()
          ? truncateForPrompt(sub.summary, perSnippet)
          : truncateForPrompt(sub.content, perSnippet);
      // Only treat the evaluation as belonging to THIS (latest) submission when
      // it is not older than the submission. A newer-but-unevaluated submission
      // must not borrow the previous version's score — otherwise the Instructor
      // would tell the learner their just-submitted new version "scored X". This
      // mirrors the active-task freshness check (latestEval.createdAt < sub.createdAt).
      let evalText: string;
      if (evalRec && evalRec.createdAt >= sub.createdAt) {
        const score = typeof evalRec.score === 'number' ? `score ${evalRec.score}` : 'reviewed';
        const improve = evalRec.improvements?.length
          ? `; to improve: ${evalRec.improvements.slice(0, 2).join('; ')}`
          : '';
        evalText = ` — assessed: ${score}${improve}`;
      } else if (evalRec) {
        // An evaluation exists but predates this submission → the latest version
        // is not yet evaluated; do not surface the stale score as its result.
        evalText = ' — latest version not yet evaluated';
      } else {
        evalText = ' — not yet scored';
      }
      entries.push({
        ts: sub.createdAt,
        text: `- [${milestone.title} / ${task.title}] ${kindLabel}: ${body}${evalText}`,
      });
    }
  }
  if (entries.length === 0) return '';

  // Most recent prior work first — it is the most relevant for continuity.
  entries.sort((a, b) => b.ts.localeCompare(a.ts));

  const header = [
    "## Learner's earlier submissions across this project (with how each was assessed)",
    "These are deliverables the learner already submitted on OTHER tasks / stages (the active task's own submission, if any, is shown separately above). Use them for continuity: if the learner refers to something they submitted earlier — a pasted doc, an uploaded file, work from a previous stage — you HAVE it here. Do not claim you can only see the current task's submission.",
  ];
  const lines = [...header];
  let used = header.join('\n').length;
  let truncated = false;
  for (const entry of entries) {
    if (used + entry.text.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(entry.text);
    used += entry.text.length + 1;
  }
  if (truncated) lines.push('- [...earlier submissions truncated to keep context bounded]');
  return lines.join('\n');
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function countSubmissions(project: PBLProjectV2, microtaskId: string): number {
  return project.submissions.filter((s) => s.microtaskId === microtaskId).length;
}

function orderedMicrotasks(milestone: PBLMilestone): PBLMicrotask[] {
  return milestone.microtasks.slice().sort((a, b) => a.order - b.order);
}

function nextInstructionTarget(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask,
): { nextMicrotaskTitle?: string; nextMilestoneTitle?: string } {
  const tasks = orderedMicrotasks(milestone);
  const index = tasks.findIndex((t) => t.id === microtask.id);
  const nextTask = index >= 0 ? tasks[index + 1] : undefined;
  if (nextTask) {
    return { nextMicrotaskTitle: nextTask.title };
  }

  const milestones = project.milestones.slice().sort((a, b) => a.order - b.order);
  const milestoneIndex = milestones.findIndex((m) => m.id === milestone.id);
  const nextMilestone = milestoneIndex >= 0 ? milestones[milestoneIndex + 1] : undefined;
  return { nextMilestoneTitle: nextMilestone?.title };
}

/** True when advancing `microtaskId` would complete the milestone —
 *  every other microtask is already terminal (completed / skipped). */
function isLastMicrotaskOfMilestone(milestone: PBLMilestone, microtaskId: string): boolean {
  return milestone.microtasks.every(
    (t) => t.id === microtaskId || t.status === 'completed' || t.status === 'skipped',
  );
}

/** True when this milestone carries an unsatisfied stage-level
 *  synthesis check AND advancing `microtask` would seal it — i.e. the
 *  one-time integrative reverse-question is still owed before the stage
 *  may close. Exported for unit tests around the optional bonus challenge. */
export function stageSynthesisOwed(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask,
): boolean {
  if (!milestone.synthesisCheck) return false;
  if (!isLastMicrotaskOfMilestone(milestone, microtask.id)) return false;
  return !milestoneSynthesisSatisfied(project, milestone.id);
}

function buildRoadmapBlock(project: PBLProjectV2, activeMicrotaskId: string): string {
  const lines = ['## Project roadmap and live state'];
  for (const milestone of project.milestones.slice().sort((a, b) => a.order - b.order)) {
    lines.push(
      `- Milestone ${milestone.order + 1}: ${milestone.title} [${statusLabel(milestone.status)}]`,
    );
    const milestoneGoal = truncateForPrompt(milestone.description);
    if (milestoneGoal) lines.push(`  Goal: ${milestoneGoal}`);
    const briefing = truncateForPrompt(milestone.briefing);
    if (briefing) lines.push(`  Instructor setup notes: ${briefing}`);
    const criteria = truncateForPrompt(milestone.completionCriteria);
    if (criteria) lines.push(`  Stage completion criteria: ${criteria}`);
    for (const task of orderedMicrotasks(milestone)) {
      const marker = task.id === activeMicrotaskId ? ' ← ACTIVE TASK' : '';
      const submissions = countSubmissions(project, task.id);
      const submissionText = submissions > 0 ? `, submissions=${submissions}` : '';
      const evalText =
        submissions > 0 ? `, ${taskEvaluationStatusForMicrotask(project, task.id)}` : '';
      lines.push(
        `  - (${task.order + 1}) ${task.title} [${statusLabel(task.status)}${submissionText}${evalText}]${marker}`,
      );
      const taskIntent = truncateForPrompt(task.description);
      if (taskIntent) lines.push(`    Task intent: ${taskIntent}`);
      if (task.hints.length) {
        lines.push(
          `    Possible scaffolds: ${task.hints.map((h) => truncateForPrompt(h, 120)).join(' | ')}`,
        );
      }
    }
  }
  if (project.pendingHandover && !project.pendingHandover.consumed) {
    lines.push(
      `Pending stage handover: "${project.pendingHandover.completedMilestoneTitle}" is complete; wait for the learner to click Continue before opening "${project.pendingHandover.nextMilestoneTitle}".`,
    );
  }
  return lines.join('\n');
}

/** Per-tier number of "stuck-signal / extra-attempt units" required
 *  before the literal answer may be released. Beginner releases fast,
 *  advanced almost never (explicit request only). Unset normalizes to the
 *  no-evidence DEFAULT_TIER so it stays consistent with the tier-guidance
 *  block (which also resolves '' → DEFAULT_TIER). */
function releaseThresholdForTier(tier: PBLProficiency): number {
  const resolved = tier === '' ? DEFAULT_TIER : tier;
  if (resolved === 'advanced') return 3;
  if (resolved === 'intermediate') return 2;
  return 1; // beginner
}

/** Should the turn surface the empty-output retry fallback?
 *
 *  Keyed on real *user-perceivable* output, NOT on "a tool was called"
 *  (#593): a bare tool call such as record_observation with no text is
 *  invisible to the learner. The user-perceivable outputs here are a
 *  scenario auto-completion (`mainTurnAdvanced`) and the difficulty ack
 *  (`producedAck`, committed by an earlier branch).
 *
 *  `assistantText` MUST be the text the learner actually SEES. */
export function shouldReportEmptyOutput(args: {
  mainTurnAdvanced: boolean;
  assistantText: string;
  producedAck: boolean;
}): boolean {
  return !args.mainTurnAdvanced && !args.assistantText.trim() && !args.producedAck;
}

/** Compact "scaffolding state" line so the disclosure-ladder rules in
 *  tier-guidance have *real, mostly-deterministic* per-microtask signals
 *  to lean on instead of the LLM guessing "which attempt is this".
 *
 *  Two robustness fixes over the first version:
 *   - "genuine attempts" = errors + submissions (concrete tries at the
 *     task), NOT raw learner message count (which over-counts when the
 *     learner just chats / asks clarifiers).
 *   - emits an explicit RELEASE / HOLD verdict computed in code from a
 *     per-tier threshold, so the model is not left to free-form judge
 *     "is it time to give the answer". The explicit-ask override stays
 *     the model's call (it reads the learner's words). */
export function buildScaffoldStateLine(
  summary: PBLEngagementSummary,
  opts: { tier: PBLProficiency; submissionCount: number; suppressVerdict?: boolean },
): string {
  const turns = summary.learnerTurnCount ?? 0;
  const errors = summary.errorCount ?? 0;
  const repeats = summary.repeatErrorCount ?? 0;
  const struggles = summary.struggles?.length ?? 0;
  const questions = summary.questionsRaised ?? 0;
  const concepts = summary.conceptsUnlocked?.length ?? 0;

  const genuineAttempts = errors + opts.submissionCount;
  const stuckSignals = repeats + struggles;
  // First genuine attempt doesn't count toward release; subsequent
  // attempts + stuck signals accumulate.
  const releaseCount = stuckSignals + Math.max(0, genuineAttempts - 1);
  const threshold = releaseThresholdForTier(opts.tier);
  const release = releaseCount >= threshold;
  const tierLabel = opts.tier === '' ? DEFAULT_TIER : opts.tier;

  const statsLine = `learner messages this task: ${turns} · genuine attempts (errors+submissions): ${genuineAttempts} · stuck signals (repeat-errors ${repeats} + struggles ${struggles}): ${stuckSignals} · explicit help asks: ${questions} · concepts already shown: ${concepts}`;

  // During a stage-synthesis checkpoint the scaffold verdict is noise:
  // the model should focus on running the integrative question, not on
  // whether to release the answer. Keep the stats (still useful context)
  // but drop the verdict line so it doesn't compete with the synthesis
  // block's "do not advance yet" instruction.
  if (opts.suppressVerdict) {
    return ['## Scaffolding state — active microtask', statsLine].join('\n');
  }

  const verdict = release ? 'RELEASE' : 'HOLD';
  return [
    '## Scaffolding state — active microtask',
    statsLine,
    `Disclosure ladder: tier ${tierLabel} → L3 after ${threshold} unit(s); count ${releaseCount} → ${verdict} (explicit ask always releases immediately).`,
  ].join('\n');
}

/** Exported for tests. This is the compact operating map the
 *  Instructor receives every turn so it can guide, evaluate, and
 *  advance with awareness of project structure instead of free-form
 *  chat guessing. */
export function buildInstructorRuntimeBrief(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask,
  opts?: { synthesisOwed?: boolean },
): string {
  const tasks = orderedMicrotasks(milestone);
  const position = tasks.findIndex((t) => t.id === microtask.id);
  const total = tasks.length;
  const submissions = countSubmissions(project, microtask.id);
  const latestEval = taskEvaluationStatusForMicrotask(project, microtask.id);
  const engagement = microtaskEngagement(project, microtask.id);
  return [
    '## Instructor operating brief',
    `Project outcome: ${project.title} — ${project.description}`,
    project.learningObjective ? `Learning objective: ${project.learningObjective}` : '',
    `Current location: milestone ${milestone.order + 1} "${milestone.title}", microtask ${position + 1}/${total} "${microtask.title}" [${statusLabel(microtask.status)}].`,
    microtask.description ? `Current task intent: ${microtask.description}` : '',
    submissions > 0
      ? `Current task submissions: ${submissions}; ${latestEval}. Use them to understand the learner's work, but do not mark completion from chat.`
      : 'Current task submissions: none recorded yet. Chat is for discussion, clarification, and coaching; task readiness comes only from work submitted and evaluated through the right-side submission panel. If the learner shares a final answer, code, report, or other task deliverable in chat, briefly acknowledge it and ask them to submit it in the right-side panel for review.',
    '',
    buildScaffoldStateLine(engagement, {
      tier: project.proficiency,
      submissionCount: submissions,
      suppressVerdict: opts?.synthesisOwed,
    }),
    '',
    buildRoadmapBlock(project, microtask.id),
    '',
    '## Teaching contract',
    '- Guide only the ACTIVE TASK unless the learner explicitly asks for project overview or future context.',
    '- You do NOT mark tasks complete, advance, or move to the next task yourself. The platform marks the active microtask ready only after the right-side submission panel records a passing task evaluation, then the learner chooses when to click Done in the sidebar. Your job is to teach THIS task well; do not announce or preview the next task.',
    '- The right-side submission panel is REQUIRED for task deliverables and readiness. If the learner pastes task output, code, a written answer, a report, or any final work into chat, acknowledge what they shared, help if needed, and direct them to submit it in the right-side panel so it can be evaluated. Do not say that chat alone completed the task.',
    '- Use the current task description, milestone briefing, completion criteria, submissions, and task evaluation together to teach toward what "done" looks like.',
    "- The learner's earlier submissions on other tasks/stages, and how each was assessed, are provided above — treat them as known. If the learner refers to something they submitted earlier (a pasted doc, an uploaded file, work from a previous stage), rely on it; never tell them you can only see the current task's submission.",
    '- If the active task has an unevaluated submission, help the learner get it evaluated (or respond to its evaluation) rather than treating the task as finished.',
    '- When the platform completes the last microtask of a milestone it shows a stage-complete card with a Continue button; it does not open the next milestone until the learner clicks it. After that Continue, the platform activates the next milestone and first microtask; open it with a SETUP message grounded in the new milestone.',
    "- On EVERY learner message, as part of deciding your reply, judge by MEANING — not by keywords or fixed phrasing — whether the learner genuinely wants to change the teaching difficulty OR is telling you their own level. Learners express this in countless ways across languages; these are only illustrative, NOT a match list: '改成中级' / '太难了讲慢点' / 'もっと簡単に' / 'сделай проще' / \"I'm new to all this\" / 'can we go deeper?'. If their intent is to change difficulty, call adjust_difficulty with the matching target (beginner/intermediate/advanced for an absolute level; easier/harder for a relative nudge) in the same turn, AND briefly acknowledge the change in your reply (the learner asked, so it belongs in the answer). This is the ONLY way difficulty changes from a learner request — there is no separate detector. Use judgement: do NOT call it for an incidental level word, a question about the content ('is this an advanced topic?'), or anything that is not a genuine request to change difficulty.",
  ]
    .filter(Boolean)
    .join('\n');
}

/** Final "hard rules" block appended after every other prompt
 *  section so it sits closest to the conversation (positional
 *  recency). Re-asserts identity + language because greeting / setup
 *  turns have no learner messages to anchor against — the LLM is
 *  otherwise free to drift into its default generic-assistant
 *  persona, which historically happened (see commit history for the
 *  "I'm Claude, here's what I can do" bug). */
function buildHardRulesBlock(project: PBLProjectV2): string {
  const langFallback = project.language || 'en-US';
  const langRule = project.languageDirective
    ? `follow this content-language policy: \`${project.languageDirective}\` (fallback BCP-47 locale: \`${langFallback}\`). If the directive contains nuanced instruction (e.g. "keep technical terms in English"), follow it literally.`
    : `reply ONLY in \`${langFallback}\`.`;
  return `## Hard rules — read last, obey first

1. **Identity**: you are the Instructor of THIS project. Never call yourself Claude / ChatGPT / Anthropic / OpenAI / a "general AI assistant". Never enumerate generic capabilities. Stay strictly in-scope (this project's milestones / microtasks).
2. **Language**: ${langRule} Do not switch languages mid-reply except to quote code, technical terms, proper names, or to clarify a single word. This rule **overrides** any language signal elsewhere in this prompt.
3. **Project awareness**: you know the project. If the learner asks "what project am I doing?", "do you know what project this is?", or an equivalent question, answer directly from the Project block: title, artefact, current milestone, and active microtask. Never say you do not know what project they want to do unless the Project block is genuinely empty.
4. **Tone of the first message of a new task** (greeting / setup): one warm sentence connecting in-character, then one concrete next step. No self-introduction list, except for the brief Instructor introduction explicitly required by the first-task workspace orientation block. No "here's what I can help with".`;
}

function isFirstProjectMicrotask(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask,
): boolean {
  const firstMilestone = project.milestones.slice().sort((a, b) => a.order - b.order)[0];
  if (!firstMilestone || firstMilestone.id !== milestone.id) return false;
  const firstTask = orderedMicrotasks(firstMilestone)[0];
  return firstTask?.id === microtask.id;
}

export function buildFirstTaskWorkspaceOrientationBlock(args: {
  project: PBLProjectV2;
  milestone: PBLMilestone;
  microtask: PBLMicrotask;
  phase: InstructorPhase;
}): string {
  if (args.phase !== 'greeting' && args.phase !== 'setup') return '';
  // SCENARIO ONLY exclusion: role-play projects have their OWN dedicated prep
  // briefing (see buildScenarioAwarenessBlock — cast / premise / rules / how to
  // enter the scene). The ordinary "left sidebar / center / submit on the right"
  // workspace orientation does NOT apply to them and must never leak into the
  // scenario prep opener, or it overwrites that bespoke briefing.
  if (args.project.scenario) return '';
  if (!isFirstProjectMicrotask(args.project, args.milestone, args.microtask)) return '';
  return [
    '## First-task workspace orientation — open-task only',
    '',
    "This is the first milestone's first task. In this opener, include a brief, natural workspace guide before or around the concrete first-task handoff. Keep it concise, in the learner's project language, and do not turn it into a long manual.",
    '',
    'Cover these points:',
    '1. Introduce the workspace: the left side is the task sidebar; the center is the Instructor interaction area. Briefly introduce yourself as the Instructor who will stay with them in the center throughout the project, giving hints and guidance; they can ask you questions at any time.',
    "2. Explain the right side: it shows the current task details and the submission area. Every task's final deliverable should be submitted on the right. Simple tasks can be submitted by copying/pasting text; complex work or special formatting can be submitted as a PDF or an image/screenshot. After submission, the platform generates a feedback card.",
    '3. Explain progression: after each task is ready, the learner needs to click the button that appears to advance. Before advancing, they can freely ask and discuss anything with the Instructor.',
    '',
    'Do not repeat this orientation on later tasks.',
  ].join('\n');
}

/** Synthetic platform turn-opener for greeting / setup phases.
 *  Localised so the LLM doesn't mistake an English imperative for a
 *  request to respond in English. Falls back to English for any
 *  locale we haven't translated yet. */
function syntheticPlatformOpener(phase: 'greeting' | 'setup', language: string): string {
  const lang = language || 'en-US';
  if (phase === 'greeting') {
    const m: Record<string, string> = {
      'zh-CN':
        '【平台】学习者刚刚进入项目。请用你（导师人设）的口吻欢迎他们，并自然引入第一个微任务。',
      'zh-TW':
        '【平台】學習者剛剛進入專案。請以你（導師人設）的口吻歡迎他們，並自然引入第一個微任務。',
      'ja-JP':
        '【プラットフォーム】学習者がプロジェクトに入りました。あなた（講師）として歓迎し、最初のマイクロタスクへ自然に案内してください。',
      'ru-RU':
        '[Платформа] Учащийся только что открыл проект. Поприветствуйте его в роли наставника и плавно введите в первую микрозадачу.',
      'ar-SA':
        '[المنصة] دخل المتعلم المشروع للتو. رحب به بدور المعلم وقدم له المهمة الصغيرة الأولى بطريقة طبيعية.',
      'en-US': '[platform] Learner just opened the project for the first time. Greet them now.',
    };
    return m[lang] ?? m['en-US'];
  }
  const m: Record<string, string> = {
    'zh-CN':
      '【平台】学习者刚刚激活了这个微任务。请只开启当前这个新微任务：如果这是新阶段的第一个任务，先用一两句话介绍整个新阶段的目标和意义；不要再总结上一个任务；然后明确说明现在要做的具体动作。',
    'zh-TW':
      '【平台】學習者剛剛啟動了這個微任務。請只開啟目前這個新微任務：如果這是新階段的第一個任務，先用一兩句話介紹整個新階段的目標和意義；不要再總結上一個任務；然後明確說明現在要做的具體動作。',
    'ja-JP':
      '【プラットフォーム】学習者がこのマイクロタスクをアクティブにしました。現在の新しいマイクロタスクだけを開いてください。これが新しいマイルストーンの最初のタスクなら、まず新しい段階全体の目標と意味を1〜2文で紹介してください。前のタスクを再評価せず、その後で今やる具体的な行動を伝えてください。',
    'ru-RU':
      '[Платформа] Учащийся активировал эту микрозадачу. Откройте только новую активную микрозадачу: если это первая задача нового этапа, сначала в 1-2 коротких предложениях объясните цель и смысл всего нового этапа; не подводите итог предыдущей задаче, затем назовите конкретное следующее действие.',
    'ar-SA':
      '[المنصة] قام المتعلم بتفعيل هذه المهمة الصغيرة. افتح المهمة النشطة الجديدة فقط: إذا كانت هذه أول مهمة في مرحلة جديدة، فعرّف هدف المرحلة الجديدة ومعناها في جملة أو جملتين؛ لا تلخص المهمة السابقة مرة أخرى، ثم اذكر الإجراء المحدد الآن.',
    'en-US':
      '[platform] Learner just activated this microtask. Open only the new active microtask: if this is the first task of a new milestone, first introduce the whole new milestone goal and why it matters in 1-2 short sentences; do not recap the previous task, then state the concrete next action.',
  };
  return m[lang] ?? m['en-US'];
}

/** Optional instructions injected ONLY on the last microtask of a
 *  `synthesisCheck` (core-knowledge) stage. Drives a one-time
 *  integrative reverse-question as a bonus challenge. It is not a task
 *  completion gate; the platform can mark the task ready from normal task
 *  evidence or a passing submission.
 *
 *  Placed AFTER the runtime brief for maximum recency so it overrides
 *  the base teaching rhythm ("one idea per turn", questioning discipline)
 *  for this one cell. */
function buildStageSynthesisBlock(milestone: PBLMilestone): string {
  const concept = milestone.synthesisCheck?.coreConcept ?? '';
  return [
    '## Optional stage synthesis challenge — core-knowledge stage',
    '',
    `This stage carries the project's core concept: **${concept}**. The active microtask is the LAST one of this core stage, so you may offer ONE short integrative reverse-question about the WHOLE stage / this concept — NOT about this microtask alone.`,
    'Frame it explicitly as an optional bonus challenge / extra reflection, not as a requirement for completing the task or moving on.',
    '',
    'Your job this turn:',
    '1. If it fits the conversation and the learner is not asking for something else, ask exactly ONE optional bonus question — e.g. "加分小挑战：回头看整个阶段，这个核心点为什么重要 / 它解决了什么问题？". Ask it once, then stop and wait. Do not ask a second question, and do not answer it for them.',
    '2. If the learner has ALREADY articulated this whole-stage concept on their own this session, do not make them repeat it — simply acknowledge it.',
    '3. If the platform has already said the task is complete or the learner is ready to move on, do not imply this challenge blocks progress.',
    '',
    'You do not record or advance anything yourself. Keep this turn to the single optional challenge (or a brief acknowledgement if it was already answered).',
  ].join('\n');
}

/** SCENARIO ONLY. Awareness block injected into the Instructor system
 *  prompt when the project is a role-play scenario (`project.scenario`
 *  present with a cast AND at least one roleplay stage). Returns '' for
 *  ordinary projects, so their prompt is byte-identical to before.
 *
 *  The scenario runs as a fixed three-stage skeleton; the Instructor
 *  only appears in the prep and wrapup stages (the Simulator runs the
 *  roleplay stage). This block tells the Instructor what to do depending
 *  on the CURRENT milestone's `scenarioStage`:
 *    - prep     : introduce the concrete premise + cast, then hand off
 *                 (no assessment, no reverse-question, confirm-to-advance).
 *    - roleplay : the Simulator owns it; the Instructor does not run it and
 *                 must never impersonate the character.
 *    - wrapup : brief, data-grounded feedback + invite questions; detail
 *               lives on the completion page (not a long debrief / quiz).
 *
 *  Exported for unit tests. */
export function buildScenarioAwarenessBlock(args: {
  project: PBLProjectV2;
  milestone: PBLMilestone;
  phase: InstructorPhase;
}): string {
  const scenario = args.project.scenario;
  if (!scenario) return '';
  const characters = scenario.characters ?? [];
  if (characters.length === 0) return '';
  const roleplayMilestones = args.project.milestones.filter((m) => m.scenarioStage === 'roleplay');
  if (roleplayMilestones.length === 0) return '';

  const cast = characters
    .map((c) => {
      const persona = (c.persona ?? '').trim();
      const situation = (c.situation ?? '').trim();
      const personaShort = persona.length > 140 ? persona.slice(0, 140) + '…' : persona;
      const situationShort = situation.length > 160 ? situation.slice(0, 160) + '…' : situation;
      const parts = [personaShort, situationShort ? `当下处境：${situationShort}` : '']
        .filter(Boolean)
        .join('；');
      return `**${c.name}**${parts ? ` — ${parts}` : ''}`;
    })
    .join('\n  · ');
  const names = characters.map((c) => c.name).join('、');
  const roleplayTitles = roleplayMilestones.map((m) => `「${m.title}」`).join('、');
  const stage = args.milestone.scenarioStage;

  const lines: string[] = [
    '## Scenario awareness (this project is a role-play scenario)',
    '',
    'The learner will engage in-character inside an immersive scene. The premise is GIVEN — you introduce it; the learner never has to guess it. You appear only in the prep & wrapup stages; the immersive scene itself is run by the character(s), not you.',
    `- Setting (premise): ${scenario.setting}`,
    scenario.rules ? `- Rules the learner must know: ${scenario.rules}` : '',
    scenario.learnerRole ? `- The learner's own role: ${scenario.learnerRole}` : '',
    scenario.goal ? `- What they are practising: ${scenario.goal}` : '',
    `- Cast:\n  · ${cast}`,
    `- The immersive roleplay stage(s): ${roleplayTitles}.`,
    '',
  ];

  if (stage === 'prep') {
    const isOpening = args.phase === 'greeting' || args.phase === 'setup';
    if (isOpening) {
      // Data-driven: whether this scenario teaches a rule-set is decided
      // by the Planner authoring `scenario.rules` (games / debates /
      // interviews / etc. get it; free scenarios like "comfort a friend"
      // leave it empty). When present we REQUIRE a real rules section;
      // when absent we forbid inventing one.
      const hasRules = !!scenario.rules?.trim();
      const rulesPart = hasRules
        ? '6. **Rules — REQUIRED for this scenario.** It has a defined rule-set, so include a clearly-formatted "rules" section that genuinely TEACHES a newcomer how to take part — never just name jargon. As **bullet points**, lay out the concrete rules from "Rules the learner must know" above (e.g. for a card game: hand ranking, the betting rounds, blinds, and what each key term like Pot Odds / Fold / Call / Raise / Check actually means; for a debate: the motion, each side\'s stance, the speaking format; for an interview: the rounds and what each assesses). A beginner must be able to actually play / participate after reading it — do not leave any named term unexplained.'
        : '6. Any remaining background THIS scenario needs so nothing important is missing (e.g. the relationship context, who knows what). This scenario has **no special rule-set**, so do NOT invent rules or a rulebook — keep it to the natural background.';
      lines.push(
        '### You are in the PREP stage — write the OPENING briefing now',
        'IMPORTANT — this opening briefing is the ONE deliberate EXCEPTION to the global brevity rules above (the “short turns / one idea per turn / don’t lecture / don’t format when it feels like a form” guidance). Those do NOT apply to this single message: it is a longer, rich, structured briefing, and it MUST be fully formatted EVERY time — never a flat paragraph and never a near-formatless reply.',
        'This is your FIRST message, in the project language. Produce ONE well-formatted, easy-to-SKIM briefing the learner reads before entering the scene. It MUST include ALL of the parts below, in order.',
        'Formatting is MANDATORY — this is what makes it readable, so do not skip it on any of these:',
        '- Give EACH part below its own short **section heading** (a bold line or a `###` heading) led by a tasteful emoji — do NOT run the parts together as one block of prose.',
        '- Render every list of facts (the cast, the rules, any setup details) as **bullet points**, one item per line — never a comma-separated run-on sentence.',
        '- Keep the text under each heading to short paragraphs (1–3 sentences) so the whole thing stays skimmable.',
        'A bare, paragraph-only opening with no headings or bullets is WRONG here — even though that same plain style would be correct for a normal mid-task reply.',
        '1. A warm greeting to open the project.',
        '2. A one-line self-introduction (who you are as their coach/guide).',
        '3. What this project is about (the overall goal).',
        '4. The scenario task: what the immersive interaction in the middle is, including its situation/background.',
        `5. The character(s) they will interact with: name + who they are + what the learner will do with them (here: ${names}).`,
        rulesPart,
        '7. A brief, light piece of guidance or encouragement as a lead-in (warm, not preachy). It is a one-line morale lead-in ONLY — NOT a warm-up exercise, NOT a practice question, NOT a task.',
        '8. A closing line: ask them to read it over, tell them they can ask you anything that is unclear, and that when they are ready they should click the button under the Prep stage in the LEFT sidebar to enter the scene. Refer to that button only by what it DOES (e.g. “左侧准备阶段下方进入场景的按钮” / “the button to enter the scene”); do NOT invent or quote a specific button label like “准备开始” / “开始” — you do not know its exact wording, so describing its action avoids naming it wrong.',
        // OVERRIDE the general teaching prompt for this prep briefing: the base
        // rules + SETUP phase block push the Instructor to elicit, to "warm up"
        // with a small question, or to hand off a first action. NONE of that
        // belongs in prep — the learner's only job here is to READ and get
        // ready; the real practice happens inside the scene afterwards.
        'CRITICAL — prep gives the learner NOTHING to do except read and get ready. Do NOT set any task, warm-up, mini-exercise, or quiz. Do NOT ask the learner a question that expects an answer here (no "先热个身，回答一下…", no "你觉得…?", no checking their understanding). The ONLY thing you invite is for THEM to ask YOU if something is unclear (part 8). End on part 8 — do not append anything after it.',
        'Pull all concrete content from the scenario data above (setting / each character’s situation / rules / learner role / goal). Do NOT invent facts beyond it. Do NOT impersonate the character or start the role-play here.',
      );
    } else {
      lines.push(
        '### You are in the PREP stage — answering a follow-up question',
        'You already gave the opening briefing. Now just answer the learner’s question about the setup / rules / character clearly and concisely, in the project language. Do NOT repeat the whole briefing.',
        'You **cannot and must not** advance the stage and you have no tools — when the learner is ready they click the sidebar button to enter the scene; reassure them they can do that whenever ready. Do NOT impersonate the character.',
        'Prep still gives the learner nothing to DO: just answer their question. Do NOT set a task, warm-up, or quiz, and do NOT ask them a question that expects an answer — only invite them to ask you more if needed.',
      );
    }
  } else if (stage === 'wrapup') {
    // Ground the wrapup in what the learner ACTUALLY did — the real role-play
    // transcript (their own words + the character's replies). Most scenarios
    // are free dialogue, so this is what reflects their performance. It comes
    // from the live session; nothing is invented.
    lines.push(
      '### What actually happened in the scene (the learner played this — ground your debrief ONLY on this real record, never invent)',
      formatScenarioTranscript(args.project),
      '',
    );
    lines.push(
      '### You are in the WRAPUP stage — write the single closing debrief now',
      // Explicit OVERRIDE of the general teaching prompt. Wrapup reuses the same
      // base rules + SETUP/INSTRUCTING phase block + runtime brief as ordinary
      // teaching turns, which tell the Instructor to elicit, ask an orienting
      // question, hand off the "next action", check understanding, etc. NONE of
      // that applies here — this is a terminal summary, not a teaching turn. Say
      // so plainly (mirrors the prep-stage exception) so those rules cannot leak
      // a question or a "next step" into the closing message.
      'OVERRIDE — this is the ONE deliberate EXCEPTION to the teaching rules above: ignore every instruction to elicit, to ask an orienting/follow-up question, to hand off a "next action" or next microtask, to check understanding, or to call any tool. There is NO next task and NOTHING for the learner to do — this is a pure closing reflection.',
      'This is your ONE closing message and the session ENDS automatically right after it. It is a pure summary/reflection of how the role-play went — the learner has NOTHING left to do. Base it on the real transcript above: name one or two genuine highlights (ideally quoting/paraphrasing a real moment they had) + one specific thing to try next time.',
      'HARD RULES: Do NOT ask the learner ANY question of any kind (no "?", no "how did you feel", no "what would you do differently", no rhetorical questions). Do NOT request a reply, confirmation, or further action. Do NOT tell them to click anything or mention a separate report. Keep it light — a short warm debrief, not a long essay, not a quiz. Never invent moments that are not in the transcript. Just deliver the summary and close warmly.',
    );
  } else {
    // 'roleplay' (or, defensively, any other) — the Simulator owns the scene.
    lines.push(
      `### Roleplay stage — handed off`,
      `The immersive scene is run by the character(s); you are not the one role-playing here. If you are invoked, stay in your own coach/guide voice and do **not** impersonate ${names}.`,
    );
  }

  return lines.filter(Boolean).join('\n');
}

function buildSystemPrompt(args: {
  project: PBLProjectV2;
  milestone: PBLMilestone;
  microtask: PBLMicrotask;
  instructor?: PBLRole;
  phase: InstructorPhase;
}): string {
  const base = loadPBLV2Prompt('instructor-base-rules');
  const projectBlock = buildProjectBlock(args.project);
  const milestoneBlock = buildMilestoneBlock(args.milestone);
  const tasks = orderedMicrotasks(args.milestone);
  const position = tasks.findIndex((t) => t.id === args.microtask.id);
  const microtaskBlock = buildMicrotaskBlock(args.microtask, position, tasks.length);
  const submissionBlock = buildSubmissionContextBlock(args.project, args.microtask.id);
  const priorSubmissionsBlock = buildPriorSubmissionsBlock(args.project, args.microtask.id);
  const runtimeBrief = buildInstructorRuntimeBrief(args.project, args.milestone, args.microtask, {
    synthesisOwed:
      args.phase === 'instructing' &&
      stageSynthesisOwed(args.project, args.milestone, args.microtask),
  });
  // Tier-calibrated guidance — fresh recency for the LLM. Inserted
  // before the phase block so the phase-specific behavior (greeting
  // / setup / instructing) reads it as binding rules.
  const tierBlock = tierGuidanceBlock(args.project.proficiency);
  // Stage-synthesis checkpoint only matters while teaching the last
  // microtask of a core-knowledge stage. Restricted to the instructing
  // phase so greeting / setup openers never pre-emptively interrogate.
  // Placed AFTER the runtime brief (max recency) so its explicit rule
  // suspension overrides the base "advance immediately / Path B default"
  // rules that would otherwise compete with "don't advance yet, ask
  // first" in this cell. See `buildStageSynthesisBlock`.
  const synthesisOwed =
    args.phase === 'instructing' &&
    stageSynthesisOwed(args.project, args.milestone, args.microtask);
  const synthesisBlock = synthesisOwed ? buildStageSynthesisBlock(args.milestone) : '';
  const phaseBlock = PHASE_BLOCKS[args.phase];
  const firstTaskWorkspaceOrientationBlock = buildFirstTaskWorkspaceOrientationBlock(args);
  // SCENARIO ONLY. Empty for ordinary projects → no prompt change. Makes
  // the Instructor aware of the role-play scenario (preview / frame /
  // debrief) without impersonating the character.
  const scenarioAwarenessBlock = buildScenarioAwarenessBlock({
    project: args.project,
    milestone: args.milestone,
    phase: args.phase,
  });

  const instructorPersona = args.instructor?.systemPrompt
    ? `## Your persona\n${args.instructor.systemPrompt}`
    : '';

  return [
    base,
    instructorPersona,
    projectBlock,
    milestoneBlock,
    microtaskBlock,
    submissionBlock,
    priorSubmissionsBlock,
    tierBlock,
    phaseBlock,
    firstTaskWorkspaceOrientationBlock,
    scenarioAwarenessBlock,
    runtimeBrief,
    synthesisBlock,
    buildAnchor(args.microtask),
    // Hard rules sit last so they have positional recency over the
    // 200-line base rules. Re-asserts identity + language so the
    // LLM can't drift in greeting/setup turns where there is no
    // learner message to anchor against.
    buildHardRulesBlock(args.project),
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Recent message history → AI SDK messages
// ---------------------------------------------------------------------------

export function buildHistoryMessagesForInstructor(
  thread: { messages: PBLChatMessage[]; earlierSummary?: string } | undefined,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (!thread) return out;
  if (thread.earlierSummary) {
    out.push({
      role: 'system',
      content: `## Earlier conversation memory\n${thread.earlierSummary}`,
    });
  }
  const recent = thread.messages.slice(-MAX_HISTORY_MESSAGES);
  for (const m of recent) {
    if (m.roleType === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.roleType === 'instructor') {
      out.push({ role: 'assistant', content: m.content });
    }
    // Skip other agent types for now — Stage A only wires Instructor.
  }
  return out;
}

export function ensureNonEmptyInstructorMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  fallbackUserContent: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const cleaned = messages
    .map((m) => ({ ...m, content: m.content.trim() }))
    .filter((m) => m.content.length > 0);
  const hasConversationalTurn = cleaned.some((m) => m.role === 'user' || m.role === 'assistant');
  if (cleaned.length > 0 && hasConversationalTurn) return cleaned;
  const fallback = fallbackUserContent.trim() || 'Continue guiding the learner in the project.';
  return [...cleaned, { role: 'user', content: fallback }];
}

/**
 * Setup opener history should not "reply" to the previous learner
 * utterance. We strip trailing user messages so the setup opener is
 * framed as a proactive next-task handoff, not an answer to a
 * non-existent question.
 */
function buildSetupHistoryMessages(
  thread: { messages: PBLChatMessage[]; earlierSummary?: string } | undefined,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const base = buildHistoryMessagesForInstructor(thread);
  while (base.length > 0 && base[base.length - 1]?.role === 'user') {
    base.pop();
  }
  return base;
}

function isoAfter(previous?: string): string {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  const min = Number.isFinite(previousMs) ? previousMs + 1 : 0;
  return new Date(Math.max(now, min)).toISOString();
}

function mapNonCodeFenceText(text: string, fn: (chunk: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk) => (chunk.startsWith('```') ? chunk : fn(chunk)))
    .join('');
}

function normalizeSentenceForDedupe(sentence: string): string {
  return sentence
    .replace(/\s+/g, '')
    .replace(/[，,；;：:]/g, '')
    .trim();
}

function dedupeAdjacentRepeatedSentences(text: string): { text: string; changed: boolean } {
  let changed = false;
  const nextText = mapNonCodeFenceText(text, (chunk) => {
    const pieces = chunk.match(/[^。！？!?]+[。！？!?]+|\s+|[^。！？!?]+$/g);
    if (!pieces) return chunk;

    let lastSentenceNorm = '';
    const out: string[] = [];
    for (const piece of pieces) {
      if (!piece.trim()) {
        out.push(piece);
        continue;
      }
      const norm = normalizeSentenceForDedupe(piece);
      if (norm.length >= 12 && norm === lastSentenceNorm) {
        changed = true;
        continue;
      }
      out.push(piece);
      lastSentenceNorm = norm;
    }
    return out.join('');
  });
  return { text: nextText, changed };
}

export function stripLeakedToolJson(text: string): { text: string; changed: boolean } {
  let changed = false;
  const nextText = mapNonCodeFenceText(text, (chunk) => {
    const next = chunk.replace(
      /[^\S\r\n]*(?:\{[\s\S]{0,500}?"kind"\s*:\s*"(?:concept_unlocked|error|struggle|question)"[\s\S]{0,500}?\}|\{[\s\S]{0,500}?"signature"\s*:\s*"[^"]+"[\s\S]{0,500}?\})[^\S\r\n]*/g,
      (match) => {
        changed = true;
        const trailingSentence = match.match(/\}\s*([^{}\[\]\r\n]+[。！？!?])/u)?.[1];
        return trailingSentence ? trailingSentence.trimStart() : '';
      },
    );
    return next;
  });
  return { text: nextText.trim(), changed };
}

export function cleanInstructorCommitText(
  text: string,
  opts: {
    nextMicrotaskTitle?: string;
    nextMilestoneTitle?: string;
    stripFinalReverseQuestion?: boolean;
  } = {},
): { text: string; changed: boolean } {
  const withoutToolJson = stripLeakedToolJson(text);
  const deduped = dedupeAdjacentRepeatedSentences(withoutToolJson.text);
  const hasNextContext = !!opts.nextMicrotaskTitle || !!opts.nextMilestoneTitle;
  const prematureNext = hasNextContext
    ? stripPrematureNextTaskSetup(deduped.text, opts.nextMicrotaskTitle, opts.nextMilestoneTitle)
    : { text: deduped.text, stripped: false };
  const orphanQuestion =
    opts.stripFinalReverseQuestion || prematureNext.stripped
      ? stripOrphanTrailingQuestion(prematureNext.text)
      : { text: prematureNext.text, changed: false };
  return {
    text: orphanQuestion.text,
    changed:
      withoutToolJson.changed ||
      deduped.changed ||
      prematureNext.stripped ||
      orphanQuestion.changed,
  };
}

export function cleanSetupFollowupText(text: string): { text: string; changed: boolean } {
  const withoutToolJson = stripLeakedToolJson(text);
  const deduped = dedupeAdjacentRepeatedSentences(withoutToolJson.text);
  let nextText = deduped.text;
  let changed = withoutToolJson.changed || deduped.changed;

  const leadingWhitespace = nextText.match(/^\s*/)?.[0] ?? '';
  const body = nextText.slice(leadingWhitespace.length);
  const firstWindow = body.slice(0, 220);
  const transitionMatch =
    /(现在(?:我们)?(?:要|来|开始|把|继续)|接下来(?:我们)?(?:要|来|开始|把|继续)|这一步(?:的意义|我们)?|下一步(?:我们)?(?:要|来|开始|把|继续))/u.exec(
      firstWindow,
    );
  if (transitionMatch && transitionMatch.index > 0) {
    const prefix = firstWindow.slice(0, transitionMatch.index);
    if (
      /(很好|很棒|不错|可以|对|太好了|接近|刚才|刚刚|已经|上一|上个|上一步|上一个|前面|完成|做完|到位|满足|正确)/u.test(
        prefix,
      )
    ) {
      nextText =
        leadingWhitespace + body.slice(transitionMatch.index).replace(/^[，,；;。.!！?\s]+/u, '');
      changed = true;
    }
  }

  const withoutVagueLeadIn = nextText.replace(
    /(^|[\r\n]+)[^\S\r\n]*按(?:这个|上面|刚才的)?小计划来[：:，,]?[^\S\r\n]*/gu,
    '$1',
  );
  if (withoutVagueLeadIn !== nextText) {
    nextText = withoutVagueLeadIn;
    changed = true;
  }

  return { text: nextText, changed };
}

export function shouldHoldSetupFollowupPreview(
  rawText: string,
  cleaned: { text: string; changed: boolean },
): boolean {
  if (cleaned.changed) return false;
  if (rawText.length >= 220) return false;
  const firstLine = rawText.replace(/\r\n/g, '\n').split('\n')[0] ?? rawText;
  return /(很好|很棒|不错|可以|对|太好了|接近|刚才|刚刚|已经|上一|上个|上一步|上一个|前面|完成|做完|到位|满足|正确)/u.test(
    firstLine,
  );
}

/**
 * Strip an orphaned trailing reverse-question from an assistant
 * message that should end on a statement.
 *
 * Why: old task-review text can occasionally end with a closing check like
 * "…对吧？/ 为什么呢？". When that text is used as a final acknowledgement,
 * the learner has no clear turn to answer it. This helper keeps the review
 * sentence and removes the dangling closing question.
 *
 * Conservative by design:
 *   - only acts when the message ends on a question mark,
 *   - only removes the trailing question *sentence(s)* (or an explicit
 *     closing lead-in like "最后确认一下…"), never the preceding
 *     review / praise,
 *   - never blanks the message: if the whole message is a single
 *     question with no preceding sentence, it is left untouched.
 */
const ORPHAN_QUESTION_TAIL = /[?？][\s)）"”』」]*$/u;

/** Index of the last sentence-ending boundary in `s`, or -1.
 *
 *  CJK enders (。！？) and newlines always count. ASCII `.` / `!` / `?`
 *  count ONLY when at end-of-string or followed by whitespace — so an
 *  in-token dot like the one in `v2.0` or `3.14` is NOT treated as a
 *  sentence break (the P3 decimal/version bug). */
function lastSentenceBoundaryIndex(s: string): number {
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n' || ch === '。' || ch === '！' || ch === '？') {
      last = i;
    } else if (ch === '.' || ch === '!' || ch === '?') {
      const next = s[i + 1];
      if (next === undefined || /\s/.test(next)) last = i;
    }
  }
  return last;
}

/** Conservative trailing-glue trimmer for the rare case where a closing
 *  lead-in is comma-joined with no preceding sentence boundary AND a
 *  connector word ("…，那我们最后确认…？") sits before it. We strip
 *  trailing punctuation + a SMALL set of clause-glue connectors that are
 *  very unlikely to be legitimate sentence-final content. Common
 *  single-char words (好/来/那/现在/再) are deliberately excluded to
 *  avoid eating real content. Loop-stable, bounded. */
function trimTrailingClauseGlue(s: string): string {
  const PUNCT = /[\s，,、；;：:—-]+$/u;
  const CONNECTORS = /(咱们|那我们|我们|那么|接下来|然后|这样)$/u;
  let cur = s.trimEnd();
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(PUNCT, '').replace(CONNECTORS, '');
    if (next === cur) break;
    cur = next.trimEnd();
  }
  return cur;
}

export function stripOrphanTrailingQuestion(text: string): { text: string; changed: boolean } {
  const endsWithQuestion = (s: string) => ORPHAN_QUESTION_TAIL.test(s);
  if (!endsWithQuestion(text.trimEnd())) {
    return { text, changed: false };
  }

  // Known closing reverse-question lead-ins. When one sits in the tail
  // and what follows is a question, cut from before it even if it is
  // only comma-separated from the preceding praise (the common
  // "很好，最后确认一下…？" shape that a sentence-boundary scan misses).
  const CLOSING_LEADIN =
    /(最后(?:再)?(?:确认|问|检查|想|看)(?:一下|一句|一个小?问题)?|再(?:确认|问)(?:一下|一句)?|顺手再?确认(?:一下)?|顺便(?:再)?(?:问|确认)(?:一下)?|快速确认一下|last(?:,)? (?:check|question)|one (?:last|final) (?:check|question)|quick check|just to (?:confirm|check)|before we move on)/iu;
  let working = text;
  let changed = false;

  // Strategy 1: explicit closing lead-in in the tail. Prefer cutting at
  // the sentence boundary BEFORE the lead-in (removes the whole sentence
  // that contains it — so no dangling "…我们"); fall back to a
  // conservative glue trim only when there is no preceding boundary.
  {
    const trimmed = working.trimEnd();
    const tailStart = Math.max(0, trimmed.length - 160);
    const m = CLOSING_LEADIN.exec(trimmed.slice(tailStart));
    if (m) {
      const leadinAt = tailStart + m.index;
      const boundary = lastSentenceBoundaryIndex(trimmed.slice(0, leadinAt));
      const kept =
        boundary >= 0
          ? trimmed.slice(0, boundary + 1).trimEnd()
          : trimTrailingClauseGlue(trimmed.slice(0, leadinAt));
      if (kept) {
        working = kept;
        changed = true;
      }
    }
  }

  // Strategy 2: peel trailing question *sentences* one at a time, as
  // long as a non-empty preceding sentence remains. Bounded loop. Uses
  // the same boundary rule, so decimals / version numbers are safe.
  for (let i = 0; i < 4; i++) {
    const trimmed = working.trimEnd();
    if (!endsWithQuestion(trimmed)) break;
    // Drop the trailing question's own punctuation (and any wrapping
    // quote/paren) before scanning, so the final ？ isn't itself the
    // boundary we cut at.
    const qStripped = trimmed.replace(ORPHAN_QUESTION_TAIL, '');
    const lastBoundary = lastSentenceBoundaryIndex(qStripped);
    if (lastBoundary < 0) break; // whole message is one question — don't blank / don't mangle
    const kept = trimmed.slice(0, lastBoundary + 1).trimEnd();
    if (!kept) break;
    working = kept;
    changed = true;
  }

  return { text: working, changed };
}

export function stripPrematureNextTaskSetup(
  text: string,
  nextTitle: string | undefined,
  nextMilestoneTitle?: string,
): { text: string; stripped: boolean } {
  const titleIndexes = [nextTitle, nextMilestoneTitle]
    .filter((s): s is string => !!s)
    .map((s) => text.indexOf(s))
    .filter((idx) => idx >= 0);
  const titleIndex = titleIndexes.length > 0 ? Math.min(...titleIndexes) : -1;
  const looseTransitionRe =
    /(现在(?:我们)?(?:可以)?(?:进入|开始|来到|做)?|接下来(?:我们)?|下一步|下一个任务|下一阶段|下个阶段|下一个阶段|下一里程碑|继续按钮|Continue 按钮|点击右侧|点击.*?Continue|进入第[一二三四五六七八九十\d]+步|开始(?:下一个|下一项|下一步)|Now,?|Next,?|Next stage|Continue button|Let's (?:move|start|begin)|Let us (?:move|start|begin)|Move on to|We (?:can |will |'ll )?now)/gi;
  const strongTransitionRe =
    /(现在(?:我们)?(?:可以)?(?:进入|开始|来到|做)|接下来(?:我们)?(?:进入|开始|做|来)|下一步(?:我们)?(?:进入|开始|来|要|做)|下一个任务|下一阶段|下个阶段|下一个阶段|下一里程碑|继续按钮|Continue 按钮|点击右侧|点击.*?Continue|进入第[一二三四五六七八九十\d]+步|开始(?:下一个|下一项|下一步)|Now,? (?:let's|we can|we will|we'll|move|start|begin)|Next,? (?:let's|we can|we will|we'll|move|start|begin)|Next stage|Continue button|Let's (?:move|start|begin)|Let us (?:move|start|begin)|Move on to|We (?:can |will |'ll )now)/gi;

  let transitionStart = -1;
  if (titleIndex >= 0) {
    const beforeTitle = text.slice(0, titleIndex);
    const windowStart = Math.max(0, beforeTitle.length - 140);
    const windowText = beforeTitle.slice(windowStart);
    for (
      let match = looseTransitionRe.exec(windowText);
      match;
      match = looseTransitionRe.exec(windowText)
    ) {
      transitionStart = windowStart + match.index;
    }
  } else {
    const tailStart = Math.max(0, Math.floor(text.length * 0.35), text.length - 320);
    const tailText = text.slice(tailStart);
    for (
      let match = strongTransitionRe.exec(tailText);
      match;
      match = strongTransitionRe.exec(tailText)
    ) {
      if (transitionStart < 0) transitionStart = tailStart + match.index;
    }
  }

  if (titleIndex < 0 && transitionStart < 0) return { text, stripped: false };

  let cutAt = transitionStart >= 0 ? transitionStart : titleIndex;
  const lastBoundary = Math.max(
    text.lastIndexOf('\n\n', cutAt - 1),
    text.lastIndexOf('\n', cutAt - 1),
    text.lastIndexOf('。', cutAt - 1),
    text.lastIndexOf('！', cutAt - 1),
    text.lastIndexOf('？', cutAt - 1),
    text.lastIndexOf('.', cutAt - 1),
    text.lastIndexOf('!', cutAt - 1),
    text.lastIndexOf('?', cutAt - 1),
  );
  if (lastBoundary >= 0 && cutAt - lastBoundary <= 24) {
    cutAt = lastBoundary + (text[lastBoundary] === '\n' ? 0 : 1);
  }

  const kept = text.slice(0, cutAt).trimEnd();
  if (!kept || kept === text.trimEnd()) return { text, stripped: false };
  return { text: kept, stripped: true };
}

/**
 * Neutral, TIER-AGNOSTIC acknowledgment committed when the learner asked to
 * change difficulty (the model called `adjust_difficulty`) but wrote no text of
 * its own. The proficiency tier itself is underlying by design and is NEVER
 * named here — this only assures the learner their request was heard, so a
 * tool-only turn never leaves them with a silent, response-less screen.
 */
function difficultyAdjustAck(language: string | undefined): string {
  switch (language) {
    case 'zh-CN':
      return '好的，我来调整一下讲解的方式。';
    case 'zh-TW':
      return '好的，我來調整一下講解的方式。';
    case 'ja-JP':
      return 'わかりました。説明の仕方を調整しますね。';
    case 'ru-RU':
      return 'Хорошо, я скорректирую подачу материала.';
    case 'pt-BR':
      return 'Certo, vou ajustar a forma de explicar.';
    case 'ar-SA':
      return 'حسنًا، سأعدّل طريقة الشرح.';
    default:
      return "Got it — I'll adjust how I explain things.";
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunInstructorTurnArgs {
  project: PBLProjectV2;
  userMessage: string;
  phase: InstructorPhase;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  /** AbortSignal from the incoming HTTP request. When the client
   *  disconnects, this signal aborts, and the instructor loop
   *  stops burning compute. */
  signal?: AbortSignal;
}

/**
 * Drive one Instructor turn. Yields a stream of `PBLSSEEvent` that
 * the route handler forwards to the client. Mutates the in-memory
 * `args.project` (the route handler does NOT persist this — the
 * client is the source of truth; we just produce the patches the
 * client should apply).
 */
export async function* runInstructorTurn(
  args: RunInstructorTurnArgs,
): AsyncGenerator<PBLSSEEvent, void, void> {
  const { project, userMessage, phase, languageModel, thinkingConfig, signal } = args;

  normalizeProjectRuntime(project);
  const current = currentMicrotask(project);
  if (!current) {
    yield {
      type: 'error',
      code: 'NO_ACTIVE_MICROTASK',
      message: 'There is no active microtask to teach against. Has the project been started?',
    };
    yield { type: 'done' };
    return;
  }
  const { milestone, microtask } = current;

  // SCENARIO ONLY. Whether we are in the role-play scenario's PREP stage.
  // In prep, the Instructor only introduces the premise and answers
  // questions — it must NOT advance (the learner advances via the sidebar
  // "enter scenario" button). Double-gated by the project-level master
  // signal + the stage marker; ordinary projects are never affected.
  const scenarioPrepStage = !!project.scenario && milestone.scenarioStage === 'prep';

  // Append the learner turn to the in-memory project so the next
  // system-prompt rebuild sees it. The client is the source of
  // truth for the user message — it has already appended it
  // optimistically before sending this request, so we do NOT yield
  // the user message back as a project_patch (would either
  // duplicate or require fragile id reconciliation).
  if (phase === 'instructing') {
    const userMsg: PBLChatMessage = {
      id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
      roleType: 'user',
      content: userMessage,
      ts: new Date().toISOString(),
      microtaskId: microtask.id,
    };
    const instructorThread = project.threads.find((t) => {
      const r = project.roles.find((r) => r.id === t.agentId);
      return r?.type === 'instructor';
    });
    if (instructorThread) instructorThread.messages.push(userMsg);
    const turnEvent = recordEvent(project, 'learner_turn', {
      microtaskId: microtask.id,
      milestoneId: milestone.id,
      payload: { chars: userMessage.length },
    });
    // Advance the proficiency-cooldown counter on every learner turn
    // so dynamic retier gates can fire when enough time has passed.
    tickTurnOnProject(project);
    yield {
      type: 'project_patch',
      patch: {
        kind: 'engagement_event',
        event: turnEvent,
        eventKind: 'learner_turn',
        microtaskId: turnEvent.microtaskId,
        milestoneId: turnEvent.milestoneId,
        ts: turnEvent.ts,
        payload: turnEvent.payload,
      },
    };
    // NOTE: explicit "change the difficulty / I'm a beginner" requests are NOT
    // detected here by regex anymore. The Instructor LLM judges that intent from
    // the learner's message as part of its normal turn and calls the
    // `adjust_difficulty` tool (see the runtime-contract bullet + the tool),
    // which applies it immediately via applyProficiencyDirective. This removes
    // the brittle per-message regex and its corner cases (incidental mentions,
    // negation, multilingual).
  }

  const instructor = project.roles.find((r) => r.type === 'instructor');
  const systemPrompt = buildSystemPrompt({
    project,
    milestone,
    microtask,
    instructor,
    phase,
  });

  const instructorThread = project.threads.find((t) => {
    const r = project.roles.find((r) => r.id === t.agentId);
    return r?.type === 'instructor';
  });

  const historyMessages = buildHistoryMessagesForInstructor(instructorThread);

  // The synthetic learner message for greeting / setup — gives the
  // LLM a turn-anchor so it speaks first. Localised to the project
  // language so the LLM doesn't read an English imperative as a
  // signal to respond in English.
  const platformOpener =
    phase === 'instructing' ? userMessage : syntheticPlatformOpener(phase, project.language);
  const finalMessages = ensureNonEmptyInstructorMessages(
    phase === 'instructing'
      ? historyMessages
      : [
          ...historyMessages,
          {
            role: 'user' as const,
            content: platformOpener,
          },
        ],
    platformOpener,
  );

  // ----- Tools -----
  // Pending SSE events queued by tool executes (recorded engagement
  // events + proficiency patches). Flushed in the `tool-result` case
  // after the result is available so the wire ordering matches the
  // server-side mutation order.
  const pendingPatches: PBLSSEEvent[] = [];

  // Teaching-agent tools. NO advance machinery: task readiness is decided only
  // by right-side submission evaluation, so this turn's prose can never narrate
  // progress control. Only two tools remain — both orthogonal to completion:
  //   - record_observation: analytic learning events (never gates advance).
  //   - adjust_difficulty: applies a learner's explicit level request.
  let didAdjustDifficulty = false;
  const tools = {
    record_observation: tool({
      description:
        'Record a notable learning event mid-task (error, struggle, question) for the evaluator. Analytics only — this does NOT advance the task or gate completion. Use sparingly, for moments worth showing the evaluator.',
      inputSchema: RecordObservationArgs,
      execute: async ({ kind, signature, label, note }) => {
        const eventKind =
          kind === 'error'
            ? 'observation_error'
            : kind === 'struggle'
              ? 'observation_struggle'
              : 'observation_question';
        // Before appending the new event, check whether this error
        // signature has already been seen on the same microtask —
        // that "stuck on the same thing" signal is stronger than a
        // first-time error.
        const repeatedError =
          kind === 'error' &&
          typeof signature === 'string' &&
          project.engagementEvents.some(
            (e) =>
              e.kind === 'observation_error' &&
              e.microtaskId === microtask.id &&
              String(e.payload?.signature ?? '') === signature,
          );
        const event = recordEvent(project, eventKind, {
          microtaskId: microtask.id,
          milestoneId: milestone.id,
          payload: { signature, label, note },
        });
        pendingPatches.push({
          type: 'project_patch',
          patch: {
            kind: 'engagement_event',
            event,
            eventKind: event.kind,
            microtaskId: event.microtaskId,
            milestoneId: event.milestoneId,
            ts: event.ts,
            payload: event.payload,
          },
        });
        // Fold the observation into the adaptive engine. Note is not
        // forwarded — the engine only consumes `kind` + `repeat`.
        const r = trackObservation(project, kind, { repeat: repeatedError });
        pendingPatches.push(...r.patches);
        return { ok: true };
      },
    }),

    adjust_difficulty: tool({
      description:
        "Apply the learner's EXPLICIT request to change the teaching difficulty, or their statement of their own level — in ANY language (e.g. 「改成中级」, 「もっと簡単に」, «сделай сложнее», “deixa mais difícil”, “I'm a beginner”). Use beginner/intermediate/advanced when they name a level or describe themselves; use easier/harder for a relative nudge. This takes effect immediately and overrides the platform's adaptive estimate (the learner's own word wins). Do NOT call it for an incidental mention or a question about the content (e.g. “is this an advanced topic?”) — only when the learner is actually asking to change difficulty.",
      inputSchema: AdjustDifficultyArgs,
      execute: async ({ target }) => {
        const result = applyProficiencyDirective(project, proficiencyDirectiveFromTarget(target));
        pendingPatches.push(...result.patches);
        didAdjustDifficulty = true;
        return { ok: true, tier: project.proficiency };
      },
    }),
  };

  // ----- Act -----
  //
  // Ordinary chat turns always run the teaching model. They never mark the
  // active task ready or advance progress; that state is owned by the
  // submission/evaluation flow plus the learner's explicit Done click.
  let assistantText = '';
  // Whether the active microtask advanced this turn. Ordinary teaching never
  // advances; scenario wrapup setup may still auto-complete below.
  let mainTurnAdvanced = false;
  try {
    // Greeting / Setup turns are pure-text openers — no tools. Exposing the
    // teaching tools there lets eager-tool models emit a tool call instead of
    // speaking, leaving the learner with an empty chat. The instructing path
    // exposes only the two non-advance tools (record_observation /
    // adjust_difficulty).
    const result = withThinkingDisabled(() =>
      streamText({
        model: languageModel,
        system: systemPrompt,
        messages: finalMessages,
        // SCENARIO ONLY: prep-stage turns are pure Q&A — expose NO tools so the
        // model cannot record/advance; advancing the prep stage is the sidebar
        // "enter scenario" button's job.
        ...(phase === 'instructing' && !scenarioPrepStage
          ? { tools, stopWhen: stepCountIs(MAX_INSTRUCTOR_STEPS) }
          : {}),
        ...(thinkingConfig
          ? { providerOptions: resolveThinkingProviderOptions(languageModel, thinkingConfig) }
          : {}),
        ...(signal ? { abortSignal: signal } : {}),
      }),
    );

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          // ai SDK 6.x uses `text` for the chunk content.
          const delta =
            (part as unknown as { text?: string; textDelta?: string }).text ??
            (part as unknown as { textDelta?: string }).textDelta ??
            '';
          if (delta) {
            assistantText += delta;
            yield { type: 'token', delta };
          }
          break;
        }
        case 'tool-call': {
          // Only the two non-advance teaching tools reach here
          // (record_observation / adjust_difficulty); forward them as-is.
          yield {
            type: 'tool_call',
            toolName: part.toolName,
            args: (part.input ?? {}) as Record<string, unknown>,
            toolCallId: part.toolCallId,
          };
          break;
        }
        case 'tool-result': {
          // Flush engagement / proficiency patches queued by the tool execute,
          // in server-mutation order.
          while (pendingPatches.length > 0) {
            yield pendingPatches.shift()!;
          }
          break;
        }
        case 'error': {
          const errAny = (part as unknown as { error?: unknown }).error;
          yield {
            type: 'error',
            code: 'LLM_ERROR',
            message:
              errAny instanceof Error ? errAny.message : String(errAny ?? 'unknown LLM error'),
          };
          break;
        }
        case 'finish': {
          // End-of-step. Final assistant message is committed below.
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    log.warn(`Instructor turn threw: ${err instanceof Error ? err.message : String(err)}`);
    yield {
      type: 'error',
      code: 'STREAM_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    yield { type: 'done' };
    return;
  }

  // The committed instructor message is the streamed assistant text, lightly
  // cleaned. Task-completion ready prompts are injected by the submission flow,
  // not by this chat turn.
  let lastCommittedMessageTs: string | undefined;

  // -------------------------------------------------------------------
  // Prose commit for a teaching turn.
  //
  // The empty-output fallback fires for ANY turn that showed the learner
  // nothing — a greeting /
  // setup opener that produced nothing, or an instructing turn that went silent
  // (e.g. a lone record_observation tool call) — so the client never shows a
  // blank screen with no way to retry.
  // -------------------------------------------------------------------
  const assistantCommit = cleanInstructorCommitText(assistantText, {
    ...nextInstructionTarget(project, milestone, microtask),
    stripFinalReverseQuestion:
      phase === 'setup' && !!project.scenario && milestone.scenarioStage === 'wrapup',
  });
  const shownText = assistantCommit.text;
  if (shownText.trim() && instructor) {
    lastCommittedMessageTs = new Date().toISOString();
    const assistantMsg: PBLChatMessage = {
      id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
      agentId: instructor.id,
      roleType: 'instructor',
      content: shownText,
      ts: lastCommittedMessageTs,
      microtaskId: microtask.id,
    };
    if (instructorThread) instructorThread.messages.push(assistantMsg);
    yield {
      type: 'project_patch',
      patch: { kind: 'message', message: assistantMsg },
    };
  } else if (didAdjustDifficulty && instructor) {
    // The learner asked to change difficulty and the model adjusted it via the
    // tool but wrote no text. The tier change is silent (underlying, never
    // surfaced) AND no chat patch is emitted for a no-op change, so without
    // this the learner would see nothing at all. Commit a neutral, localized,
    // tier-agnostic confirmation (it never names beginner/intermediate/advanced)
    // so the turn always has a visible reply. Only adjust_difficulty triggers
    // this — record_observation stays silent. Sits BELOW
    // the prose branch (the model's own text wins) and ABOVE the empty-output
    // fallback (so a difficulty-only turn shows the ack, not a retry error).
    lastCommittedMessageTs = new Date().toISOString();
    const ackMsg: PBLChatMessage = {
      id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
      agentId: instructor.id,
      roleType: 'instructor',
      content: difficultyAdjustAck(project.language),
      ts: lastCommittedMessageTs,
      microtaskId: microtask.id,
    };
    if (instructorThread) instructorThread.messages.push(ackMsg);
    yield {
      type: 'project_patch',
      patch: { kind: 'message', message: ackMsg },
    };
  } else if (
    shouldReportEmptyOutput({
      mainTurnAdvanced,
      assistantText: shownText,
      producedAck: didAdjustDifficulty,
    })
  ) {
    // Empty-bubble fallback: the turn produced NOTHING the learner can
    // perceive — no scenario auto-completion, no committed text, no difficulty
    // ack. Applies to greeting / setup openers and to any instructing turn
    // that went silent (for example a lone record_observation). Emitted after
    // project patches so the client, which aborts the stream on the first
    // `error` frame, never drops a later patch to a premature error.
    yield {
      type: 'error',
      code: 'EMPTY_LLM_OUTPUT',
      message: '导师本轮没有产生新的内容。请稍后再试，或者把你的问题再说得具体一些。',
    };
  }

  // -------------------------------------------------------------------
  // SCENARIO ONLY. Wrapup auto-completion (no "confirm" turn).
  //
  // The wrapup stage has nothing for the learner to do after the debrief
  // (committed by the deferred prose-commit just above). When the turn didn't
  // otherwise advance, deterministically complete its single light microtask
  // here and emit the advance checkpoint — driving the existing chain
  // (projectCompleted → shouldEvaluateFinal → final eval → completion CTA).
  // Placed AFTER the deferred commit so the debrief prose is preserved (pbl's
  // advancing-turn path discards prose). Strictly gated to a scenario wrapup
  // SETUP turn (which carries no tools, so `mainTurnAdvanced` is false here);
  // ordinary projects and all other stages are untouched.
  // -------------------------------------------------------------------
  if (
    phase === 'setup' &&
    !!project.scenario &&
    milestone.scenarioStage === 'wrapup' &&
    assistantText.trim()
  ) {
    const runtimeEventIdsBefore = new Set((project.runtimeEvents ?? []).map((event) => event.id));
    const adv = advanceMicrotaskOp(project, microtask.id, 'scenario_wrapup_complete', {});
    if (adv.ok) {
      mainTurnAdvanced = true;
      yield {
        type: 'project_patch',
        patch: buildAdvanceProjectPatch(project, {
          microtaskId: microtask.id,
          milestoneCompleted: adv.milestoneCompleted,
          projectCompleted: adv.projectCompleted,
          nextMicrotaskId: adv.nextMicrotaskId,
          shouldEvaluateTask: false,
          runtimeEventIdsBefore,
        }),
      };
    }
  }

  // -------------------------------------------------------------------
  // Optional setup follow-up within the same milestone.
  //
  // This is still a separate semantic turn (new active microtask) but
  // can be delivered in the same HTTP stream for responsiveness. To
  // avoid cross-turn confusion, the follow-up is emitted as a distinct
  // message patch (not token-merged into the previous reply), and its
  // prompt history is trimmed to remove trailing user turns.
  // Across milestones we still stop and wait for explicit Continue.
  // -------------------------------------------------------------------
  if (mainTurnAdvanced) {
    const next = currentMicrotask(project);
    const sameMilestone = next && next.milestone.id === milestone.id;
    if (next && sameMilestone) {
      log.info(`[setup-followup] opening next microtask=${next.microtask.id}.`);
      for await (const ev of runSetupFollowup({
        project,
        languageModel,
        thinkingConfig,
        instructorRole: instructor,
        signal,
      })) {
        yield ev;
      }
    }
  }

  // -------------------------------------------------------------------
  // Memory compression: keep the thread under the live-message cap
  // so the next turn's context window stays bounded. No-op when the
  // thread is still small.
  // -------------------------------------------------------------------
  if (instructorThread) {
    const compressed = compressIfNeeded(instructorThread);
    if (compressed !== instructorThread) {
      instructorThread.messages = compressed.messages;
      instructorThread.earlierSummary = compressed.earlierSummary;
    }
  }

  yield { type: 'done' };
}

// ---------------------------------------------------------------------------
// SETUP follow-up (same-milestone handoff)
// ---------------------------------------------------------------------------

interface SetupFollowupArgs {
  project: PBLProjectV2;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  instructorRole?: PBLRole;
  signal?: AbortSignal;
}

async function* runSetupFollowup(args: SetupFollowupArgs): AsyncGenerator<PBLSSEEvent, void, void> {
  const { project, languageModel, thinkingConfig, instructorRole, signal } = args;
  normalizeProjectRuntime(project);
  const current = currentMicrotask(project);
  if (!current || !instructorRole) return;
  const { milestone, microtask } = current;

  const systemPrompt = buildSystemPrompt({
    project,
    milestone,
    microtask,
    instructor: instructorRole,
    phase: 'setup',
  });

  const instructorThread = project.threads.find((t) => {
    const r = project.roles.find((r) => r.id === t.agentId);
    return r?.type === 'instructor';
  });
  const historyMessages = buildSetupHistoryMessages(instructorThread);

  try {
    const result = withThinkingDisabled(() =>
      streamText({
        model: languageModel,
        system: systemPrompt,
        messages: [
          ...historyMessages,
          {
            role: 'user' as const,
            content: syntheticPlatformOpener('setup', project.language),
          },
        ],
        ...(thinkingConfig
          ? { providerOptions: resolveThinkingProviderOptions(languageModel, thinkingConfig) }
          : {}),
        ...(signal ? { abortSignal: signal } : {}),
      }),
    );

    let rawAssistantText = '';
    let emittedPreview = '';
    let finalCleanedChanged = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          const delta =
            (part as unknown as { text?: string; textDelta?: string }).text ??
            (part as unknown as { textDelta?: string }).textDelta ??
            '';
          if (!delta) break;
          rawAssistantText += delta;
          const cleaned = cleanSetupFollowupText(rawAssistantText);
          finalCleanedChanged = cleaned.changed;
          const preview = cleaned.text;
          if (shouldHoldSetupFollowupPreview(rawAssistantText, cleaned)) break;
          if (preview.startsWith(emittedPreview) && preview.length > emittedPreview.length) {
            const safeDelta = preview.slice(emittedPreview.length);
            emittedPreview = preview;
            yield { type: 'token', delta: safeDelta };
          }
          break;
        }
        case 'error': {
          const errAny = (part as unknown as { error?: unknown }).error;
          yield {
            type: 'error',
            code: 'LLM_ERROR',
            message:
              errAny instanceof Error ? errAny.message : String(errAny ?? 'unknown LLM error'),
          };
          break;
        }
        default:
          break;
      }
    }

    const cleaned = cleanSetupFollowupText(rawAssistantText);
    finalCleanedChanged = finalCleanedChanged || cleaned.changed;
    const assistantText = cleaned.text;
    if (assistantText.startsWith(emittedPreview) && assistantText.length > emittedPreview.length) {
      yield { type: 'token', delta: assistantText.slice(emittedPreview.length) };
    }
    if (finalCleanedChanged) {
      log.info('[setup-followup] cleaned old-task recap from next-task opener.');
    }
    if (!assistantText.trim()) return;

    const assistantMsg: PBLChatMessage = {
      id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
      agentId: instructorRole.id,
      roleType: 'instructor',
      content: assistantText,
      ts: isoAfter(instructorThread?.messages.at(-1)?.ts),
      microtaskId: microtask.id,
    };
    if (instructorThread) instructorThread.messages.push(assistantMsg);
    yield {
      type: 'project_patch',
      patch: { kind: 'message', message: assistantMsg },
    };
  } catch (err) {
    log.warn(`[setup-followup] threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
