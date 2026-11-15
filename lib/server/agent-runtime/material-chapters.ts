import type { MaterialChapter, MaterialSection } from '@/lib/types/material-chapters';

export interface LocatedMaterialHeading extends MaterialSection {
  chapterIndex: number;
  sectionIndex?: number;
  offset?: number;
}

/** Remove paired emphasis, leaving inline single markers (math/identifiers) alone. */
function unemphasized(input: string): { text: string; leading: number; whole: boolean } {
  let text = input;
  let leading = 0;
  let whole = false;
  for (;;) {
    const wrapper = /^(\*\*|__|\*|_)(\S(?:.*\S)?)\1$/u.exec(text);
    if (!wrapper || wrapper[2].includes(wrapper[1]) || wrapper[2].endsWith('\\')) break;
    text = wrapper[2];
    leading += wrapper[1].length;
    whole = true;
  }
  text = text.replace(
    /(?<!\\)(\*\*|__)(\S(?:.*?\S)?)\1/gu,
    (match, marker: string, body: string, at: number) => {
      if (
        body.endsWith('\\') ||
        (marker === '__' &&
          (/[\p{L}\p{N}_]/u.test(text[at - 1] ?? '') ||
            /[\p{L}\p{N}_]/u.test(text[at + match.length] ?? '')))
      )
        return match;
      if (at === 0) leading += marker.length;
      return body;
    },
  );
  return { text, leading, whole };
}

function normalized(title: string): string {
  return unemphasized(title.trim()).text.replace(/\s+/gu, ' ');
}

/** Locate on the readable text, after image references have been projected. */
export function locateMaterialChapters(
  text: string,
  chapters: readonly MaterialChapter[],
  pageCount?: number,
): LocatedMaterialHeading[] {
  type Candidate = { offset: number; heading: boolean; joined: boolean };
  const candidates = new Map<string, Candidate[]>();
  for (const chapter of chapters) {
    for (const item of [chapter, ...chapter.sections]) candidates.set(normalized(item.title), []);
  }
  // One pass; a two-line candidate is only a fallback for a missing single
  // line. Never concatenate across an intervening nonempty prose line.
  let previousLine: { title: string; offset: number; heading: boolean; whole: boolean } | undefined;
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const prefix = /^(?: {0,3}#{1,6}[\t ]+)?\s*/.exec(line[0])![0];
    const raw = line[0].slice(prefix.length).trimEnd();
    if (!raw) continue;
    const emphasis = unemphasized(raw);
    const title = emphasis.text.replace(/\s+/gu, ' ');
    const offset = line.index + prefix.length + emphasis.leading;
    const heading = prefix.includes('#');
    candidates.get(title)?.push({ offset, heading, joined: false });
    if (previousLine && (previousLine.heading || previousLine.whole)) {
      candidates.get(`${previousLine.title} ${title}`)?.push({
        offset: previousLine.offset,
        heading: previousLine.heading,
        joined: true,
      });
    }
    previousLine = { title, offset, heading, whole: emphasis.whole };
  }
  function locate(
    item: MaterialSection,
    after: number,
    before: number,
    usePageEstimate = true,
  ): number | undefined {
    const estimate =
      usePageEstimate && pageCount && pageCount > 0
        ? ((item.startPage - 1) / pageCount) * text.length
        : after + 1;
    let best: Candidate | undefined;
    for (const candidate of candidates.get(normalized(item.title)) ?? []) {
      if (candidate.offset <= after || candidate.offset >= before) continue;
      if (
        !best ||
        (!candidate.joined && best.joined) ||
        (candidate.joined === best.joined && candidate.heading && !best.heading) ||
        (candidate.joined === best.joined &&
          candidate.heading === best.heading &&
          Math.abs(candidate.offset - estimate) < Math.abs(best.offset - estimate))
      )
        best = candidate;
    }
    return best?.offset;
  }
  let previous = -1;
  const chapterOffsets = chapters.map((chapter) => {
    const offset = locate(chapter, previous, text.length);
    if (offset !== undefined) previous = offset;
    return offset;
  });
  const result: LocatedMaterialHeading[] = [];
  previous = -1;
  chapters.forEach((chapter, chapterIndex) => {
    const offset = chapterOffsets[chapterIndex];
    result.push({ title: chapter.title, startPage: chapter.startPage, chapterIndex, offset });
    if (offset !== undefined) previous = offset;
    const next =
      chapterOffsets.slice(chapterIndex + 1).find((value) => value !== undefined) ?? text.length;
    // Once inside a chapter, the first matching heading is its section start.
    // A whole-book page estimate can drift into repeated exercise headings
    // when pages have uneven text density or image references change length.
    chapter.sections.forEach((section, sectionIndex) => {
      // A missing chapter stays missing; sections can use the nearest known
      // predecessor and the next located chapter without inventing a parent offset.
      const sectionOffset = locate(section, previous, next, false);
      if (sectionOffset !== undefined) previous = sectionOffset;
      result.push({ ...section, chapterIndex, sectionIndex, offset: sectionOffset });
    });
  });
  return result;
}
