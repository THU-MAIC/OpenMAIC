#!/usr/bin/env node
/**
 * Parse a beautified pharmacology deck into the long-form eval fixture.
 *
 * The `网页美化版` decks are hand-built 60-minute lessons: every `<section>` is a
 * page, and the embedded `SPEAKER_NOTES` array carries the designer's own
 * minutes, teaching purpose, spoken cues and hand-forward for each page. That
 * makes them the only ground truth we have for "what a real 60-minute lesson
 * looks like" — so this script turns one into data the eval can score.
 *
 * Usage:
 *   node scripts/long-form/parse-deck.mjs <deck-dir> [out.json]
 *
 * `deck-dir` is a chapter directory containing `index.html`, e.g.
 *   "C:/Users/lenovo/Desktop/药理学PPT/网页美化版/ch18镇痛药"
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Sections that frame the lesson rather than teach it. */
const FRAMING_SECTIONS = new Set(['开篇', '转场', '收尾']);

/**
 * The embedded notes are a JavaScript array literal, not JSON: single-quoted
 * strings, unquoted keys. It is our own local data, so evaluating the literal
 * is the honest parse — a regex would mangle the Chinese punctuation inside.
 */
function readSpeakerNotes(html) {
  const marker = 'const SPEAKER_NOTES = [';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('SPEAKER_NOTES not found in index.html');
  const end = html.indexOf('];', start);
  if (end === -1) throw new Error('SPEAKER_NOTES array is not terminated');

  const literal = html.slice(start + 'const SPEAKER_NOTES = '.length, end + 1);
  return new Function(`return ${literal};`)();
}

/** Every `<section class="slide ...">` with the bits the eval compares. */
function readSlides(html) {
  const slides = [];
  const sectionPattern = /<section class="slide([^"]*)"([^>]*)>/g;
  let match;
  while ((match = sectionPattern.exec(html)) !== null) {
    const classes = match[1].trim().split(/\s+/).filter(Boolean);
    const attrs = match[2];
    const id = /data-slide-id="([^"]+)"/.exec(attrs)?.[1] ?? null;
    // The template's "SLIDES 插入区" comment contains a literal
    // `<section class="slide ...">` example; only real pages carry an id.
    if (!id) continue;
    const animate = /data-animate="([^"]+)"/.exec(attrs)?.[1] ?? null;
    slides.push({
      id,
      hero: classes.includes('hero'),
      theme: classes.includes('light') ? 'light' : 'dark',
      animate,
    });
  }
  return slides;
}

/** Count spoken characters the way a TTS engine would read them. */
function cueChars(talk) {
  return talk.join('').replace(/\s/g, '').length;
}

function buildFixture(html, deckDir) {
  const notes = readSpeakerNotes(html);
  const slides = readSlides(html);

  if (notes.length !== slides.length) {
    throw new Error(`notes (${notes.length}) and slides (${slides.length}) disagree`);
  }

  const pages = notes.map((note, index) => {
    const slide = slides[index];
    if (slide.id !== note.id) {
      throw new Error(`page ${index + 1}: slide id ${slide.id} vs note id ${note.id}`);
    }
    return {
      id: note.id,
      index: index + 1,
      theme: slide.theme,
      hero: slide.hero,
      animate: slide.animate,
      title: note.title,
      section: note.section,
      minutes: note.minutes,
      purpose: note.purpose ?? '',
      talk: note.talk ?? [],
      transition: note.transition ?? '',
      cueChars: cueChars(note.talk ?? []),
      talkSegments: (note.talk ?? []).length,
    };
  });

  // Contiguous runs of the same section label, so a repeated label later in the
  // deck stays its own unit (ch18 has 药理作用 twice, on either side of 机制).
  const units = [];
  for (const page of pages) {
    if (FRAMING_SECTIONS.has(page.section)) continue;
    const last = units[units.length - 1];
    if (last && last.section === page.section) {
      last.minutes += page.minutes;
      last.pages += 1;
      last.pageIds.push(page.id);
    } else {
      units.push({
        section: page.section,
        minutes: page.minutes,
        pages: 1,
        pageIds: [page.id],
      });
    }
  }

  const totalMinutes = pages.reduce((acc, page) => acc + page.minutes, 0);
  const totalCueChars = pages.reduce((acc, page) => acc + page.cueChars, 0);

  return {
    meta: {
      deckDir: resolve(deckDir),
      chapter: basename(resolve(deckDir)),
      title: pages[0]?.title ?? '',
      pages: pages.length,
      minutes: totalMinutes,
      cueChars: totalCueChars,
      heroPages: pages.filter((page) => page.hero).length,
      sections: [...new Set(pages.map((page) => page.section))],
    },
    pages,
    units,
  };
}

const deckDir = process.argv[2];
if (!deckDir) {
  console.error('usage: node scripts/long-form/parse-deck.mjs <deck-dir> [out.json]');
  process.exit(1);
}

const html = readFileSync(join(deckDir, 'index.html'), 'utf-8');
const fixture = buildFixture(html, deckDir);
const outPath = process.argv[3];
const json = `${JSON.stringify(fixture, null, 2)}\n`;

if (outPath) {
  writeFileSync(outPath, json, 'utf-8');
  const { pages, minutes, cueChars } = fixture.meta;
  console.log(`${outPath}: ${pages} pages, ${minutes} min, ${cueChars} cue chars`);
} else {
  process.stdout.write(json);
}
