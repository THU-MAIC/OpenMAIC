'use client';

/**
 * Assistant Markdown renderer for the workbench chat.
 *
 * Streamdown owns the parse and render; four things are added:
 *
 *  - KaTeX math through Streamdown's stable math plugin configuration, with a
 *    same-parser guard that keeps ordinary currency and shell dollars literal.
 *  - `remark-cjk-friendly` BEFORE `remark-gfm`, because CommonMark's emphasis
 *    flanking rules misfire next to fullwidth CJK punctuation — e.g. `**smart**`
 *    quotes otherwise reach the user with their asterisks on (the spike's S10
 *    lesson). Streamdown's `remarkPlugins` prop REPLACES its defaults, so the
 *    defaults (`gfm`, `codeMeta`) are re-spread explicitly after the CJK plugin.
 *  - the `.wb-prose` skin (see `workbench-chat.css`), which styles Streamdown's
 *    `data-streamdown` node contract rather than its Tailwind class names.
 *  - an anchor override, so a link the agent writes to a course becomes the
 *    INLINE form of `CourseLink` — a link in the sentence — and the course's
 *    card stands right under the block (paragraph, list, quote) that first
 *    named it: one card per course per answer, none for a course the answer's
 *    tail already cards (`segmentCourseMentions`). Only hrefs that name a
 *    course are upgraded (`/classroom/<id>`, `?course=<id>`); every other link
 *    renders exactly as it did before, and outside `/workspace` — where there
 *    is no right pane — the link falls back to the plain anchor and no card
 *    is drawn.
 */
import { Fragment, useMemo } from 'react';
import { Streamdown, defaultRemarkPlugins, parseMarkdownIntoBlocks } from 'streamdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { createSafeMathPlugin } from '@/lib/markdown/safe-math-plugin';
import { courseIdFromHref, segmentCourseMentions } from '@/lib/workbench/course-link';
import { useWorkbenchCourseNavigation } from '@/lib/workbench/panel-context';
import { remarkSelectiveSingleDollarMath } from '@/lib/workbench/markdown-math';
import { wbStyles as styles } from './chat-styles';
import { CourseLink } from './course-link';

const REMARK_PLUGINS = [
  remarkCjkFriendly,
  remarkSelectiveSingleDollarMath,
  ...Object.values(defaultRemarkPlugins),
];

const STREAMDOWN_PLUGINS = {
  // The official tokenizer handles `$$`; the Workbench extension validates
  // single-dollar candidates before accepting them as math. KaTeX runs with
  // the hardened options (formula-defined macros disabled).
  math: createSafeMathPlugin({ singleDollarTextMath: false }),
} as const;

// remark-math already accepts an unterminated flow fence through EOF. Generic
// dollar completion can instead turn a delimiter inside fenced code into math.
const REMEND = { katex: false } as const;

// Table chrome (fullscreen/download) is workbench-irrelevant; the code block's
// copy action stays.
const CONTROLS = { table: false } as const;

const COMPONENTS = {
  a: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { readonly node?: unknown }) => {
    const courseId = courseIdFromHref(href);
    // `node` is Streamdown's mdast handle; it is not a DOM attribute.
    const { node: _node, ...anchor } = rest;
    if (!courseId)
      return (
        <a href={href} {...anchor}>
          {children}
        </a>
      );
    return (
      <CourseLink
        courseId={courseId}
        variant="inline"
        label={children}
        fallback={
          <a href={href} {...anchor}>
            {children}
          </a>
        }
      />
    );
  },
} as const;

const LESSON_COMPONENTS = {
  ...COMPONENTS,
  p: ({
    children,
    node,
    ...props
  }: React.HTMLAttributes<HTMLParagraphElement> & {
    node?: { children?: { type?: string; tagName?: string }[] };
  }) => (
    <p
      {...props}
      data-pbl-lead={
        node?.children?.length === 1 &&
        node.children[0]?.type === 'element' &&
        node.children[0]?.tagName === 'strong'
          ? 'true'
          : undefined
      }
    >
      {children}
    </p>
  ),
};

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

export function TextBlock({
  text,
  streaming = false,
  excludeCourseCards = NO_EXCLUSIONS,
  variant = 'default',
}: {
  text: string;
  streaming?: boolean;
  variant?: 'default' | 'lesson';
  /**
   * Courses that get no card under this text: carded earlier in the same
   * answer, or among the cards at its tail (`chat-timeline`).
   */
  excludeCourseCards?: ReadonlySet<string>;
}) {
  const navigation = useWorkbenchCourseNavigation();
  const segments = useMemo(
    () =>
      navigation
        ? segmentCourseMentions(parseMarkdownIntoBlocks(text), excludeCourseCards)
        : [{ markdown: text, cards: [] as readonly string[] }],
    [navigation, text, excludeCourseCards],
  );
  if (!text) return null;
  return (
    <div className="wb-prose">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {/* No typewriter caret, no block animation: streaming text just
              streams, quietly. (Walkthrough verdict: the caret read as too
              heavy.) */}
          {segment.markdown ? (
            <Streamdown
              remarkPlugins={REMARK_PLUGINS}
              plugins={STREAMDOWN_PLUGINS}
              remend={REMEND}
              controls={CONTROLS}
              components={variant === 'lesson' ? LESSON_COMPONENTS : COMPONENTS}
              parseIncompleteMarkdown={streaming && index === segments.length - 1}
            >
              {segment.markdown}
            </Streamdown>
          ) : null}
          {segment.cards.length > 0 ? (
            <div
              className={styles.courseLink.mentionSet}
              data-testid="workbench-course-mention-cards"
            >
              {segment.cards.map((courseId) => (
                <CourseLink key={courseId} courseId={courseId} variant="block" />
              ))}
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
