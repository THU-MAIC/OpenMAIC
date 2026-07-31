/**
 * Typography defaults for generated slide text.
 */

/**
 * Typeface applied to slide text when a document does not name one.
 *
 * Every producer in the SDK family — the scene generator, the action engine,
 * the editor defaults, the PPTX exporter, the DSL normalizer — needs the same
 * answer to "what font when the document is silent?". Before this constant
 * that answer was written out as a string literal in each of them, so the
 * question had two dozen separate answers that only happened to agree.
 *
 * The value is unchanged: `Microsoft YaHei`, which ships with Windows and
 * covers Simplified Chinese well.
 *
 * ## Why a deployment may need to retarget this
 *
 * The face is chosen for Chinese and its coverage stops there. Checked against
 * `C:\Windows\Fonts\msyh.ttc` (fontTools `getBestCmap`), seven of eight sampled
 * Vietnamese letters have no glyph:
 *
 * | code point | letter | in font |
 * | ---------- | ------ | ------- |
 * | U+1EBF     | ế      | no      |
 * | U+1ED9     | ộ      | no      |
 * | U+1EEF     | ữ      | no      |
 * | U+1EA1     | ạ      | no      |
 * | U+01B0     | ư      | no      |
 * | U+01A1     | ơ      | no      |
 * | U+1EB1     | ằ      | no      |
 * | U+0111     | đ      | yes     |
 *
 * A missing glyph does not fail loudly. The browser silently substitutes
 * another installed face for that one character, so a Vietnamese slide renders
 * in two typefaces interleaved — weight and spacing shift mid-word. The PPTX
 * exporter writes the face name into the OOXML and PowerPoint substitutes the
 * same way. Latin-script languages with rich diacritics (Vietnamese) and every
 * non-CJK script (Devanagari, Thai, Arabic, Korean) hit this.
 *
 * Retargeting is now an edit here rather than an audit of every producer. Two
 * further constraints apply:
 *
 * - The `@default` annotations on `defaultFontName` in `slides.ts` must be
 *   changed to match. They are JSDoc, so they cannot reference this constant;
 *   they are compiled into the published JSON Schema, and the schema-lockstep
 *   test in `test/normalize.test.ts` fails if the two disagree. Forgetting is
 *   loud, not silent.
 * - The name must be a single font family, not a CSS fallback list. The
 *   renderer would accept a list, but the PPTX exporter passes this straight
 *   through as an OOXML `fontFace`, where only one family name is valid.
 */
export const DEFAULT_SLIDE_FONT = 'Microsoft YaHei';
