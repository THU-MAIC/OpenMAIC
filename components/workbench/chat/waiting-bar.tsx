'use client';

/**
 * Pre-token loading — three pulsing dots. OpenPBL keeps this separate from
 * the thinking bar: no "thinking" label, no brain icon, no fabricated thought.
 * The fold opens it on session start / user message / message start / tool
 * end, and removes it the moment the first real part arrives.
 */
import { wbStyles as styles } from './chat-styles';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

export function WaitingBar({
  t = defaultWorkbenchTranslator,
}: {
  t?: WorkbenchTranslator;
} = {}) {
  return (
    <span
      className={styles.waiting.root}
      role="status"
      aria-label={t('workbench.chat.waiting')}
      data-testid="workbench-waiting-bar"
    >
      <span className={styles.waiting.dots} aria-hidden="true">
        <i className={styles.waiting.dot} />
        <i className={styles.waiting.dotDelayOne} />
        <i className={styles.waiting.dotDelayTwo} />
      </span>
    </span>
  );
}
