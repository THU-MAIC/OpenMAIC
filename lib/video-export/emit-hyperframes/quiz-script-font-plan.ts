/** Pure script-font selection for a rendered Quiz question-list surface. */
import { NOTO_SCRIPT_FONT_PLANS } from './noto-script-font-assets';

export type QuizScriptFont = 'cyrillic' | 'arabic';

export interface QuizFontPlan {
  readonly scripts: readonly QuizScriptFont[];
  readonly measurementCss: string;
  readonly exportCss: string;
  readonly assets: readonly { readonly path: string; readonly sourceUrl: string }[];
  readonly licenses: readonly { readonly path: string; readonly content: string }[];
  readonly requiredFontLoads: readonly { readonly family: string; readonly text: string }[];
}

const SCRIPT_ORDER: readonly QuizScriptFont[] = ['cyrillic', 'arabic'];
const SCRIPT_PATTERNS: Record<QuizScriptFont, RegExp> = {
  cyrillic: /\p{Script_Extensions=Cyrillic}/u,
  arabic: /\p{Script_Extensions=Arabic}/u,
};
const PRIMARY_SCRIPT_PATTERNS: Record<QuizScriptFont, RegExp> = {
  cyrillic: /\p{Script=Cyrillic}/u,
  arabic: /\p{Script=Arabic}/u,
};

function visibleScriptCodePoints(
  surfaceMarkup: readonly string[],
  script: QuizScriptFont,
): { primary: number[]; extended: number[] } {
  const primary = new Set<number>();
  const extended = new Set<number>();
  for (const markup of surfaceMarkup) {
    for (const character of markup) {
      // Script_Extensions includes inherited combining marks such as U+0301.
      // Require a primary script character as the pack-selection signal so a
      // decomposed Latin accent cannot make an otherwise Latin Quiz load Cyrillic.
      if (!SCRIPT_PATTERNS[script].test(character)) continue;
      const codePoint = character.codePointAt(0)!;
      extended.add(codePoint);
      if (PRIMARY_SCRIPT_PATTERNS[script].test(character)) primary.add(codePoint);
    }
  }
  return { primary: [...primary], extended: [...extended] };
}

function isCovered(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function planQuizScriptFonts(surfaceMarkup: readonly string[]): QuizFontPlan {
  const codePointsByScript = Object.fromEntries(
    SCRIPT_ORDER.map((script) => [script, visibleScriptCodePoints(surfaceMarkup, script)]),
  ) as Record<QuizScriptFont, { primary: number[]; extended: number[] }>;
  const scripts = SCRIPT_ORDER.filter((script) => {
    const codePoints = codePointsByScript[script];
    // Arabic punctuation and elongation marks use Script=Common with
    // Script_Extensions=Arabic. Cyrillic keeps the primary-character gate so
    // inherited accents such as U+0301 on Latin text do not select its pack.
    return script === 'arabic' ? codePoints.extended.length > 0 : codePoints.primary.length > 0;
  });
  const measurementCss: string[] = [];
  const exportCss: string[] = [];
  const assets: { path: string; sourceUrl: string }[] = [];
  const licenses: { path: string; content: string }[] = [];
  const requiredFontLoads: { family: string; text: string }[] = [];
  for (const script of scripts) {
    const selected = NOTO_SCRIPT_FONT_PLANS[script];
    measurementCss.push(selected.measurementCss);
    exportCss.push(selected.exportCss);
    assets.push(...selected.assets.map((asset) => ({ ...asset })));
    licenses.push(...selected.licenses.map((license) => ({ ...license })));
    requiredFontLoads.push(...selected.requiredFontLoads.map((fontLoad) => ({ ...fontLoad })));
    const unsupported = codePointsByScript[script].extended.filter(
      (codePoint) => !isCovered(codePoint, selected.coverage),
    );
    if (unsupported.length > 0) {
      requiredFontLoads.push({
        family: selected.requiredFontLoads[0].family,
        text: unsupported.map((codePoint) => String.fromCodePoint(codePoint)).join(''),
      });
    }
  }
  return {
    scripts,
    measurementCss: measurementCss.join('\n'),
    exportCss: exportCss.join('\n'),
    assets,
    licenses,
    requiredFontLoads,
  };
}
