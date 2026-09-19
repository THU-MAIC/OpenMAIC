'use client';

/**
 * System notice — the quietest register on the surface, and the workbench's own
 * addition to the OpenPBL vocabulary. Everything the job says about itself
 * rather than about the course (a recovery, a queued message, a failed round)
 * lands here, and none of it should ever compete with a sentence the agent
 * wrote.
 *
 * The shape is the same for every tone — icon, summary, optional count, optional
 * hint, optional technical detail behind a disclosure — and `data-tone` decides
 * how much of a frame it gets (see `systemNotice` in `chat-styles.ts`). What it
 * is deliberately NOT: a chat bubble (this is not speech) and a paragraph of red
 * text with a provider error string in it (that is a log line).
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ChatNode } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { presentSystemNotice, repeatLabel, repeatTitle } from './system-notice';

const TONE_ICON = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
} as const;

export function SystemNode({
  node,
  repeat = 1,
  t = defaultWorkbenchTranslator,
}: {
  node: ChatNode;
  repeat?: number;
  t?: WorkbenchTranslator;
}) {
  const notice = presentSystemNotice(node, t);
  const [open, setOpen] = useState(false);
  // `stopped` is the centered caption's tone and never reaches this component;
  // fall back to the neutral icon rather than rendering nothing.
  const tone = notice.tone === 'stopped' ? 'info' : notice.tone;
  const Icon = TONE_ICON[tone];

  return (
    <div
      className={styles.systemNotice.row}
      data-tone={tone}
      data-testid="workbench-system-node"
      data-repeat={repeat > 1 ? repeat : undefined}
    >
      <span className={styles.systemNotice.icon} data-tone={tone} aria-hidden="true">
        <Icon size={13} />
      </span>
      <div className={styles.systemNotice.body}>
        <div className={styles.systemNotice.head}>
          <p
            className={styles.systemNotice.text}
            data-tone={tone}
            role={tone === 'error' ? 'alert' : undefined}
          >
            {notice.summary}
          </p>
          {repeat > 1 ? (
            <span
              className={styles.systemNotice.count}
              data-tone={tone}
              data-testid="workbench-system-repeat"
              title={repeatTitle(repeat, t)}
              aria-label={repeatTitle(repeat, t)}
            >
              {repeatLabel(repeat)}
            </span>
          ) : null}
        </div>
        {notice.hint ? <p className={styles.systemNotice.hint}>{notice.hint}</p> : null}
        {notice.detail ? (
          <>
            <button
              type="button"
              className={styles.systemNotice.disclosure}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <span aria-hidden="true">
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </span>
              <span>{t('workbench.system.technicalDetails')}</span>
            </button>
            {open ? (
              <pre className={styles.systemNotice.detail} data-testid="workbench-system-detail">
                {notice.detail}
              </pre>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
