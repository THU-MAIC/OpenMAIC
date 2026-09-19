'use client';

/**
 * The question form — `ask_user` taking over the composer.
 *
 * The agent hit a decision the user must own, called `ask_user`, and the run
 * ENDED on it. There is nothing to type into until that question is answered, so
 * the composer stops being a text box and becomes the question: same frame, same
 * place, swapped in position. (The previous shape floated a panel ABOVE the
 * composer, which asked the user to read one thing and act in another; a
 * questionnaire that owns the input area has one focus and one verb.)
 *
 * Shape, per envelope (`questionFormRows`):
 *
 *  - With options: numbered full-width rows, radio or checkbox, plus the
 *    always-last "other…" row whose inline underline box is the free-text channel.
 *    That row is why no sentence points at "the box below" any more — this IS the
 *    box below.
 *  - Without options: the title and one multi-line box. Nothing else to draw.
 *
 * The keyboard is the point (rules and their tests live in
 * `question-form-state.ts`): 1-9 confirm a row, ↑↓ move the highlight, Enter
 * confirms it, Esc gives the composer back. Every one of those is suspended while
 * the caret is in a text box, except the two that are always an escape hatch
 * (Esc, ⌘/Ctrl+Enter).
 *
 * Dismissing is not "cancel the question": the transcript card stays live and
 * clickable, and the host remembers only that this question's form was waved off
 * (see `WorkbenchChat`). Nothing about the question changes — it just stops
 * holding the composer hostage.
 */
import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { ChatNode } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { editingKindFor, questionFormKeyAction, useQuestionForm } from './question-form-state';

/** The keyboard legend, decoration only — the keys work whether or not it is read. */
export const QUESTION_FORM_KEY_HINT = defaultWorkbenchTranslator('workbench.question.keyHint');

export function QuestionForm({
  node,
  onAnswer,
  onDismiss,
  t = defaultWorkbenchTranslator,
}: {
  readonly node: ChatNode;
  /** Same contract as the card's: false means the send failed and the form revives. */
  readonly onAnswer?: (text: string) => Promise<boolean>;
  /** Give the composer back. The question stays open; only the form steps aside. */
  readonly onDismiss: () => void;
  readonly t?: WorkbenchTranslator;
}) {
  const form = useQuestionForm(node, onAnswer, t);
  const { mode, rows, locked } = form;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const otherRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef<HTMLTextAreaElement | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const otherIndex = rows.length - 1;
  const otherPicked = form.picks.otherPicked;

  // An open question has one place a keystroke can go, so focus starts there.
  useEffect(() => {
    if (mode === 'open') openRef.current?.focus();
  }, [mode]);

  /**
   * Focus follows the highlight — that is what makes ↑↓ navigation real rather
   * than a coloured border, and what puts the first option under the keyboard the
   * moment the form appears. The one exception is the selected "other" row,
   * where the thing to type into is the box, not the row.
   */
  useEffect(() => {
    if (mode === 'open') return;
    if (form.highlight >= rows.length) {
      submitRef.current?.focus();
      return;
    }
    if (form.highlight === otherIndex && otherPicked) {
      otherRef.current?.focus();
      return;
    }
    rowRefs.current[form.highlight]?.focus();
  }, [mode, form.highlight, rows.length, otherIndex, otherPicked]);

  return (
    <section
      className={styles.questionForm.box}
      data-testid="workbench-question-form"
      data-mode={mode}
      // The workbench's convention for "Escape is mine": keeps the double-Escape
      // run-stop from firing underneath the form.
      data-esc-owner=""
      aria-label={t('workbench.question.waiting')}
      onKeyDown={(event) => {
        const action = questionFormKeyAction({
          key: event.key,
          editing: editingKindFor((event.target as HTMLElement).tagName),
          modifier: event.metaKey || event.ctrlKey,
          composing: event.nativeEvent.isComposing,
          highlight: form.highlight,
          rowCount: rows.length,
        });
        if (action.type === 'none') return;
        event.preventDefault();
        event.stopPropagation();
        if (action.type === 'move') form.setHighlight(action.index);
        else if (action.type === 'activate') form.activate(action.index);
        else if (action.type === 'submit') form.submit();
        else onDismiss();
      }}
    >
      <p className={styles.questionForm.question}>{node.text}</p>

      {mode === 'open' ? (
        <textarea
          ref={openRef}
          data-testid="workbench-question-form-open"
          value={form.openText}
          onChange={(event) => form.setOpenText(event.target.value)}
          disabled={locked}
          rows={3}
          placeholder={t('workbench.question.placeholder')}
          aria-label={node.text}
          className={styles.questionForm.openInput}
        />
      ) : (
        <div
          className={styles.questionForm.rows}
          role={mode === 'multi' ? 'group' : 'radiogroup'}
          aria-label={node.text}
        >
          {rows.map((row, index) => {
            const picked = form.isPicked(index);
            const isOther = row.kind === 'other';
            return (
              <div
                key={isOther ? '__other__' : row.id}
                className={styles.questionForm.row}
                data-picked={picked ? 'true' : 'false'}
                data-highlight={index === form.highlight ? 'true' : 'false'}
              >
                <button
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  type="button"
                  role={mode === 'multi' ? 'checkbox' : 'radio'}
                  aria-checked={picked}
                  disabled={locked}
                  data-testid={
                    isOther
                      ? 'workbench-question-form-other'
                      : `workbench-question-form-option-${row.id}`
                  }
                  className={styles.questionForm.rowButton}
                  onClick={() => form.select(index)}
                  onFocus={() => form.setHighlight(index)}
                >
                  {/* Decoration: the digit shortcut it stands for is announced by
                      the keys themselves, and reading "1" before every label
                      would be noise on a screen reader. */}
                  <span className={styles.questionForm.badge} aria-hidden="true">
                    {index + 1}
                  </span>
                  <span
                    className={styles.questionForm.mark}
                    data-picked={picked ? 'true' : 'false'}
                    data-multi={mode === 'multi' ? 'true' : 'false'}
                    aria-hidden="true"
                  >
                    {picked && mode === 'multi' ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  <span className={styles.questionForm.label}>
                    {isOther ? t('workbench.question.other') : row.label}
                  </span>
                </button>
                {isOther && picked ? (
                  <input
                    ref={otherRef}
                    data-testid="workbench-question-form-other-input"
                    value={form.otherText}
                    onChange={(event) => form.setOtherText(event.target.value)}
                    disabled={locked}
                    placeholder={t('workbench.question.placeholder')}
                    aria-label={t('workbench.question.other')}
                    className={styles.questionForm.otherInput}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.questionForm.footer}>
        <button
          ref={submitRef}
          type="button"
          data-testid="workbench-question-form-submit"
          data-highlight={mode !== 'open' && form.highlight >= rows.length ? 'true' : 'false'}
          disabled={!form.canSubmit}
          className={styles.questionForm.submit}
          onClick={form.submit}
        >
          {t('workbench.question.submit')}
        </button>
        <button
          type="button"
          data-testid="workbench-question-form-dismiss"
          className={styles.questionForm.dismiss}
          onClick={onDismiss}
        >
          {t('workbench.question.dismiss')}
        </button>
        <span className={styles.questionForm.keys} aria-hidden="true">
          {t('workbench.question.keyHint')}
        </span>
      </div>
    </section>
  );
}
