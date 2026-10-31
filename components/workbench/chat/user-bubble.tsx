'use client';

/**
 * User bubble — a soft violet fill with ink text and a tightened trailing
 * corner. Right alignment is the whole authorship signal; there is no avatar
 * and no name.
 */
import { BookOpen, Paperclip } from 'lucide-react';
import type { ElementRef } from '@/lib/workbench/element-refs';
import type { CourseRef } from '@/lib/workbench/course-refs';
import { segmentMentions } from '@/lib/workbench/composer-mentions';
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

export function UserBubble({
  text,
  materials = [],
  elementRefs = [],
  courseRefs = [],
}: {
  text: string;
  materials?: string[];
  elementRefs?: readonly ElementRef[];
  courseRefs?: readonly CourseRef[];
}) {
  // A course or material named in the sentence (`@name`, as the composer
  // writes a mention out) is shown there, highlighted; only one the text does
  // not name keeps its chip below.
  const named = (name: string) => !!name && text.includes(`@${name}`);
  const inlineNames = [
    ...courseRefs.filter((ref) => named(ref.title)).map((ref) => `@${ref.title}`),
    ...materials.filter(named).map((name) => `@${name}`),
  ];
  const chipCourses = courseRefs.filter((ref) => !named(ref.title));
  const chipMaterials = materials.filter((name) => !named(name));
  return (
    <div className={styles.userBubble.row}>
      <div className={styles.userBubble.bubble}>
        {text ? (
          <div>
            {segmentMentions(text, inlineNames).map((run, index) =>
              run.mention ? (
                <span
                  key={index}
                  data-testid="user-bubble-mention"
                  className={styles.userBubble.mention}
                >
                  {run.text}
                </span>
              ) : (
                <span key={index}>{run.text}</span>
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
