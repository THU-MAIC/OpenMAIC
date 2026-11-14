'use client';

/**
 * User bubble — a soft violet fill with ink text and a tightened trailing
 * corner. Right alignment is the whole authorship signal; there is no avatar
 * and no name. `tone="primary"` is the solid fill of a surface with its own
 * `--primary`.
 */
import { Fragment, useMemo, type ClipboardEvent } from 'react';
import { BookOpen, Paperclip } from 'lucide-react';
import type { WorkbenchTranslator } from '@/lib/i18n/workbench';
import { useSkillChipNames } from '@/lib/workbench/use-skill-chip-names';
import { composerTextRuns, type ComposerChipSource } from '@/lib/workbench/composer-doc';
import type { ElementRef } from '@/lib/workbench/element-refs';
import type { CourseRef } from '@/lib/workbench/course-refs';
import type { InlineMention } from '@/lib/workbench/composer-mentions';
import { ComposerChip, composerMentionIcon } from '../composer-chip';
import { wbStyles as styles } from './chat-styles';

/**
 * Element references, echoed inside the sent bubble.
 *
 * Not the composer's `ElementRefPill`: on the primary fill a violet pill would
 * be a second colour fighting the bubble, and hover-to-ring belongs to a
 * selection you can still change. This is the receipt — the same ordinal and the
 * same label, rendered in the bubble's own on-primary chip skin, so "what I
 * pointed at" stays readable in the transcript weeks later.
 */
function SentElementRefs({ refs }: { refs: readonly ElementRef[] }) {
  return (
    <div className={styles.userBubble.materials}>
      {refs.map((elementRef, index) => (
        <span
          key={
            elementRef.kind === 'slide-element'
              ? `slide:${elementRef.stageId}:${elementRef.sceneId}:${elementRef.elementId}`
              : `interactive:${elementRef.stageId}:${elementRef.sceneId}:${elementRef.selector}`
          }
          data-testid="user-bubble-element-ref"
          title={
            elementRef.kind === 'slide-element'
              ? elementRef.snapshotText || elementRef.label
              : elementRef.text || elementRef.label
          }
          className={styles.userBubble.materialChip}
        >
          <span className={styles.userBubble.chipOrdinal}>{index + 1}</span>
          <span className="truncate">{elementRef.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A chip shows a name, but what was written is the handle: a copy from the bubble
 * gives the text as sent. A selection reaching outside it is left to the browser.
 */
function copyAsWritten(event: ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
  const fragment = range.cloneContents();
  for (const chip of fragment.querySelectorAll<HTMLElement>('[data-plain]')) {
    chip.replaceWith(chip.dataset.plain ?? '');
  }
  event.clipboardData.setData('text/plain', fragment.textContent ?? '');
  event.preventDefault();
}

export function UserBubble({
  text,
  materials = [],
  elementRefs = [],
  courseRefs = [],
  t,
  tone,
}: {
  text: string;
  materials?: string[];
  elementRefs?: readonly ElementRef[];
  courseRefs?: readonly CourseRef[];
  t?: WorkbenchTranslator;
  tone?: 'primary';
}) {
  const skills = useSkillChipNames(t);
  // A course or material named in the sentence (`@name`, as the composer writes
  // a mention out) is a chip there, as in the composer; only one the text does
  // not name keeps its receipt below.
  const named = (name: string) => !!name && text.includes(`@${name}`);
  const courseKey = courseRefs.map((ref) => `${ref.stageId}:${ref.title}`).join('|');
  const materialKey = materials.join('|');
  const runs = useMemo(() => {
    const mentions: [string, InlineMention][] = [
      ...courseRefs
        .filter((ref) => named(ref.title))
        .map((ref): [string, InlineMention] => [
          `@${ref.title}`,
          { label: `@${ref.title}`, kind: 'course', id: ref.stageId, name: ref.title },
        ]),
      ...materials
        .filter(named)
        .map((name): [string, InlineMention] => [
          `@${name}`,
          { label: `@${name}`, kind: 'material', id: name, name },
        ]),
    ];
    const source: ComposerChipSource = {
      skills,
      mentions: new Map(mentions),
      mentionIcon: composerMentionIcon,
    };
    return composerTextRuns(text, source);
    // The refs arrive as fresh arrays on every fold; their contents are the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, skills, courseKey, materialKey]);
  const chipCourses = courseRefs.filter((ref) => !named(ref.title));
  const chipMaterials = materials.filter((name) => !named(name));
  return (
    <div className={styles.userBubble.row}>
      <div
        className={tone === 'primary' ? styles.userBubble.bubblePrimary : styles.userBubble.bubble}
        data-tone={tone}
      >
        {text ? (
          <div onCopy={copyAsWritten}>
            {runs.map((run, index) =>
              run.chip ? (
                <ComposerChip
                  key={index}
                  chip={run.chip}
                  testId={run.chip.kind === 'skill' ? 'user-bubble-skill' : 'user-bubble-mention'}
                />
              ) : (
                <Fragment key={index}>{run.text}</Fragment>
              ),
            )}
          </div>
        ) : null}
        {chipCourses.length > 0 ? (
          // Which classroom this turn was aimed at, kept with the sentence that
          // aimed it. The title is the snapshot the message carried, not today's
          // name: the receipt has to say what the user picked, then.
          <div className={styles.userBubble.materials}>
            {chipCourses.map((courseRef) => (
              <span
                key={courseRef.stageId}
                data-testid="user-bubble-course-ref"
                title={courseRef.title}
                className={styles.userBubble.materialChip}
              >
                <BookOpen size={10} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{courseRef.title}</span>
              </span>
            ))}
          </div>
        ) : null}
        {elementRefs.length > 0 ? <SentElementRefs refs={elementRefs} /> : null}
        {chipMaterials.length > 0 ? (
          <div className={styles.userBubble.materials}>
            {chipMaterials.map((name, index) => (
              <span key={`${name}-${index}`} className={styles.userBubble.materialChip}>
                <Paperclip size={10} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
