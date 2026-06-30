/**
 * PBL v2 — Evaluator prompt builders.
 *
 * Pure functions that assemble the {system, user} pair the
 * evaluator agent feeds into `streamText`. Three kinds:
 *
 *   - `buildTaskEvalPrompt`      → after a microtask with submissions
 *   - `buildMilestoneEvalPrompt` → after a milestone completes
 *   - `buildFinalEvalPrompt`     → after the project completes
 *
 * The `system` half loads the matching markdown prompt
 * (`evaluator-task.md` / `-milestone.md` / `-final.md`) via the
 * shared loader, with `{{language}}` interpolated to the project's
 * resolved language. The `user` half packs the evidence: project
 * context, the specific milestone/microtask, engagement telemetry,
 * existing task evaluations, and the latest submission summary.
 *
 * The split mirrors the v1 repo's evaluator: prompt = system rules,
 * user = evidence stream. Keeping the rules in a markdown file (not
 * inlined) lets us iterate on prompt language without touching
 * TypeScript, and lets a human review the prompt by reading one file
 * end to end.
 */

import { loadPBLV2Prompt } from '../prompts/loader';
import { microtaskEngagement } from './engagement';
import { scenarioActGoalsScaffold } from './completion-stats';
import { PBL_SIMULATOR_AGENT_ID } from './progress';
import { listEvaluationsForMicrotask } from './evaluation';
import { summarizeLatestSubmissionForMicrotask } from './submission';
import type { PBLMicrotask, PBLMilestone, PBLProjectV2, PBLScenarioConfig } from '../types';

export interface EvalPromptPair {
  system: string;
  user: string;
}

function resolveLanguage(project: PBLProjectV2): string {
  return project.languageDirective || project.language || 'en-US';
}

function laterMicrotasksInMilestone(milestone: PBLMilestone, task: PBLMicrotask): PBLMicrotask[] {
  const currentOrder = task.order ?? 0;
  return milestone.microtasks
    .filter((t) => t.id !== task.id && (t.order ?? 0) > currentOrder)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ---------------------------------------------------------------------------
// Task evaluation
// ---------------------------------------------------------------------------

/** Build the prompt pair for a TASK-level evaluation.
 *
 *  Caller responsibility: only invoke this when the learner has at
 *  least one submission for the task (per PR 6 D1-B decision: tasks
 *  without submissions get no LLM evaluation, just an Instructor
 *  follow-on). The function does NOT enforce that — it will still
 *  produce a usable prompt with an empty submission section, which
 *  is fine for testing. */
export function buildTaskEvalPrompt(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  task: PBLMicrotask,
  opts: { recentChatSummary?: string } = {},
): EvalPromptPair {
  const language = resolveLanguage(project);
  const system = loadPBLV2Prompt('evaluator-task', { language });

  const sections: string[] = [
    `## Project\n${project.title}\n\n${project.description}`,
    `## Milestone\n${milestone.title} — ${milestone.description ?? ''}`.trim(),
    `## Microtask just completed\n${task.title}\n${task.description ?? ''}`.trim(),
  ];
  const futureTasks = laterMicrotasksInMilestone(milestone, task);
  if (futureTasks.length) {
    sections.push(
      [
        '## Later microtasks in this milestone — exclusion boundary',
        'These are listed only so you DO NOT grade this submission against them. Do not mention these later-task requirements as missing work, score penalties, or items in `improvements` for the current task.',
        ...futureTasks.map((t) => `- ${t.title}${t.description ? ` — ${t.description}` : ''}`),
      ].join('\n'),
    );
  }
  if (task.hints?.length) {
    sections.push('## Hints that were given\n' + task.hints.map((h) => `- ${h}`).join('\n'));
  }
  const submissions = summarizeLatestSubmissionForMicrotask(project, task.id);
  if (submissions) {
    sections.push(
      [
        '## What the learner produced in the latest submission',
        'Grade this latest submission only. Earlier drafts are context, not evidence to re-score.',
        submissions,
      ].join('\n'),
    );
  }
  const previousTaskEvals = listEvaluationsForMicrotask(project, task.id)
    .filter((e) => e.kind === 'task')
    .slice(-3);
  if (previousTaskEvals.length) {
    sections.push(
      [
        '## Prior task evaluations for context only',
        'Use these only to understand revision history. Do not penalize the latest submission for issues that only appeared in older drafts.',
        ...previousTaskEvals.map((e) => {
          const score = typeof e.score === 'number' ? `${e.score}/100` : 'not scored';
          const improvements = e.improvements?.length
            ? `; prior improvements=${e.improvements.slice(0, 3).join('; ')}`
            : '';
          return `- ${e.createdAt}: score=${score}${improvements}`;
        }),
      ].join('\n'),
    );
  }
  if (opts.recentChatSummary) {
    sections.push(`## Recent conversation context\n${opts.recentChatSummary}`);
  }
  return { system, user: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Milestone evaluation — narrative reflection card
// ---------------------------------------------------------------------------

/** Build the prompt pair for a MILESTONE-level reflection card.
 *
 *  This prompt is explicitly framed as a *reflection* moment (not a
 *  judgement) and is fed real engagement telemetry. The engagement
 *  per-microtask block is the difference between generic "Great
 *  work!" feedback and feedback that actually references what the
 *  learner did — see the user's repeated requirement that milestone
 *  feedback come from data that "自然涌现" during the stage. */
export function buildMilestoneEvalPrompt(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  opts: { recentChatSummary?: string } = {},
): EvalPromptPair {
  const language = resolveLanguage(project);
  const system = loadPBLV2Prompt('evaluator-milestone', { language });

  const taskBlocks: string[] = [];
  for (const task of milestone.microtasks) {
    const bits: string[] = [`### ${task.title}`];
    if (task.description) bits.push(task.description);

    // Per-microtask telemetry from the cached snapshot first (set on
    // advance, see progress.ts), with a live recomputation as a
    // fallback. The cache exists because the engagement ledger is
    // capped (ring buffer, 500 entries) and a long project can
    // overflow — once a microtask completes we freeze its summary
    // onto `microtask.engagement` so the milestone evaluator always
    // has data even if the underlying ledger has rolled over.
    const summary = task.engagement ?? microtaskEngagement(project, task.id);
    const teleLines: string[] = [];
    if (summary.durationSeconds) {
      teleLines.push(`- time on task: ${summary.durationSeconds}s`);
    }
    if (summary.learnerTurnCount) {
      teleLines.push(`- learner messages: ${summary.learnerTurnCount}`);
    }
    if (summary.errorCount) {
      const repeats = summary.repeatErrorCount ? `, ${summary.repeatErrorCount} repeated` : '';
      const sigs = summary.errorSignatures?.slice(0, 5).join(', ') || '—';
      teleLines.push(`- errors seen: ${summary.errorCount}${repeats} (signatures: ${sigs})`);
    }
    if (summary.conceptsUnlocked?.length) {
      teleLines.push('- concepts unlocked: ' + summary.conceptsUnlocked.slice(0, 6).join(', '));
    }
    if (summary.struggles?.length) {
      teleLines.push('- struggle notes: ' + summary.struggles.slice(0, 3).join(' | '));
    }
    if (summary.questionsRaised) {
      teleLines.push(`- learner questions raised: ${summary.questionsRaised}`);
    }
    if (summary.closingQuality) {
      const cq = summary.closingQuality;
      let ans = (summary.closingAnswer ?? '').trim();
      if (ans.length > 140) ans = ans.slice(0, 140) + '…';
      teleLines.push(`- closing check: quality=${cq}, answer="${ans}"`);
    }
    if (teleLines.length) {
      bits.push('Engagement signals:\n' + teleLines.join('\n'));
    }

    // Per-task LLM evaluation recap (only present if D1-B fired —
    // i.e. the learner submitted something on this task). Useful as
    // secondary signal alongside raw engagement events.
    const evs = listEvaluationsForMicrotask(project, task.id).filter((e) => e.kind === 'task');
    if (evs.length) {
      const last = evs[evs.length - 1];
      const extras: string[] = [];
      if (last.strengths.length) {
        extras.push('strengths=' + last.strengths.slice(0, 3).join('; '));
      }
      if (last.improvements.length) {
        extras.push('growth-edges=' + last.improvements.slice(0, 3).join('; '));
      }
      if (extras.length) bits.push('Task eval recap: ' + extras.join(' · '));
    }
    taskBlocks.push(bits.join('\n'));
  }

  const sections: string[] = [
    `## Project\n${project.title}\n\n${project.description}`,
    `## Milestone just completed\n${milestone.title}\n${milestone.description ?? ''}`.trim(),
    '## How the stage went — per microtask\n\n' + taskBlocks.join('\n\n'),
  ];
  if (opts.recentChatSummary) {
    sections.push(`## Recent conversation context\n${opts.recentChatSummary}`);
  }
  return { system, user: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Final evaluation — completion report
// ---------------------------------------------------------------------------

/** Compute project-level analytics rollup for the final-eval prompt.
 *  Aggregates per-milestone engagement summaries so the LLM has
 *  structured factual evidence to draw on, instead of inventing
 *  generic "great work" prose. */
export function formatProjectEngagementRollup(project: PBLProjectV2): string {
  // Per-milestone aggregation
  type MilestoneRollup = {
    title: string;
    status: string;
    microtaskCount: number;
    microtasksCompleted: number;
    durationSeconds: number;
    learnerTurnCount: number;
    errorCount: number;
    repeatErrorCount: number;
    conceptsUnlocked: string[];
  };
  const msRollups: MilestoneRollup[] = [];
  let totalDuration = 0;
  let totalLearnerTurns = 0;
  let totalErrors = 0;
  let totalRepeatErrors = 0;
  let totalMicrotasksCompleted = 0;
  let totalMilestonesCompleted = 0;
  const allConcepts = new Set<string>();
  const closingHisto: Record<string, number> = { weak: 0, ok: 0, strong: 0 };

  for (const ms of project.milestones) {
    let msDuration = 0;
    let msTurns = 0;
    let msErrors = 0;
    let msRepeatErrors = 0;
    let msCompleted = 0;
    const msConcepts = new Set<string>();
    for (const t of ms.microtasks) {
      const s = t.engagement ?? microtaskEngagement(project, t.id);
      msDuration += s.durationSeconds ?? 0;
      msTurns += s.learnerTurnCount ?? 0;
      msErrors += s.errorCount ?? 0;
      msRepeatErrors += s.repeatErrorCount ?? 0;
      if (t.status === 'completed') msCompleted++;
      for (const c of s.conceptsUnlocked ?? []) {
        msConcepts.add(c);
        allConcepts.add(c);
      }
      if (s.closingQuality && s.closingQuality in closingHisto) {
        closingHisto[s.closingQuality]++;
      }
    }
    if (ms.status === 'completed') totalMilestonesCompleted++;
    totalDuration += msDuration;
    totalLearnerTurns += msTurns;
    totalErrors += msErrors;
    totalRepeatErrors += msRepeatErrors;
    totalMicrotasksCompleted += msCompleted;
    msRollups.push({
      title: ms.title,
      status: ms.status,
      microtaskCount: ms.microtasks.length,
      microtasksCompleted: msCompleted,
      durationSeconds: msDuration,
      learnerTurnCount: msTurns,
      errorCount: msErrors,
      repeatErrorCount: msRepeatErrors,
      conceptsUnlocked: Array.from(msConcepts),
    });
  }
  const selfRecoveredErrors = Math.max(0, totalErrors - totalRepeatErrors);

  const msLines = msRollups.map((ms) => {
    const dMin = Math.round(ms.durationSeconds / 60);
    const conceptsPreview = ms.conceptsUnlocked.slice(0, 6).join(', ') || '(none recorded)';
    return (
      `- ${ms.title} [${ms.status}] · ` +
      `${ms.microtasksCompleted}/${ms.microtaskCount} tasks · ` +
      `~${dMin} min · ` +
      `${ms.learnerTurnCount} learner turns · ` +
      `${ms.errorCount} errors (${ms.repeatErrorCount} repeats) · ` +
      `concepts: ${conceptsPreview}`
    );
  });
  const totalMin = Math.round(totalDuration / 60);
  const conceptsPreview = Array.from(allConcepts).slice(0, 12).join(', ') || '(none recorded)';

  return (
    `### Project totals\n` +
    `- Wall time: ~${totalMin} min\n` +
    `- Learner turns: ${totalLearnerTurns}\n` +
    `- Microtasks completed: ${totalMicrotasksCompleted}\n` +
    `- Milestones completed: ${totalMilestonesCompleted}\n` +
    `- Errors hit: ${totalErrors} (self-recovered: ${selfRecoveredErrors}, repeats: ${totalRepeatErrors})\n` +
    `- Closing-check quality: weak=${closingHisto.weak}, ok=${closingHisto.ok}, strong=${closingHisto.strong}\n` +
    `- Distinct concepts unlocked (${allConcepts.size}): ${conceptsPreview}\n\n` +
    `### Per-milestone\n` +
    msLines.join('\n')
  );
}

function promptText(value: unknown, maxLength = 700): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

function lastMicrotaskInMilestone(milestone: PBLMilestone): PBLMicrotask | undefined {
  return milestone.microtasks.slice().sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0];
}

/** Render the learner's optional integrative stage-check answers for
 *  the final report evaluator. These are not part of task readiness;
 *  they are completion-report evidence so the report can acknowledge
 *  whole-stage synthesis when it happened. */
export function formatProjectSynthesisChecks(project: PBLProjectV2): string {
  const coreMilestones = project.milestones.filter((ms) => !!ms.synthesisCheck);
  if (coreMilestones.length === 0) return '(no integrative checks configured)';

  const lines: string[] = [];
  for (const ms of coreMilestones) {
    const microtaskIds = new Set(ms.microtasks.map((t) => t.id));
    const stageEvent = project.engagementEvents
      .filter(
        (ev) =>
          ev.kind === 'stage_synthesis_check' &&
          (ev.milestoneId === ms.id || (!!ev.microtaskId && microtaskIds.has(ev.microtaskId))),
      )
      .at(-1);

    const lastTask = lastMicrotaskInMilestone(ms);
    const fallbackClosingEvent =
      !stageEvent && lastTask
        ? project.engagementEvents
            .filter((ev) => ev.kind === 'closing_check' && ev.microtaskId === lastTask.id)
            .at(-1)
        : undefined;
    const cachedClosing =
      !stageEvent && !fallbackClosingEvent && lastTask?.engagement?.closingAnswer
        ? lastTask.engagement
        : undefined;

    const coreConcept =
      promptText(stageEvent?.payload?.coreConcept, 240) ||
      promptText(ms.synthesisCheck?.coreConcept, 240) ||
      '(not specified)';
    const question =
      promptText(stageEvent?.payload?.question) ||
      promptText(fallbackClosingEvent?.payload?.question) ||
      promptText(cachedClosing?.closingQuestion);
    const learnerAnswer =
      promptText(stageEvent?.payload?.learner_answer) ||
      promptText(fallbackClosingEvent?.payload?.learner_answer) ||
      promptText(cachedClosing?.closingAnswer);
    const quality =
      promptText(stageEvent?.payload?.quality, 40) ||
      promptText(fallbackClosingEvent?.payload?.quality, 40) ||
      promptText(cachedClosing?.closingQuality, 40);

    if (!learnerAnswer) {
      lines.push(`- ${ms.title} · core concept: ${coreConcept} · no learner answer recorded`);
      continue;
    }

    lines.push(
      [
        `- ${ms.title} · core concept: ${coreConcept}`,
        question ? `  question: ${question}` : '',
        `  learner answer: ${learnerAnswer}`,
        quality ? `  quality: ${quality}` : '',
        `  source: ${
          stageEvent
            ? 'stage_synthesis_check'
            : fallbackClosingEvent
              ? 'closing_check on final microtask'
              : 'cached final-microtask engagement'
        }`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scenario (role-play) final evaluation — SCENARIO ONLY
// ---------------------------------------------------------------------------

/** Max characters of the role-play transcript fed to the final evaluator
 *  (keeps the prompt bounded; we keep the TAIL — the most recent exchanges). */
const SCENARIO_TRANSCRIPT_BUDGET = 6000;

/** Render the role-play transcript (the Simulator thread) for the evaluator:
 *  neutral narration, character lines (by name), and the learner's lines.
 *  Exported so the wrapup Instructor can ground its debrief in what the learner
 *  ACTUALLY said/did (not just scored decisions). */
export function formatScenarioTranscript(project: PBLProjectV2): string {
  const thread = project.threads.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID);
  const messages = thread?.messages ?? [];
  if (messages.length === 0) return '(no role-play conversation recorded)';
  const nameOf = (characterId?: string) =>
    project.scenario?.characters?.find((c) => c.id === characterId)?.name ?? 'Character';
  const lines = messages
    .filter((m) => m.content?.trim())
    .map((m) => {
      if (m.roleType === 'system') return `[narration] ${m.content.trim()}`;
      if (m.roleType === 'user') return `Learner: ${m.content.trim()}`;
      if (m.roleType === 'simulator') return `${nameOf(m.characterId)}: ${m.content.trim()}`;
      return null;
    })
    .filter((l): l is string => !!l);
  let text = lines.join('\n');
  if (text.length > SCENARIO_TRANSCRIPT_BUDGET) {
    text = '…(earlier exchanges trimmed)…\n' + text.slice(text.length - SCENARIO_TRANSCRIPT_BUDGET);
  }
  return text;
}

/** SCENARIO ONLY. The user-evidence half for a role-play completion report:
 *  the scenario premise, the actual transcript, the act goals to assess, and a
 *  light engagement total — framed for SKILL feedback, not knowledge recap. */
function buildScenarioFinalUser(project: PBLProjectV2, sc: PBLScenarioConfig): string {
  const cast = (sc.characters ?? []).map((c) => `${c.name} (${c.persona})`).join('; ') || '(none)';
  const ctx = [
    `Setting: ${sc.setting}`,
    sc.goal ? `Skill being practised: ${sc.goal}` : '',
    sc.rules ? `Rules: ${sc.rules}` : '',
    sc.learnerRole ? `The learner's role: ${sc.learnerRole}` : '',
    `Character(s) they interacted with: ${cast}`,
  ]
    .filter(Boolean)
    .join('\n');

  // ACT MODEL: a roleplay act is one continuous scene the learner ends
  // manually, so every beat is marked completed on finish — "beats done" is no
  // longer a real signal. The genuine signal is whether the learner actually
  // covered each act's GOALS (the authored per-beat `successWhen`), judged from
  // the transcript. We list them per act FROM THE SHARED SCAFFOLD (single
  // source of truth in completion-stats), tagged with milestoneId + goal index,
  // so the model can both (a) assess coverage in prose AND (b) return a
  // structured `act_goals` verdict that `normalizeActGoals` overlays back onto
  // the very same scaffold. This drives the "what you accomplished" credit and
  // the completion page's per-act review — never progression.
  const scaffold = scenarioActGoalsScaffold(project);
  const checklistLines: string[] = [];
  for (const act of scaffold) {
    checklistLines.push(`### Act (milestoneId: ${act.milestoneId}): ${act.actTitle}`);
    act.goals.forEach((g, i) => {
      const skill = g.skillFocus ? ` [skill: ${g.skillFocus}]` : '';
      // Tag each goal with its goalIndex — the model MUST echo this index back
      // in `act_goals[].goals[].goalIndex` so the verdict is aligned by index,
      // never by array position (guards against same-act goal reordering).
      checklistLines.push(`- goalIndex ${i}: ${g.goal}${skill}`);
    });
  }
  const checklist =
    checklistLines.length > 0
      ? checklistLines.join('\n')
      : '(this scenario authored no explicit goals — judge holistically from the transcript)';

  // Light engagement totals (turns / minutes) across roleplay.
  let turns = 0;
  let durationSeconds = 0;
  for (const ms of project.milestones) {
    if (ms.scenarioStage !== 'roleplay') continue;
    for (const t of ms.microtasks) {
      const s = t.engagement ?? microtaskEngagement(project, t.id);
      turns += s.learnerTurnCount ?? 0;
      durationSeconds += s.durationSeconds ?? 0;
    }
  }
  const engagement = `learner turns: ${turns} · ~${Math.round(durationSeconds / 60)} min`;

  return [
    `## The scenario\n${ctx}`,
    `## How it actually went (role-play transcript)\n${formatScenarioTranscript(project)}`,
    `## The act goals to assess (for each, judge from the transcript whether the learner covered it — see act_goals in the output)\n${checklist}`,
    `## Engagement\n${engagement}`,
  ].join('\n\n');
}

/** Build the prompt pair for the FINAL completion report.
 *
 *  Grounding strategy: feed BOTH the per-milestone narrative
 *  evaluations AND the analytics rollup so the LLM has structured,
 *  factual evidence. Without the rollup the LLM defaults to generic
 *  "great job, you learned a lot" — we want it to reference real
 *  moments.
 *
 *  SCENARIO ONLY: role-play projects are SKILL practice, not knowledge
 *  building — their per-milestone reflection cards and concept rollup are
 *  empty/meaningless. They get a dedicated prompt + skill-oriented evidence
 *  (premise + transcript + decisions). Ordinary projects are byte-identical
 *  to before. */
export function buildFinalEvalPrompt(
  project: PBLProjectV2,
  opts: { recentChatSummary?: string } = {},
): EvalPromptPair {
  const language = resolveLanguage(project);

  if (project.scenario) {
    const system = loadPBLV2Prompt('evaluator-final-scenario', { language });
    const sections = [
      `## Project\n${project.title}\n\n${project.description}`,
      buildScenarioFinalUser(project, project.scenario),
    ];
    if (opts.recentChatSummary) {
      sections.push(`## Recent conversation context\n${opts.recentChatSummary}`);
    }
    return { system, user: sections.join('\n\n') };
  }

  const system = loadPBLV2Prompt('evaluator-final', { language });

  // Milestone narrative recap — pull prose + key signals so the
  // closing arc can echo them. Use the milestone evaluation's prose,
  // NOT just its strengths list — the narrative captures the human
  // moments we want the final card to reflect back.
  const msSummaries: string[] = [];
  for (const ms of project.milestones) {
    const evs = project.evaluations.filter(
      (e) => e.kind === 'milestone' && e.milestoneId === ms.id,
    );
    if (evs.length) {
      const last = evs[evs.length - 1];
      const learned = last.strengths.slice(0, 4).join(', ') || '(no bullets)';
      const starsStr = typeof last.stars === 'number' ? `${last.stars}★` : '(unrated)';
      const prose =
        (last.feedback ?? '').slice(0, 280).trim() +
        ((last.feedback ?? '').length > 280 ? '…' : '');
      msSummaries.push(`- ${ms.title} [${starsStr}]\n  learned: ${learned}\n  prose: ${prose}`);
    } else {
      msSummaries.push(`- ${ms.title}: (no milestone evaluation recorded)`);
    }
  }

  const sections = [
    `## Project\n${project.title}\n\n${project.description}`,
    `## Per-milestone reflection cards\n${msSummaries.join('\n')}`,
    `## Engagement rollup (from the analytics ledger)\n${formatProjectEngagementRollup(project)}`,
    `## Integrative checks (stage synthesis)\n${formatProjectSynthesisChecks(project)}`,
  ];
  if (opts.recentChatSummary) {
    sections.push(`## Recent conversation context\n${opts.recentChatSummary}`);
  }
  return { system, user: sections.join('\n\n') };
}
