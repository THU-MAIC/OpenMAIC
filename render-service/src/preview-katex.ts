/**
 * KaTeX stylesheet for slide previews.
 *
 * `@openmaic/renderer` typesets formulas (inline formulas in prose and LaTeX
 * elements) as KaTeX HTML, which only lays out correctly with KaTeX's CSS and
 * math fonts; the host page is expected to load them. A preview document is
 * set with `setContent` (an `about:blank` URL), so the stylesheet's relative
 * font URLs cannot resolve: each face is inlined as its woff2 data URL instead.
 *
 * The stylesheet comes from the KaTeX copy the renderer itself resolves, so
 * the CSS always matches the markup it styles.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const FONT_FACE = /@font-face\{([^}]*)\}/g;
const WOFF2_SOURCE = /url\(fonts\/([\w.-]+\.woff2)\)/;

/** Directory holding `katex.min.css` and `fonts/` for the renderer's KaTeX. */
export function resolveKatexDistDirectory(): string {
  const require = createRequire(import.meta.url);
  // `fonts.css` is exported without conditions, so it resolves from CommonJS
  // and locates the renderer package; KaTeX is resolved from there.
  const rendererAsset = require.resolve('@openmaic/renderer/fonts.css');
  return dirname(createRequire(rendererAsset).resolve('katex'));
}

/**
 * Replace every `@font-face` source list with the face's woff2 inlined as a
 * data URL. Throws if a face has no woff2 source, rather than shipping a face
 * that can never load.
 */
export function inlineKatexFonts(css: string, readFont: (file: string) => Buffer): string {
  return css.replace(FONT_FACE, (_rule, body: string) => {
    const woff2 = body.match(WOFF2_SOURCE);
    if (!woff2) throw new Error(`KaTeX @font-face without a woff2 source: ${body.slice(0, 80)}`);
    const data = readFont(woff2[1]).toString('base64');
    const declarations = body
      .split(';')
      .filter((declaration) => !declaration.trim().startsWith('src:'))
      .concat(`src:url(data:font/woff2;base64,${data}) format("woff2")`);
    return `@font-face{${declarations.join(';')}}`;
  });
}

let katexStylesheet: string | undefined;

/** KaTeX CSS with inlined fonts, read once per service process. */
export function katexPreviewStylesheet(): string {
  if (katexStylesheet === undefined) {
    const dist = resolveKatexDistDirectory();
    katexStylesheet = inlineKatexFonts(readFileSync(join(dist, 'katex.min.css'), 'utf8'), (file) =>
      readFileSync(join(dist, 'fonts', file)),
    );
  }
  return katexStylesheet;
}
