import type pptxgen from 'pptxgenjs';
import tinycolor from 'tinycolor2';
import type { Slide } from '@openmaic/dsl';
import type { PBLContent, Scene } from '@/lib/types/stage';
import { classroomSceneUrl } from '@/lib/classroom/scene-deep-link';
import { pblBriefing, type PblBriefing } from './pbl-briefing';

// ── Interactive page naming (shared by the Resource Pack ZIP and PPTX links) ──

/** Characters that are not allowed in file names on common file systems. */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * A scene title with surrounding whitespace removed; '' when the title is
 * missing or blank. Page file names and placeholder titles both go through
 * this, so an untitled scene never aborts the export.
 */
export function normalizeSceneTitle(title: unknown): string {
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * Path of an interactive scene's HTML page inside the Resource Pack,
 * e.g. `interactive/01_My widget.html`, or `interactive/01.html` for an
 * untitled scene. `index` is 1-based.
 */
export function interactivePagePath(index: number, title: unknown): string {
  const number = String(index).padStart(2, '0');
  const name = normalizeSceneTitle(title);
  if (!name) return `interactive/${number}.html`;
  return `interactive/${number}_${name.replace(ILLEGAL_FILE_NAME_CHARS, '_')}.html`;
}

export interface InteractivePage {
  scene: Scene;
  html: string;
  /** Path inside the Resource Pack, relative to the pack root. */
  path: string;
}

/**
 * The interactive scenes that ship as HTML pages, in lesson order, with their
 * pack paths. Scenes without an html payload are skipped and do not consume a
 * number. Both the ZIP writer and the PPTX placeholder links read this list, so
 * a link target and its file name cannot drift apart.
 */
export function listInteractivePages(scenes: readonly Scene[]): InteractivePage[] {
  const pages: InteractivePage[] = [];
  for (const scene of scenes) {
    if (scene.content.type === 'interactive' && scene.content.html) {
      pages.push({
        scene,
        html: scene.content.html,
        path: interactivePagePath(pages.length + 1, scene.title),
      });
    }
  }
  return pages;
}

/**
 * Turn a pack path into a relative hyperlink target. Characters that would
 * change the meaning of a URI (space, `#`, `?`, `%`, ...) are percent-encoded;
 * non-ASCII characters are kept as-is, which is how Office writes relative
 * file links. XML escaping is left to pptxgenjs.
 */
export function relativeHyperlinkTarget(path: string): string {
  return path.replace(
    /[\u0000- "#%<>?[\\\]^`{|}\u007f]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

// ── Deck plan ──

export interface ScenePlaceholder {
  scene: Scene;
  sceneType: 'interactive' | 'quiz' | 'pbl';
  /** Localized scene-type label, e.g. "Interactive". */
  typeLabel: string;
  title: string;
  description: string;
  /** The scene in the online classroom: a button and a QR code of `url`. */
  online?: { url: string; label: string };
  /**
   * The scene's page in the Resource Pack. `target` is the URI-encoded
   * relative link; `path` is the readable pack path.
   */
  offline?: { label: string; hint: string; target: string; path: string };
  /** Plain line above `meta`, e.g. a PBL project's goal. */
  lead?: string;
  /** Bold summary line, e.g. the quiz question or PBL milestone count. */
  meta?: string;
  /**
   * Plain-text list items: quiz question stems (never answers) or PBL
   * milestone titles.
   */
  items?: string[];
}

/**
 * One PPTX slide in lesson order: either a slide scene (by index into the
 * `slides` / `slideScenes` arrays) or a placeholder for a non-slide scene.
 */
export type PptxDeckEntry =
  | { kind: 'slide'; slideIndex: number }
  | { kind: 'placeholder'; placeholder: ScenePlaceholder };

export interface PlanPptxDeckOptions {
  /**
   * True only when the PPTX ships inside the Resource Pack: a relative link
   * from a standalone PPTX would point at nothing.
   */
  linkInteractivePages: boolean;
  /**
   * Absolute classroom page URL (`classroomPageUrl`). When set, placeholders
   * link to their scene in the online classroom.
   */
  classroomUrl?: string;
  /**
   * Whether quiz, interactive and PBL scenes get placeholder slides (the
   * default). When false the PPTX holds the slide scenes only.
   */
  includePlaceholders?: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const MAX_QUIZ_ITEMS = 4;
const MAX_QUIZ_ITEM_LENGTH = 90;
const MAX_PBL_MILESTONES = 4;
// PBL lines are single lines in the left column, so they are cut by display
// width (a CJK character counts twice) rather than by character count.
const MAX_PBL_MILESTONE_WIDTH = 66;
const MAX_PBL_GOAL_WIDTH = 64;
const MAX_TITLE_LENGTH = 120;

// ── Text truncation ──
// Placeholder text is cut by user-perceived characters (grapheme clusters), so
// a cut never splits an accented letter, a surrogate pair or an emoji
// sequence.

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** `text` split into grapheme clusters (code points where Segmenter is missing). */
function graphemes(text: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
    : Array.from(text);
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Cut `text` to at most `max` characters, the last one being "…". */
export function truncate(text: string, max: number): string {
  const clusters = graphemes(oneLine(text));
  return clusters.length > max ? `${clusters.slice(0, max - 1).join('')}…` : clusters.join('');
}

/** East Asian Wide and Fullwidth characters (CJK, Hangul, full-width forms). */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;
/** Emoji shown as pictures: default emoji presentation, flags, keycaps. */
const EMOJI_CLUSTER = /\p{Emoji_Presentation}|\p{Regional_Indicator}|️/u;

/**
 * Display width of one grapheme cluster in Latin character widths: 2 for wide
 * characters and emoji (including ZWJ, skin-tone and flag sequences), else 1.
 * Combining marks, joiners and variation selectors add nothing of their own:
 * they are part of the cluster they modify.
 */
function clusterWidth(cluster: string): number {
  if (WIDE_CHAR.test(cluster) || EMOJI_CLUSTER.test(cluster)) return 2;
  if (cluster.includes('‍') && /\p{Extended_Pictographic}/u.test(cluster)) return 2;
  return 1;
}

/** Cut `text` to one line of about `maxWidth` Latin character widths. */
export function truncateToWidth(text: string, maxWidth: number): string {
  const clusters = graphemes(oneLine(text));
  const widths = clusters.map(clusterWidth);
  if (widths.reduce((sum, w) => sum + w, 0) <= maxWidth) return clusters.join('');
  // Room for the ellipsis (width 1) is reserved before taking clusters.
  let width = 0;
  let count = 0;
  while (count < clusters.length && width + widths[count] <= maxWidth - 1) {
    width += widths[count];
    count++;
  }
  return `${clusters.slice(0, count).join('')}…`;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A PBL scene's briefing, or null when its project is missing or unreadable. */
function readPblBriefing(content: PBLContent): PblBriefing | null {
  try {
    return pblBriefing(content);
  } catch {
    return null;
  }
}

/**
 * The scenes that get a PPTX slide, in lesson order: slide, quiz and PBL
 * scenes, and interactive scenes that ship an HTML page; only the slide scenes
 * when `includePlaceholders` is false. Export is possible exactly when this
 * list is non-empty; `planPptxDeck` lays out the same list.
 */
export function pptxDeckScenes(
  scenes: readonly Scene[],
  { includePlaceholders = true }: { includePlaceholders?: boolean } = {},
): Scene[] {
  return scenes.filter(
    (scene) =>
      scene.content.type === 'slide' ||
      (includePlaceholders &&
        (scene.content.type === 'quiz' ||
          scene.content.type === 'pbl' ||
          (scene.content.type === 'interactive' && !!scene.content.html))),
  );
}

/**
 * Lay out the PPTX in lesson order. Slide scenes map to their slide; quiz,
 * interactive and PBL scenes get a placeholder slide. Interactive scenes
 * without an html payload are left out, matching the Resource Pack, which has
 * no page for them.
 */
export function planPptxDeck(
  scenes: readonly Scene[],
  t: Translate,
  { linkInteractivePages, classroomUrl, includePlaceholders = true }: PlanPptxDeckOptions,
): PptxDeckEntry[] {
  const pagePaths = new Map(listInteractivePages(scenes).map((p) => [p.scene, p.path]));
  const deck: PptxDeckEntry[] = [];
  let slideIndex = 0;

  const onlineLink = (scene: Scene): ScenePlaceholder['online'] =>
    classroomUrl
      ? {
          url: classroomSceneUrl(classroomUrl, scene.id),
          label: t('export.placeholder.openOnline'),
        }
      : undefined;

  for (const scene of pptxDeckScenes(scenes, { includePlaceholders })) {
    const content = scene.content;
    const title = truncate(normalizeSceneTitle(scene.title), MAX_TITLE_LENGTH);
    if (content.type === 'slide') {
      deck.push({ kind: 'slide', slideIndex: slideIndex++ });
    } else if (content.type === 'interactive') {
      const path = pagePaths.get(scene);
      if (!path) continue;
      const typeLabel = t('export.placeholder.interactiveLabel');
      deck.push({
        kind: 'placeholder',
        placeholder: {
          scene,
          sceneType: 'interactive',
          typeLabel,
          title: title || typeLabel,
          description: t('export.placeholder.interactiveDesc'),
          online: onlineLink(scene),
          offline: linkInteractivePages
            ? {
                label: t('export.placeholder.openOffline'),
                hint: t('export.placeholder.offlineHint'),
                target: relativeHyperlinkTarget(path),
                path,
              }
            : undefined,
        },
      });
    } else if (content.type === 'quiz') {
      const questions = content.questions ?? [];
      const typeLabel = t('export.placeholder.quizLabel');
      const items = questions
        .slice(0, MAX_QUIZ_ITEMS)
        .map((q) => truncate(q.question ?? '', MAX_QUIZ_ITEM_LENGTH))
        .filter(Boolean);
      if (questions.length > MAX_QUIZ_ITEMS) items.push('…');
      deck.push({
        kind: 'placeholder',
        placeholder: {
          scene,
          sceneType: 'quiz',
          typeLabel,
          title: title || typeLabel,
          description: t('export.placeholder.quizDesc'),
          online: onlineLink(scene),
          meta: t('export.placeholder.quizQuestionCount', { count: questions.length }),
          items,
        },
      });
    } else if (content.type === 'pbl') {
      // Only the briefing reaches the slide: title, goal and milestone titles.
      // Role prompts, evaluation data and chat history never do.
      const typeLabel = t('export.placeholder.pblLabel');
      const briefing = readPblBriefing(content);
      const goal = asText(briefing?.learningObjective) || asText(briefing?.scenario?.goal);
      const milestones = (briefing?.milestones ?? [])
        .slice()
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      const items = milestones
        .slice(0, MAX_PBL_MILESTONES)
        .map((milestone) => truncateToWidth(asText(milestone.title), MAX_PBL_MILESTONE_WIDTH))
        .filter(Boolean);
      // No "…" line for more milestones: the count above says how many.
      deck.push({
        kind: 'placeholder',
        placeholder: {
          scene,
          sceneType: 'pbl',
          typeLabel,
          title: title || truncate(asText(briefing?.title), MAX_TITLE_LENGTH) || typeLabel,
          description: t('export.placeholder.pblDesc'),
          online: onlineLink(scene),
          lead: goal
            ? t('export.placeholder.pblGoal', { goal: truncateToWidth(goal, MAX_PBL_GOAL_WIDTH) })
            : undefined,
          meta: milestones.length
            ? t('export.placeholder.pblMilestoneCount', { count: milestones.length })
            : undefined,
          items,
        },
      });
    }
  }

  return deck;
}

/** Deck with only the slide scenes, in order (the layout before placeholders). */
export function slidesOnlyDeck(slideCount: number): PptxDeckEntry[] {
  return Array.from({ length: slideCount }, (_, slideIndex) => ({
    kind: 'slide' as const,
    slideIndex,
  }));
}

/**
 * 1-based PPTX slide number for each slide id, after placeholders are
 * inserted. Slide-to-slide links resolve through this map.
 */
export function pptxSlideNumbers(
  deck: readonly PptxDeckEntry[],
  slides: readonly Slide[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  deck.forEach((entry, position) => {
    if (entry.kind === 'slide') {
      const slide = slides[entry.slideIndex];
      if (slide) numbers.set(slide.id, position + 1);
    }
  });
  return numbers;
}

// ── Placeholder rendering ──

const FALLBACK_THEME = {
  backgroundColor: '#ffffff',
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  accent: '#5b6cf9',
};

export interface PlaceholderStyle {
  backgroundColor: string;
  fontColor: string;
  fontName: string;
  accent: string;
}

function opaqueHex(color: string | undefined, fallback: string): string {
  const c = tinycolor(color || '');
  return c.isValid() && c.getAlpha() > 0 ? c.setAlpha(1).toHexString() : fallback;
}

/** Placeholder colors and font, taken from the deck's first slide theme. */
export function placeholderStyleFor(slides: readonly Slide[]): PlaceholderStyle {
  const theme = slides[0]?.theme;
  return {
    backgroundColor: opaqueHex(theme?.backgroundColor, FALLBACK_THEME.backgroundColor),
    fontColor: opaqueHex(theme?.fontColor, FALLBACK_THEME.fontColor),
    fontName: theme?.fontName || FALLBACK_THEME.fontName,
    accent: opaqueHex(theme?.themeColors?.[0], FALLBACK_THEME.accent),
  };
}

/** QR code edge length on the 1000px design canvas (about a fifth of the width). */
const QR_SIZE = 210;

type Bounds = { x: number; y: number; w: number; h: number };

/**
 * Make an area clickable with a top-most, text-less, invisible shape that
 * carries the link. Viewers differ in which part of a link they honour: WPS
 * ignores a link on a shape covered by a text box and advances the slideshow
 * instead, but follows one on an uncovered shape. So every link is also put on
 * a hotspot drawn after (above) the visible element. The fill is transparent
 * rather than absent because some viewers only hit-test the outline of a shape
 * without fill; the outline is transparent too.
 */
function addLinkHotspot(
  pptxSlide: pptxgen.Slide,
  bounds: Bounds,
  hyperlink: pptxgen.HyperlinkProps,
): void {
  pptxSlide.addShape('rect' as pptxgen.ShapeType, {
    ...bounds,
    fill: { color: '#ffffff', transparency: 100 },
    line: { color: '#ffffff', transparency: 100 },
    hyperlink,
  });
}

/**
 * Draw a placeholder card on an empty PPTX slide. Coordinates are designed on
 * a 1000px-wide canvas and scaled to the deck's viewport, like slide elements.
 *
 * Left column: type label, title, description, quiz summary, and at the bottom
 * the "Open online" button and the offline link. Right column (when the scene
 * has an online link): the QR code and the URL under it. The QR code
 * is always dark on white whatever the theme, so phones can scan it.
 */
export function renderScenePlaceholder(
  pptxSlide: pptxgen.Slide,
  placeholder: ScenePlaceholder,
  style: PlaceholderStyle,
  viewport: { viewportSize: number; viewportRatio: number },
  ratios: { ratioPx2Inch: number; ratioPx2Pt: number },
  qrDataUrl?: string,
): void {
  const { viewportSize, viewportRatio } = viewport;
  const { ratioPx2Inch, ratioPx2Pt } = ratios;
  const u = viewportSize / 1000;
  const height = viewportSize * viewportRatio;
  const inch = (px: number) => px / ratioPx2Inch;
  const pt = (px: number) => px / ratioPx2Pt;
  const left = 80 * u;
  const online = placeholder.online;
  const qrLeft = viewportSize - (80 + QR_SIZE) * u;
  const width = online ? qrLeft - left - 40 * u : viewportSize - 160 * u;
  const actionsTop = height - 130 * u;
  const font = { fontFace: style.fontName, color: style.fontColor };

  pptxSlide.background = { color: style.backgroundColor };

  // Accent bar + scene-type label
  pptxSlide.addShape('rect' as pptxgen.ShapeType, {
    x: inch(left),
    y: inch(92 * u),
    w: inch(6 * u),
    h: inch(26 * u),
    fill: { color: style.accent },
    line: { type: 'none' },
  });
  pptxSlide.addText(placeholder.typeLabel, {
    x: inch(left + 16 * u),
    y: inch(88 * u),
    w: inch(width - 16 * u),
    h: inch(34 * u),
    fontFace: style.fontName,
    color: style.accent,
    fontSize: pt(20 * u),
    bold: true,
    margin: 0,
    valign: 'middle',
  });

  pptxSlide.addText(placeholder.title, {
    ...font,
    x: inch(left),
    y: inch(132 * u),
    w: inch(width),
    h: inch(96 * u),
    fontSize: pt(36 * u),
    bold: true,
    margin: 0,
    valign: 'top',
    fit: 'shrink',
  });

  pptxSlide.addText(placeholder.description, {
    ...font,
    x: inch(left),
    y: inch(238 * u),
    w: inch(width),
    h: inch(56 * u),
    fontSize: pt(18 * u),
    margin: 0,
    valign: 'top',
    transparency: 20,
  });

  // A slide with a lead line (PBL: goal, milestone count, milestones) packs
  // its summary tighter so four list items still fit above the button.
  const compact = !!placeholder.lead;
  const listFontSize = compact ? 15 : 16;
  let y = (compact ? 288 : 300) * u;
  if (placeholder.lead) {
    pptxSlide.addText(placeholder.lead, {
      ...font,
      x: inch(left),
      y: inch(y),
      w: inch(width),
      h: inch(22 * u),
      fontSize: pt(15 * u),
      margin: 0,
      valign: 'middle',
    });
    y += 24 * u;
  }
  if (placeholder.meta) {
    pptxSlide.addText(placeholder.meta, {
      ...font,
      x: inch(left),
      y: inch(y),
      w: inch(width),
      h: inch((compact ? 22 : 30) * u),
      fontSize: pt((compact ? 16 : 18) * u),
      bold: true,
      margin: 0,
      valign: 'middle',
    });
    y += (compact ? 26 : 38) * u;
  }

  if (placeholder.items?.length) {
    // Numbers are written into the text: auto-numbered bullets restart on
    // every paragraph in some viewers.
    const items = placeholder.items;
    pptxSlide.addText(
      items.map((text, i) => ({
        text: text === '…' ? text : `${i + 1}. ${text}`,
        options: { breakLine: i < items.length - 1 },
      })),
      {
        ...font,
        x: inch(left),
        y: inch(y),
        w: inch(width),
        h: inch(Math.max(actionsTop - y - (compact ? 6 : 12) * u, 30 * u)),
        fontSize: pt(listFontSize * u),
        margin: 0,
        valign: 'top',
        paraSpaceBefore: pt((compact ? 2 : 4) * u),
        fit: 'shrink',
      },
    );
  }

  if (online) {
    const button = { x: inch(left), y: inch(actionsTop), w: inch(260 * u), h: inch(52 * u) };
    const hyperlink = { url: online.url, tooltip: online.url };
    // The shape and the text run carry the link for viewers that honour
    // them; the hotspot added last makes the whole button clickable in all.
    pptxSlide.addShape('roundRect' as pptxgen.ShapeType, {
      ...button,
      fill: { color: style.accent },
      line: { type: 'none' },
      rectRadius: inch(10 * u),
      hyperlink,
    });
    pptxSlide.addText(
      [
        {
          text: online.label,
          options: {
            hyperlink,
            color: '#ffffff',
            bold: true,
            underline: { style: 'none' },
            fontFace: style.fontName,
          },
        },
      ],
      { ...button, fontSize: pt(20 * u), align: 'center', valign: 'middle', margin: 0 },
    );
    addLinkHotspot(pptxSlide, button, hyperlink);

    if (qrDataUrl) {
      // No hyperlink on the image: pptxgenjs does not XML-escape image link
      // targets, and the button already carries the link.
      pptxSlide.addImage({
        data: qrDataUrl,
        x: inch(qrLeft),
        y: inch(132 * u),
        w: inch(QR_SIZE * u),
        h: inch(QR_SIZE * u),
      });
    }
    const urlText = {
      x: inch(qrLeft),
      y: inch((132 + QR_SIZE + 8) * u),
      w: inch(QR_SIZE * u),
      h: inch(48 * u),
    };
    pptxSlide.addText([{ text: online.url, options: { hyperlink, color: style.fontColor } }], {
      ...urlText,
      fontFace: style.fontName,
      fontSize: pt(10 * u),
      // Left-aligned: the URL is one long word, which some renderers centre
      // as if it were unbroken and so push off to the left.
      align: 'left',
      valign: 'top',
      margin: 0,
    });
    // One hotspot over the QR code and the URL under it.
    addLinkHotspot(
      pptxSlide,
      qrDataUrl
        ? {
            x: inch(qrLeft),
            y: inch(132 * u),
            w: urlText.w,
            h: urlText.y + urlText.h - inch(132 * u),
          }
        : urlText,
      hyperlink,
    );
  }

  if (placeholder.offline) {
    const offline = placeholder.offline;
    const hyperlink = { url: offline.target, tooltip: offline.path };
    const line = {
      x: inch(left),
      y: inch(online ? actionsTop + 62 * u : actionsTop),
      w: inch(width),
      h: inch(28 * u),
    };
    pptxSlide.addText(
      [
        {
          text: offline.label,
          options: { hyperlink, color: style.accent, bold: true, fontFace: style.fontName },
        },
        { text: ` · ${offline.hint}`, options: { color: style.fontColor } },
      ],
      {
        ...line,
        fontFace: style.fontName,
        fontSize: pt(14 * u),
        margin: 0,
        valign: 'middle',
      },
    );
    addLinkHotspot(pptxSlide, line, hyperlink);
  }
}
