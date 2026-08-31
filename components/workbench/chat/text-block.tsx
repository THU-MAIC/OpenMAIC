'use client';

/**
 * Assistant Markdown renderer for the workbench chat.
 *
 * Streamdown owns the parse and render; four things are added:
 *
 *  - KaTeX math through Streamdown's stable math plugin configuration.
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
import { createMathPlugin } from '@streamdown/math';
import { Streamdown, defaultRemarkPlugins, type StreamdownProps } from 'streamdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { courseIdFromHref } from '@/lib/workbench/course-link';
import { CourseLink } from './course-link';

interface MarkdownNode {
  type: string;
  value?: string;
  meta?: string | null;
  data?: Record<string, unknown>;
  position?: {
    start: { line?: number; column?: number; offset?: number };
    end: { line?: number; column?: number; offset?: number };
  };
  children?: MarkdownNode[];
}

function displayMathData(value: string): Record<string, unknown> {
  return {
    hName: 'pre',
    hChildren: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-display'] },
        children: [{ type: 'text', value }],
      },
    ],
  };
}

function nodeSource(node: MarkdownNode, source: string): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  return source.slice(start, end);
}

function isDoubleDollarMath(node: MarkdownNode, source: string): boolean {
  if (node.type !== 'inlineMath') return false;

  const raw = nodeSource(node, source);
  return Boolean(
    raw?.startsWith('$$') && raw.endsWith('$$') && raw[2] !== '$' && raw[raw.length - 3] !== '$',
  );
}

function mathBlock(node: MarkdownNode): MarkdownNode {
  return {
    type: 'math',
    value: node.value,
    position: node.position,
    data: displayMathData(node.value ?? ''),
  };
}

function mathNodeValue(node: MarkdownNode): string {
  let body = node.value ?? '';
  if (body.endsWith('$$') && body[body.length - 3] !== '$') body = body.slice(0, -2);

  if (typeof node.meta !== 'string' || node.meta.length === 0) return body;
  return body ? `${node.meta}\n${body}` : node.meta;
}

function literalDollarBlock(node: MarkdownNode, openingFence: string, raw: string): MarkdownNode {
  let value = raw.match(/^\$+[^\S\r\n]*/)?.[0] ?? openingFence;
  if (typeof node.meta === 'string') value += node.meta;
  if (node.value) value += `\n${node.value}`;

  const closingFence = raw.match(/(?:^|\n)[^\S\r\n]*(?:>\s*)*(\${3,})[^\S\r\n]*$/)?.[1];
  if (closingFence && closingFence.length >= openingFence.length) value += `\n${closingFence}`;

  return {
    type: 'paragraph',
    position: node.position,
    children: [{ type: 'text', value, position: node.position }],
  };
}

function normalizeMathBlock(node: MarkdownNode, source: string): MarkdownNode {
  if (node.type !== 'math') return node;

  const raw = nodeSource(node, source);
  const openingFence = raw?.match(/^\$+/)?.[0];
  if (!raw || !openingFence || openingFence.length < 2) return node;

  // Longer dollar runs are inline syntax, even when an unfinished message
  // temporarily makes remark-math parse them as a flow node.
  if (openingFence.length > 2) return literalDollarBlock(node, openingFence, raw);

  // remark-math stores content beside the opening fence in `meta`; its `value`
  // has already removed blockquote/list markers from the following lines.
  const value = mathNodeValue(node);
  node.value = value;
  node.meta = null;
  node.data = displayMathData(value);
  return node;
}

function splitDisplayMath(paragraph: MarkdownNode, source: string): MarkdownNode[] | undefined {
  if (
    paragraph.type !== 'paragraph' ||
    !paragraph.children?.some((node) => isDoubleDollarMath(node, source))
  ) {
    return undefined;
  }

  const blocks: MarkdownNode[] = [];
  let inlineNodes: MarkdownNode[] = [];

  const flushInlineNodes = () => {
    if (inlineNodes.length === 0) return;

    blocks.push({
      ...paragraph,
      children: inlineNodes,
      position: {
        start: inlineNodes[0].position?.start ?? paragraph.position?.start ?? {},
        end: inlineNodes[inlineNodes.length - 1].position?.end ?? paragraph.position?.end ?? {},
      },
    });
    inlineNodes = [];
  };

  for (const node of paragraph.children) {
    if (isDoubleDollarMath(node, source)) {
      flushInlineNodes();
      blocks.push(mathBlock(node));
    } else {
      inlineNodes.push(node);
    }
  }
  flushInlineNodes();

  return blocks;
}

function remarkNormalizeDisplayMath() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = file.value;
    if (typeof source !== 'string') return;

    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;

      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index];

        const normalized = normalizeMathBlock(node, source);
        if (normalized !== node) {
          parent.children[index] = normalized;
          continue;
        }

        // remark-math parses one-line `$$...$$` as inline math. Split only
        // top-level paragraph children so the double-dollar form keeps block semantics.
        const blocks = splitDisplayMath(node, source);
        if (blocks) {
          parent.children.splice(index, 1, ...blocks);
          index += blocks.length - 1;
          continue;
        }

        visit(node);
      }
    };

    visit(tree);
  };
}

const REMARK_PLUGINS: NonNullable<StreamdownProps['remarkPlugins']> = [
  remarkCjkFriendly,
  ...Object.values(defaultRemarkPlugins),
  remarkNormalizeDisplayMath,
];

const STREAMDOWN_PLUGINS = {
  // `$...$` is part of the workbench contract; literal currency uses `\$`.
  math: createMathPlugin({ singleDollarTextMath: true }),
} as const;

// The normalizer above already keeps unfinished display math visible. Remend's
// generic `$$` completion is container-unaware and can alter fenced code or add
// a second formula outside a list/blockquote while a message is streaming.
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
        mode={streaming ? 'streaming' : 'static'}
        remarkPlugins={REMARK_PLUGINS}
        plugins={STREAMDOWN_PLUGINS}
        remend={REMEND}
        controls={CONTROLS}
        components={COMPONENTS}
        parseIncompleteMarkdown={streaming}
      >
        {text}
      </Streamdown>
    </div>
  );
}
