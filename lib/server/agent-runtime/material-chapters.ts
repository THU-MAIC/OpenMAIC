import type { MaterialChapter, MaterialSection } from '@/lib/types/material-chapters';

export interface LocatedMaterialHeading extends MaterialSection {
  chapterIndex: number;
  sectionIndex?: number;
  offset?: number;
}

function normalized(title: string): string {
  return title.trim().replace(/\s+/gu, ' ');
}

/** Locate on the readable text, after image references have been projected. */
export function locateMaterialChapters(
  text: string,
  chapters: readonly MaterialChapter[],
  pageCount?: number,
): LocatedMaterialHeading[] {
  const candidates = new Map<string, { offset: number; heading: boolean }[]>();
  for (const chapter of chapters) {
    for (const item of [chapter, ...chapter.sections]) candidates.set(normalized(item.title), []);
  }
  // One pass through the text, not a whole-document scan per title. Keep exact
  // whole-line matches only: TOC entries with page numbers are not headings.
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const prefix = /^(?: {0,3}#{1,6}[\t ]+)?\s*/.exec(line[0])![0];
    const title = line[0].slice(prefix.length);
    const matches = candidates.get(normalized(title));
    if (matches) {
      matches.push({ offset: line.index + prefix.length, heading: prefix.includes('#') });
    }
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
    let best: { offset: number; heading: boolean } | undefined;
    for (const candidate of candidates.get(normalized(item.title)) ?? []) {
      if (candidate.offset <= after || candidate.offset >= before) continue;
      if (
        !best ||
        (candidate.heading && !best.heading) ||
        (candidate.heading === best.heading &&
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
  chapters.forEach((chapter, chapterIndex) => {
    const offset = chapterOffsets[chapterIndex];
    result.push({ title: chapter.title, startPage: chapter.startPage, chapterIndex, offset });
    const next =
      chapterIndex + 1 === chapters.length ? text.length : chapterOffsets[chapterIndex + 1];
    // Once inside a chapter, the first matching heading is its section start.
    // A whole-book page estimate can drift into repeated exercise headings
    // when pages have uneven text density or image references change length.
    let previousSection = offset;
    chapter.sections.forEach((section, sectionIndex) => {
      // Without both chapter boundaries we cannot safely place a section.
      const sectionOffset =
        previousSection === undefined || next === undefined
          ? undefined
          : locate(section, previousSection, next, false);
      if (sectionOffset !== undefined) previousSection = sectionOffset;
      result.push({ ...section, chapterIndex, sectionIndex, offset: sectionOffset });
    });
  });
  return result;
}
