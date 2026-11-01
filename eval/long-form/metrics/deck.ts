/**
 * Measuring the human deck: what a real 60-minute lesson spends, in pages,
 * minutes and spoken characters.
 *
 * Every number here comes from the designer's own speaker notes, not from an
 * estimate. That is what makes it usable as a baseline — a plan that disagrees
 * with this file is disagreeing with a person who actually taught the hour.
 */

import type { DeckFixture, DeckMetrics } from '../types';
import { range } from '../types';

/**
 * Words a presenter uses to make the room retrieve something.
 *
 * A proxy, not a taxonomy: these decks carry no quiz markup, so the only signal
 * that a page asks the learner to produce an answer is the language of the
 * notes. Good enough to separate "this hour has retrieval beats" from "this
 * hour is a monologue", which is all the structural score needs.
 */
const RETRIEVAL_MARKERS = ['小测', '自测', '提问', '回忆', '想一想', '请回答', '答不上来', '作答'];

function hasRetrieval(page: DeckFixture['pages'][number]): boolean {
  const text = `${page.purpose}\n${page.talk.join('\n')}`;
  return RETRIEVAL_MARKERS.some((marker) => text.includes(marker));
}

export function measureDeck(fixture: DeckFixture): DeckMetrics {
  const { pages, units, meta } = fixture;
  const minutes = pages.reduce((acc, page) => acc + page.minutes, 0);
  const pageMinutes = pages.map((page) => page.minutes);
  const unitMinutes = units.map((unit) => unit.minutes);
  const cueChars = pages.reduce((acc, page) => acc + page.cueChars, 0);

  return {
    pages: pages.length,
    minutes,
    pagesPerMinute: pages.length / minutes,
    minutesPerPage: minutes / pages.length,
    pageMinutes: range(pageMinutes),
    units: units.length,
    multiPageUnits: units.filter((unit) => unit.pages >= 2).length,
    unitMinutes: range(unitMinutes),
    pagesPerUnit: pages.length / Math.max(1, units.length),
    heroPages: meta.heroPages,
    purposeCoverage: pages.filter((page) => page.purpose.trim()).length / pages.length,
    transitionCoverage: pages.filter((page) => page.transition.trim()).length / pages.length,
    cueChars,
    cueCharsPerMinute: cueChars / minutes,
    talkSegmentsPerPage: pages.reduce((acc, page) => acc + page.talkSegments, 0) / pages.length,
    retrievalPages: pages.filter(hasRetrieval).length,
  };
}
