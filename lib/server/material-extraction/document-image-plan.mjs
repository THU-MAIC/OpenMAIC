/** Shared parser for the document-image worker and focused parser tests. */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseFragment, Tokenizer } from 'parse5';
function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function span(node) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}
function mergedRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
/** First merged range ending after an offset; ranges are sorted and disjoint. */
function rangeAfter(ranges, offset) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ranges[mid].end <= offset) low = mid + 1;
    else high = mid;
  }
  return ranges[low];
}
/** Keep offsets stable while excluding Markdown code and non-HTML destinations. */
function maskRanges(input, ranges) {
  let end = 0;
  const parts = [];
  for (const at of mergedRanges(ranges)) {
    parts.push(input.slice(end, at.start), ' '.repeat(at.end - at.start));
    end = at.end;
  }
  parts.push(input.slice(end));
  return parts.join('');
}
/** Whether `text` is exactly one HTML tag with CommonMark tag and attribute names. */
function isWrittenTag(text) {
  let tag;
  const take = (token) => {
    tag ??= token;
  };
  const noop = () => {};
  new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag: take,
      onEndTag: take,
      onComment: noop,
      onDoctype: noop,
      onEof: noop,
      onCharacter: noop,
      onWhitespaceCharacter: noop,
      onNullCharacter: noop,
    },
  ).write(text, true);
  return (
    tag !== undefined &&
    tag.location?.startOffset === 0 &&
    tag.location.endOffset === text.length &&
    /^[a-z][a-z0-9-]*$/i.test(tag.tagName) &&
    tag.attrs.every(({ name }) => /^[a-z_:][a-z0-9_.:-]*$/i.test(name))
  );
}

/** Parse complete HTML tags before interpreting Markdown images inside their ranges. */
export function imagePlan(input) {
  const tree = fromMarkdown(input);
  const htmlRanges = [];
  const textRanges = [];
  const markdownBlocks = [];
  const rawTextTags = new Set([
    'script',
    'style',
    'textarea',
    'title',
    'xmp',
    'iframe',
    'noembed',
    'noscript',
    'plaintext',
  ]);
  const closedRawText = [];
  const excluded = [];
  walk(tree, (node) => {
    const at = span(node);
    if (!at) return;
    if (['paragraph', 'heading', 'html'].includes(node.type)) markdownBlocks.push(at);
    if (node.type === 'html') htmlRanges.push(at);
    else if (node.type === 'text') textRanges.push(at);
    else if (['code', 'inlineCode', 'image', 'imageReference', 'definition'].includes(node.type)) {
      excluded.push(at);
    } else if (node.type === 'link') {
      // A link label may contain real HTML; its destination and title may not.
      let end = at.start;
      for (const child of node.children ?? []) {
        const childAt = span(child);
        if (!childAt) continue;
        excluded.push({ start: end, end: childAt.start });
        end = childAt.end;
      }
      excluded.push({ start: end, end: at.end });
    }
  });
  if (input.includes('<')) {
    // CommonMark may split an unquoted HTML attribute at Markdown emphasis.
    // The HTML tokenizer locates the whole tag, including its quoted values;
    // only a tag starting in real HTML or unescaped text is admitted.
    const textSpans = mergedRanges(textRanges);
    const admittedSpans = mergedRanges([...textSpans, ...htmlRanges]);
    const tagBlocks = mergedRanges(markdownBlocks);
    const rawStarts = new Map();
    const rawEnds = new Map();
    let tagOffset = 0;
    const tag = (closing) => (token) => {
      const location = token.location;
      if (!location) return;
      const start = tagOffset + location.startOffset;
      const admitted = rangeAfter(admittedSpans, start);
      if (!admitted || admitted.start > start) return;
      // HTML's tokenizer also accepts names such as `b$` in prose inequalities.
      // Only CommonMark-style tag names can claim an HTML span.
      if (!/^[a-z][a-z0-9-]*$/i.test(token.tagName)) return;
      // A stray inequality (`a<b`) must not consume a later block's `>`.
      // Closed raw-text elements may still pair across blocks below; each
      // individual opening/closing tag must fit the block where it starts.
      const block = rangeAfter(tagBlocks, start);
      if (!block || block.start > start || tagOffset + location.endOffset > block.end) return;
      let backslashes = 0;
      for (let i = start - 1; input[i] === '\\'; i -= 1) backslashes += 1;
      if (backslashes % 2 !== 0) return;
      const at = { start, end: tagOffset + location.endOffset };
      // Images and code are masked before tokenizing, so prose such as
      // `n<k and ![a](x) for k>0` looks like `<k and ... for k>` here. Read the
      // span as written: it must still be one tag whose attribute names are
      // CommonMark names. Quoted values may hold anything.
      if (!isWrittenTag(input.slice(at.start, at.end))) return;
      const textSpan = rangeAfter(textSpans, start);
      if (textSpan && textSpan.start <= start) htmlRanges.push(at);
      if (rawTextTags.has(token.tagName)) {
        const spans = closing ? rawEnds : rawStarts;
        const entries = spans.get(token.tagName) ?? [];
        entries.push(at);
        spans.set(token.tagName, entries);
      }
    };
    const noop = () => {};
    const masked = maskRanges(input, excluded);
    for (const block of tagBlocks) {
      tagOffset = block.start;
      new Tokenizer(
        { sourceCodeLocationInfo: true },
        {
          onStartTag: tag(false),
          onEndTag: tag(true),
          onComment: noop,
          onDoctype: noop,
          onEof: noop,
          onCharacter: noop,
          onWhitespaceCharacter: noop,
          onNullCharacter: noop,
        },
      ).write(masked.slice(block.start, block.end), true);
    }
    // Closed inline raw-text elements can span Markdown paragraphs. Keep
    // those together; only unclosed starts are bounded by their Markdown block.
    for (const [name, starts] of rawStarts) {
      const ends = rawEnds.get(name) ?? [];
      for (const at of starts) {
        const closing = rangeAfter(ends, at.end);
        if (closing) closedRawText.push({ start: at.start, end: closing.end });
      }
    }
  }
  const htmlSpans = mergedRanges(htmlRanges);
  const protectedHtml = [...htmlSpans];
  const plan = { markdown: [], html: [] };
  // Raw HTML blocks already contain their full CommonMark extent, including
  // unclosed script blocks. Inline tags belong to their paragraph or heading;
  // an unclosed one must not change how the next Markdown block is read.
  const blocks = mergedRanges([...markdownBlocks, ...htmlSpans, ...closedRawText]);
  let nextHtml = 0;
  for (const block of blocks) {
    if (!htmlSpans[nextHtml] || htmlSpans[nextHtml].start >= block.end) continue;
    let end = block.start;
    const parts = [];
    while (htmlSpans[nextHtml] && htmlSpans[nextHtml].start < block.end) {
      const at = htmlSpans[nextHtml++];
      parts.push(' '.repeat(at.start - end), input.slice(at.start, at.end));
      end = at.end;
    }
    parts.push(' '.repeat(block.end - end));
    const visit = (node) => {
      if ('tagName' in node && node.sourceCodeLocation) {
        const location = node.sourceCodeLocation;
        if (rawTextTags.has(node.tagName)) {
          protectedHtml.push({
            start: block.start + location.startOffset,
            end: location.endTag ? block.start + location.endOffset : block.end,
          });
        }
        if (node.tagName === 'img') {
          const src = node.attrs.find((attribute) => attribute.name === 'src');
          const at = location.attrs?.src;
          if (src && at) {
            const srcRange = {
              start: block.start + at.startOffset,
              end: block.start + at.endOffset,
            };
            const original = input.slice(srcRange.start, srcRange.end);
            const valueStart = original.indexOf('=') + 1;
            const spaces = original.slice(valueStart).match(/^\s*/)?.[0] ?? '';
            const attributePrefix = original.slice(0, valueStart + spaces.length);
            plan.html.push({
              start: block.start + location.startOffset,
              end: block.start + location.endOffset,
              target: src.value,
              alt: node.attrs.find((attribute) => attribute.name === 'alt')?.value ?? '',
              src: srcRange,
              attributePrefix,
              quote: original[attributePrefix.length] === "'" ? "'" : '"',
            });
          }
        }
      }
      if ('childNodes' in node) for (const child of node.childNodes) visit(child);
      if ('content' in node) visit(node.content);
    };
    visit(parseFragment(parts.join(''), { sourceCodeLocationInfo: true }));
  }
  const protectedSpans = mergedRanges(protectedHtml);
  const inHtml = (at) => {
    const html = rangeAfter(protectedSpans, at.start);
    return html !== undefined && html.start < at.end;
  };
  const definitions = new Map();
  const linkLabels = new Set();
  walk(tree, (node) => {
    const at = span(node);
    if (!at || inHtml(at)) return;
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if (node.type === 'linkReference' && node.identifier) linkLabels.add(node.identifier);
  });
  walk(tree, (node) => {
    const at = span(node);
    if (!at || inHtml(at)) return;
    if (node.type === 'image' && node.url !== undefined) {
      plan.markdown.push({ ...at, target: node.url, alt: node.alt ?? '', title: node.title });
    } else if (node.type === 'imageReference' && node.identifier) {
      const definition = definitions.get(node.identifier);
      if (!definition?.url) return;
      plan.markdown.push({
        ...at,
        target: definition.url,
        alt: node.alt ?? '',
        title: definition.title,
        ...(!linkLabels.has(node.identifier) ? { definition: span(definition) } : {}),
      });
    }
  });
  return plan;
}
