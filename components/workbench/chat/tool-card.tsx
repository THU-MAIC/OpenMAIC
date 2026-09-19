'use client';

/**
 * Tool call card — the OpenPBL/kimi ToolRow shape fed by the presentation
 * rule table (`tool-presentation.ts`): the collapsed row is a human sentence
 * built from the tool's structured `details`, and the raw wire format lives
 * behind the disclosure. Tool output is rendered as text, never as markdown.
 *
 * PR5 ("harness in harness"):
 *
 *  - The head is ONE flex line: the summary truncates, chips never wrap to
 *    their own row (a long title used to shove the type chip onto a second
 *    line, doubling the card's height mid-stream).
 *  - Live traces stay behind the disclosure. The collapsed row already
 *     carries the human summary; repeating raw `onTrace` lines underneath
 *     is redundant.
 *  - A failed card shows its error sentence on the collapsed row (via
 *    `errorLine`, which clips at a word boundary).
 */
import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { skillLabelForId, useAgentSkills } from '@/lib/workbench/agent-skills';
import { wbStyles as styles } from './chat-styles';
import { formatDurationBetween } from './format';
import { formatToolPayload, isSkillLoadTool, presentTool } from './tool-presentation';
import { deriveToolProgress, progressLine } from './tool-progress';

export type ToolStackPosition = 'single' | 'first' | 'middle' | 'last';

/** Chips the collapsed row shows before "+N"; the rest wait for the disclosure. */
const INLINE_CHIPS_MAX = 2;

export function ToolCard({
  node,
  plan = [],
  stackPosition = 'single',
  t = defaultWorkbenchTranslator,
}: {
  node: ChatNode;
  plan?: PlannedPage[];
  stackPosition?: ToolStackPosition;
  t?: WorkbenchTranslator;
}) {
  const presentation = presentTool(node, plan, t);
  const skillLoad = isSkillLoadTool(node);
  const [open, setOpen] = useState(false);
  // A skill load's subject is the skill's id, which is the only thing the
  // transcript records. The copy map (and, for a user Skill, the installed
  // registry) turns it into display name + the English id — the same pairing the
  // composer's picker and chip show — and falls back to the bare id for a skill
  // that has neither.
  const { skills } = useAgentSkills();

  const details =
    node.toolDetails && typeof node.toolDetails === 'object' && !Array.isArray(node.toolDetails)
      ? (node.toolDetails as Record<string, unknown>)
      : {};
  const createdSkillId =
    node.toolName === 'create_skill' && typeof details.skillId === 'string'
      ? details.skillId
      : undefined;
  const [loadedSkillContent, setLoadedSkillContent] = useState<string>();
  const [skillContentLoading, setSkillContentLoading] = useState(false);
  const [skillContentError, setSkillContentError] = useState(false);

  const argsText = presentation.hidePayload
    ? ''
    : node.toolArgs
      ? formatToolPayload(node.toolArgs)
      : '';
  const persistedResultText = node.toolResultCopyKey
    ? t(node.toolResultCopyKey)
    : (node.toolResultText ?? '');
  const skillResultText =
    presentation.expandedResultText ??
    loadedSkillContent ??
    (skillContentLoading
      ? [persistedResultText, t('workbench.common.loading')].filter(Boolean).join('\n\n')
      : skillContentError
        ? [persistedResultText, t('workbench.skill.contentLoadFailed')].filter(Boolean).join('\n\n')
        : persistedResultText);
  const rawResultText = presentation.hidePayload
    ? ''
    : node.toolName === 'create_skill'
      ? skillResultText
      : persistedResultText;
  const resultText = node.toolResultTruncated
    ? `${rawResultText}\n… (${t('workbench.tool.section.truncated')})`
    : rawResultText;
  const traces = presentation.hidePayload ? [] : (node.toolTraces ?? []);
  const failed = Boolean(presentation.errorText);
  const running = node.toolState === 'running';
  const progress = deriveToolProgress(
    {
      toolName: node.toolName,
      traces,
      running,
      failed,
    },
    t,
  );
  const hasBody = Boolean(
    argsText ||
    resultText ||
    presentation.pages ||
    (!running && traces.length > 0) ||
    (createdSkillId && !failed),
  );
  const duration = formatDurationBetween(node.toolStartedAt, node.toolEndedAt);

  // The collapsed row's one-liner: the failure sentence when failed, otherwise
  // what the verb acted on.
  const subject =
    skillLoad && presentation.subject
      ? skillLabelForId(presentation.subject, skills, t)
      : presentation.subject;
  const summary = failed ? presentation.errorText : (subject ?? presentation.detail);
  const inlineChips = presentation.chips.slice(0, INLINE_CHIPS_MAX);
  const extraChips = presentation.chips.length - inlineChips.length;

  const Icon = presentation.icon;

  const toggleOpen = () => {
    if (!hasBody) return;
    const nextOpen = !open;
    setOpen(nextOpen);
    if (
      !nextOpen ||
      !createdSkillId ||
      presentation.expandedResultText ||
      loadedSkillContent ||
      skillContentLoading
    ) {
      return;
    }
    setSkillContentLoading(true);
    setSkillContentError(false);
    void fetch(`/api/agent/skills/${encodeURIComponent(createdSkillId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`skill content request failed: ${response.status}`);
        const body = (await response.json()) as { content?: unknown };
        if (typeof body.content !== 'string') throw new Error('skill content is missing');
        setLoadedSkillContent(body.content);
      })
      .catch(() => setSkillContentError(true))
      .finally(() => setSkillContentLoading(false));
  };

  return (
    <div
      className={styles.toolCard.box}
      data-status={failed ? 'failed' : node.toolState === 'done' ? 'done' : 'running'}
      data-kind={skillLoad ? 'skill' : 'tool'}
      data-stack={stackPosition}
      data-open={open}
      data-testid={skillLoad ? 'workbench-skill-card' : 'workbench-tool-card'}
    >
      <button
        type="button"
        className={styles.toolCard.head}
        aria-expanded={open}
        disabled={!hasBody}
        onClick={toggleOpen}
      >
        {failed ? (
          <span className={styles.toolCard.status} data-status="error">
            <X size={13} />
          </span>
        ) : node.toolState === 'done' ? (
          <span className={styles.toolCard.status} data-status="ok">
            <Check size={13} />
          </span>
        ) : (
          <Loader2
            size={13}
            className="shrink-0 animate-spin text-[var(--wb-accent)] motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        <span className={styles.toolCard.icon} aria-hidden="true">
          <Icon size={13} />
        </span>
        <span className={styles.toolCard.text}>
          <span className={styles.toolCard.name}>{presentation.label}</span>
          {!open && running && progress ? (
            <span
              key={progressLine(progress)}
              className={styles.toolCard.progressTick}
              data-testid="workbench-tool-progress"
              title={summary ?? progressLine(progress)}
            >
              {progressLine(progress)}
            </span>
          ) : !open && summary ? (
            <span className={styles.toolCard.arg} title={summary}>
              {summary}
            </span>
          ) : null}
        </span>
        {!open && inlineChips.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            {inlineChips.map((chip) => (
              <span
                key={chip.label}
                className={styles.toolCard.chip}
                data-tone={chip.tone ?? 'neutral'}
              >
                {chip.label}
              </span>
            ))}
            {extraChips > 0 ? (
              <span className={styles.toolCard.chip} data-tone="neutral">
                +{extraChips}
              </span>
            ) : null}
          </span>
        ) : null}
        {duration ? <time className={styles.toolCard.time}>{duration}</time> : null}
        {hasBody ? (
          <span className={styles.toolCard.car} aria-hidden="true">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className={styles.toolCard.body}>
          {argsText ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t('workbench.tool.section.input')}
              </span>
              <pre className={styles.toolCard.payload}>{argsText}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t(failed ? 'workbench.tool.section.error' : 'workbench.tool.section.result')}
              </span>
              <div className={styles.toolCard.output} data-error={failed || undefined}>
                {resultText}
              </div>
            </div>
          ) : null}
          {presentation.pages ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t('workbench.tool.section.outline')}
              </span>
              <pre className={styles.toolCard.payload}>
                {presentation.pages.map((p) => `${p.order}. ${p.title}`).join('\n')}
              </pre>
            </div>
          ) : null}
          {!running && traces.length > 0 ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t('workbench.tool.section.process')}
              </span>
              <pre className={styles.toolCard.payload}>{traces.join('\n')}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
