/** Transient parser evidence. Symbol keys survive spreads but never JSON serialization. */
const chapterSource = Symbol('chapterSource');

export interface ChapterSource {
  titles: Array<{ text: string; page: number; text_level: number }>;
  frontPages: Record<number, string>;
}

export function getChapterSource(value: object): ChapterSource | undefined {
  return (value as { [chapterSource]?: ChapterSource })[chapterSource];
}

export function withChapterSource<T extends object>(value: T, source?: ChapterSource): T {
  return source ? Object.assign(value, { [chapterSource]: source }) : value;
}

export const FRONT_CHARACTER_LIMIT = 60_000;
export const frontPageCount = (pages: number): number => Math.min(30, Math.ceil(pages / 10));

function markdownBlock(block: Record<string, unknown>): string {
  const { text, text_level: level } = block;
  if (typeof text === 'string' && text.trim()) {
    if (block.type === 'equation') return `$$\n${text}\n$$`;
    const prefix =
      typeof level === 'number' && Number.isInteger(level) && level > 0
        ? `${'#'.repeat(Math.min(level, 6))} `
        : '';
    return prefix + text;
  }
  return [
    'image_caption',
    'image_footnote',
    'table_caption',
    'table_body',
    'table_footnote',
    'list_items',
  ]
    .flatMap((key) => {
      const value = block[key];
      return (Array.isArray(value) ? value : [value]).filter(
        (part): part is string => typeof part === 'string' && !!part.trim(),
      );
    })
    .join('\n\n');
}

/** Retain all headings, but only the bounded front matter, never whole-book page text. */
export function chapterSourceFromBlocks(
  blocks: Record<string, unknown>[],
  pages: number,
): ChapterSource {
  const titles: ChapterSource['titles'] = [];
  const frontPages: Record<number, string> = {};
  const count = frontPageCount(pages);
  const ordered = blocks
    .filter((block) => Number.isInteger(block.page_idx) && Number(block.page_idx) >= 0)
    .sort((a, b) => Number(a.page_idx) - Number(b.page_idx));
  let remaining = FRONT_CHARACTER_LIMIT;
  for (const block of ordered) {
    const page = Number(block.page_idx) + 1;
    if (typeof block.text === 'string' && block.text.trim() && Number.isInteger(block.text_level)) {
      titles.push({ text: block.text, page, text_level: Number(block.text_level) });
    }
    if (page > count || remaining <= 0) continue;
    const text = markdownBlock(block);
    if (!text) continue;
    const addition = `${frontPages[page] ? '\n\n' : ''}${text}`.slice(0, remaining);
    frontPages[page] = (frontPages[page] ?? '') + addition;
    remaining -= addition.length;
  }
  return { titles, frontPages };
}

export function buildChapterInput(source: ChapterSource, format: string, pages: number): string {
  const front = Array.from({ length: frontPageCount(pages) }, (_, index) => {
    const page = index + 1;
    return `### Source page ${page}\n\n${source.frontPages[page] ?? ''}`;
  })
    .join('\n\n')
    .slice(0, FRONT_CHARACTER_LIMIT);
  const titles = source.titles
    .map((row) => `${row.page}\t${row.text_level}\t${JSON.stringify(row.text)}`)
    .join('\n');
  return `文档元数据\n${JSON.stringify({ format, total_units: pages })}\n\n标题列表（1-based 源页、text_level、JSON 标题字符串）\n${titles}\n\n前置页 Markdown\n${front}`;
}
