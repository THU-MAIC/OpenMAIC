'use client';

/**
 * Assistant Markdown renderer for the workbench chat.
 *
 * Streamdown owns the parse and render; three things are added:
 *
 *  - `remark-cjk-friendly` BEFORE `remark-gfm`, because CommonMark's emphasis
 *    flanking rules misfire next to fullwidth CJK punctuation — e.g. `**smart**`
 *    quotes otherwise reach the user with their asterisks on (the spike's S10
 *    lesson). Streamdown's `remarkPlugins` prop REPLACES its defaults, so the
 *    defaults (`gfm`, `codeMeta`) are re-spread explicitly after the CJK plugin.
 *  - the `.wb-prose` skin (see `workbench-chat.css`), which styles Streamdown's
 *    `data-streamdown` node contract rather than its Tailwind class names.
 *  - an anchor override, so a link the agent writes to a course becomes the
 *    INLINE form of `CourseLink` — a course named mid-sentence stays in the
 *    sentence instead of chopping the transcript into cards. Only hrefs that
 *    name a course are upgraded (`/classroom/<id>`, `?course=<id>`); every other
 *    link renders exactly as it did before, and outside `/workspace` — where
 *    there is no right pane — the pill falls back to the plain anchor.
 */
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { courseIdFromHref } from '@/lib/workbench/course-link';
import { CourseLink } from './course-link';

const REMARK_PLUGINS = [remarkCjkFriendly, ...Object.values(defaultRemarkPlugins)];

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
        label={typeof children === 'string' ? children : undefined}
        fallback={
          <a href={href} {...anchor}>
            {children}
          </a>
        }
      />
    );
  },
} as const;

export function TextBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (!text) return null;
  return (
    <div className="wb-prose">
      {/* No typewriter caret, no block animation: streaming text just streams,
          quietly. (Walkthrough verdict: the caret read as too heavy.) */}
      <Streamdown
        remarkPlugins={REMARK_PLUGINS}
        controls={CONTROLS}
        components={COMPONENTS}
        parseIncompleteMarkdown={streaming}
      >
        {text}
      </Streamdown>
    </div>
  );
}
