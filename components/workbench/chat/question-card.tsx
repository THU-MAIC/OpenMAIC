'use client';

/**
 * The question card — `ask_user` in the transcript.
 *
 * The agent hit a decision the user must own (which plan, which roster, which
 * option), called `ask_user`, and the run ENDED on it. This card is that moment
 * as a timeline row: it stays in the transcript forever, and once answered it is
 * the quiet record of what was asked and what was on offer.
 *
 * While the question is UNANSWERED the composer below turns into the answer form
 * for it (`question-form.tsx`), because a row at the bottom of a long transcript
 * is a question the user can scroll past. Same node, same rules
 * (`useQuestionAnswer`), different geometry: chips here, a questionnaire there.
 * If the user waves that form off, this card is where the question still lives —
 * its options stay clickable, and `onRevive` brings the form back.
 *
 * The two are MUTUALLY EXCLUSIVE, and the form wins: while it owns the composer,
 * this card collapses to one quiet line (`collapsed`) that says where the answer
 * goes. Both surfaces render the same folded node, so showing both in full meant
 * the same four-paragraph question twice on one screen, the second copy offering
 * a set of buttons that duplicated the form's rows.
 *
 * Two shapes, decided entirely by the folded envelope (see `questionMode`): an
 * OPEN question is just the question — it points nowhere, because the composer
 * IS the form while it waits and there is nothing to explain when it is not; a
 * SINGLE choice sends the clicked option's label; MULTI toggles and confirm sends the
 * picked labels as one message.
 * All of them travel the host's own send path, so the answer arrives as an
 * ordinary user message with the ordinary optimistic state — the entire answer
 * protocol `ask_user` has (no correlation id; see `LIFECYCLE.userQuestion`).
 *
 * "Answered" is therefore a fold-derived fact, not a local flag: any user
 * message below the card retires it. A replayed transcript paints its historical
 * questions as settled instead of offering buttons for decisions made an hour
 * ago, and the same holds one second after a click, because the click's own
 * bubble is what flips the flag.
 */
import { Check, HelpCircle } from 'lucide-react';
import type { ChatNode } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { useQuestionAnswer } from './question-card-state';

/** What the surfaces say about whose move it is. */
export const QUESTION_WAITING_LABEL = defaultWorkbenchTranslator('workbench.question.waiting');
export const QUESTION_ANSWERED_LABEL = defaultWorkbenchTranslator('workbench.question.answered');
/** The way back to the composer form, on the one card whose form was waved off. */
export const QUESTION_REVIVE_LABEL = defaultWorkbenchTranslator('workbench.question.revive');

export function QuestionCard({
  node,
  onAnswer,
  onRevive,
  collapsed = false,
  t = defaultWorkbenchTranslator,
}: {
  readonly node: ChatNode;
  /**
   * Send the answer as a user message. Resolves false when the send failed, so
   * the card comes back to life instead of staying dead behind a toast; the
   * success path needs no reply — the message's own event retires the card.
   *
   * Absent when the host has no send path at all (a read-only transcript).
   */
  readonly onAnswer?: (text: string) => Promise<boolean>;
  /**
   * Present only while this question's composer form is dismissed: take the
   * composer back over with it. The card never knows about that state itself —
   * the host hands it this callback or nothing.
   */
  readonly onRevive?: () => void;
  /**
   * This question's form currently owns the composer, so the row is the pointer
   * to it and nothing more. Never true together with `onRevive`: one means the
   * form is up, the other means it was waved off.
   */
  readonly collapsed?: boolean;
  readonly t?: WorkbenchTranslator;
}) {
  const answer = useQuestionAnswer(node, onAnswer, t);
  const { answered, locked, hint, mode, options } = answer;
  // The footer only exists when something is in it: confirm for a multi-select,
  // the way back to a dismissed form, or the one hint that still has work to do.
  const footer = !answered && (mode === 'multi' || Boolean(onRevive) || Boolean(hint));
  // An answered question is a record, so it never collapses: the form is gone by
  // then and this row is the only place the question survives.
  const summaryOnly = collapsed && !answered;

  return (
    <div
      className={summaryOnly ? styles.questionCard.summaryBox : styles.questionCard.box}
      data-testid="workbench-question-card"
      data-answered={answered ? 'true' : 'false'}
      data-collapsed={summaryOnly ? 'true' : 'false'}
      data-mode={mode}
    >
      <div className={styles.questionCard.head}>
        {answered ? (
          <Check className={styles.questionCard.glyph} aria-hidden="true" />
        ) : (
          <HelpCircle className={styles.questionCard.glyph} aria-hidden="true" />
        )}
        <span>{t(answered ? 'workbench.question.answered' : 'workbench.question.waiting')}</span>
        {summaryOnly ? (
          <span className={styles.questionCard.summaryPointer}>
            {t('workbench.question.inFormBelow')}
          </span>
        ) : null}
      </div>
      {summaryOnly ? null : <p className={styles.questionCard.question}>{node.text}</p>}
      {options.length > 0 && !summaryOnly ? (
        <div className={styles.questionCard.options} role="group" aria-label={node.text}>
          {options.map((option) => {
            const isPicked = answer.isPicked(option.id);
            return (
              <button
                key={option.id}
                type="button"
                data-testid={`workbench-question-option-${option.id}`}
                data-picked={isPicked ? 'true' : 'false'}
                aria-pressed={mode === 'multi' ? isPicked : undefined}
                disabled={locked}
                className={styles.questionCard.option}
                onClick={() => {
                  if (mode === 'multi') answer.toggle(option.id);
                  else answer.answerWith(option.label);
                }}
              >
                {isPicked ? (
                  <Check className={styles.questionCard.optionCheck} aria-hidden="true" />
                ) : null}
                <span className={styles.questionCard.optionLabel}>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {footer && !summaryOnly ? (
        <div className={styles.questionCard.footer}>
          {mode === 'multi' ? (
            <button
              type="button"
              data-testid="workbench-question-confirm"
              disabled={locked || answer.picked.length === 0}
              className={styles.questionCard.confirm}
              onClick={answer.confirm}
            >
              {t('workbench.question.confirm')}
            </button>
          ) : null}
          {onRevive ? (
            <button
              type="button"
              data-testid="workbench-question-revive"
              className={styles.questionCard.revive}
              onClick={onRevive}
            >
              {t('workbench.question.revive')}
            </button>
          ) : null}
          {hint ? <span className={styles.questionCard.hint}>{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
