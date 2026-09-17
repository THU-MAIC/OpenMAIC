/**
 * MTEF v.3 → LaTeX converter for Microsoft Equation 3.0 OLE objects.
 *
 * Legacy courseware embeds formulas as OLE equation objects
 * (`progId="Equation.3"` / MathType). Their only renderable form inside the
 * .pptx is a WMF preview picture, which cannot be rasterized in this
 * environment — but the OLE binary also carries an `Equation Native` stream
 * whose payload, behind a 28-byte EQNOLEFILEHDR, is MTEF v3: a compact
 * record tree (CHAR / TMPL / LINE / EMBELL / typesize records) that fully
 * describes the equation. This module parses that binary into LaTeX so those
 * formulas import as editable `latex` elements instead of blank placeholders.
 *
 * Grammar reference: MathType MTEF v.3 (archived spec, rtf2latex2e). Tag byte
 * = record type in the low nibble, option flags in the high nibble
 * (flag 0x01 → 0x10, 0x02 → 0x20, 0x04 → 0x40, 0x08 → 0x80). All 16-bit
 * values are little-endian; v3 CHAR records always store a 16-bit character.
 *
 * Empirical notes from Equation Editor 3.x streams (validated against real
 * courseware decks): tmROOT emits slots as [radicand, null-degree] for square
 * roots; tmSCRIPT emits a null LINE for its unused slot, ordered [sub, sup];
 * fence templates carry their left/right fence CHARs at the END of their own
 * sub-object list, AFTER the main slot LINE.
 *
 * Scope note: this targets the record set Equation Editor 3.x actually emits
 * (CHAR, LINE, TMPL fences/fraction/root/scripts/big-ops, EMBELL, typesize,
 * PILE, MATRIX). Newer MathType MTEF v5 streams are rejected and fall back to
 * the picture path. Unknown constructs degrade to their slot contents rather
 * than failing the whole equation.
 */

export interface MtefConversion {
  latex: string;
  /** Flat character content, used as degrade-text when LaTeX is not viable. */
  plainText: string;
  /** True when at least one construct was skipped or approximated. */
  degraded: boolean;
}

/** Thrown when the stream is not MTEF v3 or the bytes cannot be walked. */
export class MtefParseError extends Error {}

// ---------------------------------------------------------------------------
// Record grammar (tag = type | options<<4)
// ---------------------------------------------------------------------------

const TAG_END = 0x0;
const TAG_LINE = 0x1;
const TAG_CHAR = 0x2;
const TAG_TMPL = 0x3;
const TAG_PILE = 0x4;
const TAG_MATRIX = 0x5;
const TAG_EMBELL = 0x6;
const TAG_RULER = 0x7;
const TAG_FONT = 0x8;
const TAG_SIZE = 0x9;

const OPT_LMOVE = 0x8; // nudge follows (LINE/CHAR/TMPL/PILE/MATRIX/EMBELL)
const OPT_NULL = 0x1; // LINE: placeholder only, no object list
const OPT_LSPACE = 0x4; // LINE: line-spacing value follows
const OPT_RULER = 0x2; // LINE/PILE: RULER record follows
const OPT_EMBELL = 0x2; // CHAR: embellishment list follows

// Template selectors (MTEF v3).
const TM_PAREN = 1;
const TM_BRACE = 2;
const TM_BRACK = 3;
const TM_BAR = 4;
const TM_DBAR = 5;
const TM_FLOOR = 6;
const TM_CEILING = 7;
const TM_ROOT = 13;
const TM_FRACT = 14;
const TM_SCRIPT = 15;
const TM_UBAR = 16;
const TM_OBAR = 17;
const TM_LARROW = 18;
const TM_RARROW = 19;
const TM_BARROW = 20;
// TM_BIGOP_FIRST selectors are now encoded in bigOpLimits() 21; // tmSINT .. tmIINTER: operators with limit slots
// TM_BIGOP_LAST selectors are now encoded in bigOpLimits() 38;
const TM_LIM = 39;
const TM_SLFRACT = 41;
const TM_INTOP = 42;
const TM_LSCRIPT = 44;
const TM_DIRAC = 45;
const TM_UARROW = 46;
const TM_OARROW = 47;
const TM_OARC = 48;

const FENCE_PAIRS: Record<number, [string, string]> = {
  [TM_PAREN]: ['\\left ( ', '\\right ) '],
  0: ['\\left \\langle ', '\\right \\rangle '], // tmANGLE
  8: ['\\left [ ', '\\right [ '], // tmLBLB
  9: ['\\left ] ', '\\right ] '], // tmRBRB
  10: ['\\left ] ', '\\right [ '], // tmRBLB
  11: ['\\left [ ', '\\right ) '], // tmLBRP
  12: ['\\left ( ', '\\right ] '], // tmLPRB
  [TM_BRACE]: ['\\left \\{ ', '\\right \\} '],
  [TM_BRACK]: ['\\left [ ', '\\right ] '],
  [TM_BAR]: ['\\left | ', '\\right | '],
  [TM_DBAR]: ['\\left \\| ', '\\right \\| '],
  [TM_FLOOR]: ['\\left \\lfloor ', '\\right \\rfloor '],
  [TM_CEILING]: ['\\left \\lceil ', '\\right \\rceil '],
  [TM_DIRAC]: ['\\left \\langle ', '\\right \\rangle '],
};

// v3 selectors 24/25/26 are tmSSINT/tmDSINT/tmTSINT ("summation-style"
// integrals — limits above/below); contour integrals come from tmSINT
// variations 3/4, not from separate selectors.
const BIG_OPS: Record<number, string> = {
  21: '\\int ',
  22: '\\iint ',
  23: '\\iiint ',
  24: '\\int \\limits ',
  25: '\\iint \\limits ',
  26: '\\iiint \\limits ',
  29: '\\sum ',
  30: '\\sum ',
  31: '\\prod ',
  32: '\\prod ',
  33: '\\coprod ',
  34: '\\coprod ',
  35: '\\bigcup ',
  36: '\\bigcup ',
  37: '\\bigcap ',
  38: '\\bigcap ',
  [TM_INTOP]: '\\int ',
  43: '\\sum ',
};

/** Per-selector variation → which limit slots exist (v3 variation tables). */
function bigOpLimits(selector: number, variation: number): { lower: boolean; upper: boolean } {
  switch (selector) {
    case 21:
      return {
        lower: variation === 1 || variation === 2 || variation === 4,
        upper: variation === 2,
      };
    case 22:
    case 23:
      return { lower: variation === 1 || variation === 3, upper: false };
    case 24:
      return { lower: true, upper: variation === 0 };
    case 25:
    case 26:
      return { lower: true, upper: false };
    case 29:
    case 31:
    case 33:
    case 35:
    case 37:
      return { lower: variation === 0 || variation === 1, upper: variation === 1 };
    case 30:
    case 32:
    case 34:
    case 36:
    case 38:
      // This family has only tvL* (0, lower-only) and tvB* (1, both).
      return { lower: variation === 0 || variation === 1, upper: variation === 1 };
    case TM_INTOP:
    case 43:
      return {
        lower: variation === 1 || variation === 2,
        upper: variation === 0 || variation === 2,
      };
    default:
      return { lower: false, upper: false };
  }
}

const EMBELL_LATEX: Record<number, string> = {
  2: '\\dot ',
  3: '\\ddot ',
  4: '\\dddot ',
  5: "'",
  6: "''",
  7: '`',
  18: "'''",
  8: '\\tilde ',
  9: '\\hat ',
  10: '\\not ',
  11: '\\overrightarrow ',
  12: '\\overleftarrow ',
  13: '\\overleftrightarrow ',
  14: '\\overrightarrow ',
  15: '\\overleftarrow ',
  17: '\\bar ',
};

/**
 * Unicode operator/symbol codepoints with direct LaTeX commands. Values carry
 * a trailing space when letter-terminated: KaTeX absorbs a following letter
 * into the command name otherwise (`\cdotb`).
 */
const SYMBOL_LATEX: Record<number, string> = {
  0x22c5: '\\cdot ',
  0x00d7: '\\times ',
  0x00f7: '\\div ',
  0x00b1: '\\pm ',
  0x2213: '\\mp ',
  0x2264: '\\le ',
  0x2265: '\\ge ',
  0x2260: '\\ne ',
  0x2248: '\\approx ',
  0x2261: '\\equiv ',
  0x223c: '\\sim ',
  0x221d: '\\propto ',
  0x221e: '\\infty ',
  0x2208: '\\in ',
  0x2209: '\\notin ',
  0x2282: '\\subset ',
  0x2286: '\\subseteq ',
  0x2283: '\\supset ',
  0x2287: '\\supseteq ',
  0x222a: '\\cup ',
  0x2229: '\\cap ',
  0x2227: '\\land ',
  0x2228: '\\lor ',
  0x2200: '\\forall ',
  0x2203: '\\exists ',
  0x2205: '\\emptyset ',
  0x2202: '\\partial ',
  0x2211: '\\sum ',
  0x220f: '\\prod ',
  0x222b: '\\int ',
  0x2192: '\\to ',
  0x21d2: '\\Rightarrow ',
  0x21d4: '\\Leftrightarrow ',
  0x2026: '\\ldots ',
  0x22ef: '\\cdots ',
  0x226a: '\\ll ',
  0x226b: '\\gg ',
  0x00b0: '^{\\circ}',
};

// ---------------------------------------------------------------------------
// Binary cursor
// ---------------------------------------------------------------------------

class Cursor {
  pos: number;
  constructor(
    private readonly data: Uint8Array,
    startPos: number,
    private readonly endPos: number,
  ) {
    this.pos = startPos;
  }

  get eof(): boolean {
    return this.pos >= this.endPos;
  }

  byte(): number {
    if (this.eof) throw new MtefParseError('unexpected end of MTEF stream');
    return this.data[this.pos++]!;
  }

  uint16(): number {
    const lo = this.byte();
    return lo | (this.byte() << 8);
  }

  skipNudge(): void {
    const dx = this.byte();
    const dy = this.byte();
    if (dx === 128 && dy === 128) {
      this.uint16();
      this.uint16();
    }
  }

  /**
   * RULER body (tag already consumed): n_stops, then per stop a 1-byte tab
   * type followed by a 16-bit offset (v3 spec).
   */
  skipRulerBody(): void {
    const nStops = this.byte();
    for (let i = 0; i < nStops; i++) {
      this.byte(); // tab-stop type
      this.uint16(); // offset
    }
  }

  /**
   * A complete RULER record (tag included) — what xfRULER promises. Real
   * streams occasionally omit the RULER tag (see rtf2latex2e's eqn.c); a
   * non-RULER first byte is left in place and treated as a zero-stop ruler.
   */
  skipRulerRecord(): void {
    if ((this.data[this.pos]! & 0x0f) === 0x7) {
      this.byte();
      this.skipRulerBody();
    }
  }
}

const MAX_RECORDS = 20_000;
const MAX_DEPTH = 200;
const MAX_LATEX_LENGTH = 64 * 1024;

interface CharNode {
  kind: 'char';
  code: number;
  typeface: number;
  embellishments: number[];
}
interface TmplNode {
  kind: 'tmpl';
  selector: number;
  variation: number;
  options: number;
  children: Node[];
}
interface LineNode {
  kind: 'line';
  content: Node[];
}
type Node = CharNode | TmplNode | LineNode | { kind: 'other' };

function parseObjectList(cur: Cursor, budget: { count: number }, depth = 0): Node[] {
  if (depth > MAX_DEPTH) throw new MtefParseError('MTEF nesting too deep');
  const nodes: Node[] = [];
  while (!cur.eof) {
    if (++budget.count > MAX_RECORDS) throw new MtefParseError('MTEF stream too large');
    const tag = cur.byte();
    const type = tag & 0x0f;
    const options = (tag >> 4) & 0x0f;
    if (type === TAG_END) return nodes;
    switch (type) {
      case TAG_LINE: {
        if (options & OPT_LMOVE) cur.skipNudge();
        if (options & OPT_LSPACE) cur.byte();
        if (options & OPT_RULER) cur.skipRulerRecord();
        if (options & OPT_NULL) {
          nodes.push({ kind: 'line', content: [] });
        } else {
          nodes.push({ kind: 'line', content: parseObjectList(cur, budget, depth + 1) });
        }
        break;
      }
      case TAG_CHAR: {
        if (options & OPT_LMOVE) cur.skipNudge();
        const typeface = cur.byte();
        const code = cur.uint16();
        const embellishments: number[] = [];
        if (options & OPT_EMBELL) {
          for (;;) {
            if (++budget.count > MAX_RECORDS) throw new MtefParseError('MTEF stream too large');
            const etag = cur.byte();
            const etype = etag & 0x0f;
            const eopts = (etag >> 4) & 0x0f;
            if (etype === TAG_END) break;
            if (etype !== TAG_EMBELL)
              throw new MtefParseError('non-EMBELL inside embellishment list');
            if (eopts & OPT_LMOVE) cur.skipNudge();
            embellishments.push(cur.byte());
          }
        }
        nodes.push({ kind: 'char', code, typeface, embellishments });
        break;
      }
      case TAG_TMPL: {
        if (options & OPT_LMOVE) cur.skipNudge();
        const selector = cur.byte();
        const variation = cur.byte();
        const tmplOptions = cur.byte();
        const children = parseObjectList(cur, budget, depth + 1);
        nodes.push({ kind: 'tmpl', selector, variation, options: tmplOptions, children });
        break;
      }
      case TAG_PILE: {
        // v3 field order: nudge → halign → valign → [complete RULER record].
        if (options & OPT_LMOVE) cur.skipNudge();
        cur.byte(); // halign
        cur.byte(); // valign
        if (options & OPT_RULER) cur.skipRulerRecord();
        const children = parseObjectList(cur, budget, depth + 1);
        nodes.push({ kind: 'tmpl', selector: -1, variation: 0, options: 0, children });
        break;
      }
      case TAG_MATRIX: {
        // v3 uses single-byte fields (16-bit valign_2 is an MTEF v5 field).
        if (options & OPT_LMOVE) cur.skipNudge();
        cur.byte(); // valign
        cur.byte(); // h_just
        cur.byte(); // v_just
        const rows = cur.byte();
        const cols = cur.byte();
        // Partition lines: 2 bits per line (rows+1 / cols+1), byte-rounded.
        const partBytes = Math.ceil(((rows + 1) * 2) / 8) + Math.ceil(((cols + 1) * 2) / 8);
        for (let i = 0; i < partBytes; i++) cur.byte();
        const children = parseObjectList(cur, budget, depth + 1);
        nodes.push({ kind: 'tmpl', selector: -2, variation: 0, options: 0, children });
        break;
      }
      case TAG_EMBELL: {
        // Bare embellishment outside a CHAR list (unexpected); skip payload.
        if (options & OPT_LMOVE) cur.skipNudge();
        cur.byte();
        break;
      }
      case TAG_RULER:
        cur.skipRulerBody();
        break;
      case TAG_FONT:
        cur.byte(); // tface
        cur.byte(); // style
        for (;;) {
          if (cur.eof) break;
          if (cur.byte() === 0) break; // null-terminated font name
        }
        break;
      case TAG_SIZE: {
        // v3 has three forms (spec): "9, 101, -lsize(16)" explicit point size;
        // "9, 100, lsize, dsize(16)" large delta; "9, lsize, dsize+128" small
        // delta. The first byte discriminates.
        const form = cur.byte();
        if (form === 101) cur.uint16();
        else if (form === 100) {
          cur.byte();
          cur.uint16();
        } else {
          cur.byte(); // dsize + 128
        }
        break;
      }
      default:
        // FULL/SUB/SUB2/SYM/SUBSYM (10-14) carry no payload.
        if (type < 10 || type > 14) throw new MtefParseError(`unknown MTEF record type ${type}`);
        break;
    }
  }
  // Nested lists are END-terminated; reaching EOF below the top level means
  // the stream was truncated mid-equation and the tree would silently lose
  // content — fail loud so the caller falls back to the picture path.
  if (depth > 0) throw new MtefParseError('truncated MTEF stream (unterminated nested list)');
  return nodes;
}

// ---------------------------------------------------------------------------
// Tree → LaTeX
// ---------------------------------------------------------------------------

interface RenderState {
  degraded: boolean;
}

/**
 * Adobe Symbol-font code → LaTeX for font-local 8-bit codes. The Greek and
 * symbol typefaces (fnLCGREEK/fnUCGREEK/fnSYMBOL) store glyphs in the Symbol
 * font encoding (0x61 = α, 0x71 = θ …), NOT ASCII/Unicode — decoding them as
 * text turns α into `a`. Codes ≥ 0x100 are MTCode/Unicode and skip this table.
 */
const SYMBOL_FONT_LATEX: Record<number, string> = {
  // Adobe Symbol font encoding (verified against URW StandardSymbolsPS AFM
  // + Adobe AGL): covers the Greek block and every punctuation/operator
  // position where Symbol differs from ASCII. Unmapped font-local bytes
  // >= 0xA0 pass through and flag degraded (see charLatex).
  0x22: '\\forall ',
  0x24: '\\exists ',
  0x27: '\\ni ',
  0x2a: '\\ast ',
  0x2d: '-',
  0x5e: '\\perp ',
  0x3c: '<',
  0x3e: '>',
  0x5b: '[',
  0x5d: ']',
  0x5c: '\\therefore ',
  0x40: '\\cong ',
  0x7e: '\\sim ',
  0x61: '\\alpha ',
  0x62: '\\beta ',
  0x63: '\\chi ',
  0x64: '\\delta ',
  0x65: '\\epsilon ',
  0x66: '\\varphi ',
  0x67: '\\gamma ',
  0x68: '\\eta ',
  0x69: '\\iota ',
  0x6a: '\\phi ',
  0x6b: '\\kappa ',
  0x6c: '\\lambda ',
  0x6d: '\\mu ',
  0x6e: '\\nu ',
  0x6f: 'o',
  0x70: '\\pi ',
  0x71: '\\theta ',
  0x72: '\\rho ',
  0x73: '\\sigma ',
  0x74: '\\tau ',
  0x75: '\\upsilon ',
  0x76: '\\varpi ',
  0x77: '\\omega ',
  0x78: '\\xi ',
  0x79: '\\psi ',
  0x7a: '\\zeta ',
  0x41: 'A',
  0x42: 'B',
  0x43: 'X',
  0x44: '\\Delta ',
  0x45: 'E',
  0x46: '\\Phi ',
  0x47: '\\Gamma ',
  0x48: 'H',
  0x49: 'I',
  0x4a: '\\vartheta ',
  0x4b: 'K',
  0x4c: '\\Lambda ',
  0x4d: 'M',
  0x4e: 'N',
  0x4f: 'O',
  0x50: '\\Pi ',
  0x51: '\\Theta ',
  0x52: 'P',
  0x53: '\\Sigma ',
  0x54: 'T',
  0x55: '\\Upsilon ',
  0x56: '\\varsigma ',
  0x57: '\\Omega ',
  0x58: '\\Xi ',
  0x59: '\\Psi ',
  0x5a: 'Z',
  // Adobe Symbol high half (~50 of ~70 defined 0xA0–0xFF positions from the
  // URW AFM; excluded: suits, ®/©/™, fraktur, extrema pieces → throw); positions not listed
  // here throw MtefParseError so the formula falls back to its picture. Font-local
  // codes here are glyph indices into the Symbol font; unmapped ones must
  // NOT pass through as Latin-1 (0xF4 is integralex, not a blank). Structural
  // pieces (big-paren/large-op extenders) map to their base operators;
  // playing-card suits and serif-mark glyphs are excluded — they flag
  // degraded via the unmapped path.
  0xa2: "' ",
  0xa3: '\\le ',
  0xa4: '/',
  0xa5: '\\infty ',
  0xa6: 'f',
  0xab: '\\leftrightarrow ',
  0xac: '\\leftarrow ',
  0xad: '\\uparrow ',
  0xae: '\\to ',
  0xaf: '\\downarrow ',
  0xb0: '^{\\circ}',
  0xb1: '\\pm ',
  0xb2: "''",
  0xb3: '\\ge ',
  0xb4: '\\times ',
  0xb5: '\\propto ',
  0xb6: '\\partial ',
  0xb7: '\\bullet ',
  0xb8: '\\div ',
  0xb9: '\\ne ',
  0xba: '\\equiv ',
  0xbb: '\\approx ',
  0xbc: '\\ldots ',
  0xc0: '\\aleph ',
  0xc4: '\\otimes ',
  0xc5: '\\oplus ',
  0xc6: '\\emptyset ',
  0xc7: '\\cap ',
  0xc8: '\\cup ',
  0xc9: '\\supset ',
  0xca: '\\supseteq ',
  0xcb: '\\not\\subset ',
  0xcc: '\\subset ',
  0xcd: '\\subseteq ',
  0xce: '\\in ',
  0xcf: '\\notin ',
  0xd0: '\\angle ',
  0xd1: '\\nabla ',
  0xd5: '\\prod ',
  0xd6: '\\surd ',
  0xd7: '\\cdot ',
  0xd8: '\\neg ',
  0xd9: '\\wedge ',
  0xda: '\\vee ',
  0xdb: '\\Leftrightarrow ',
  0xdc: '\\Leftarrow ',
  0xdd: '\\Uparrow ',
  0xde: '\\Rightarrow ',
  0xdf: '\\Downarrow ',
  0xe0: '\\lozenge ',
  0xe1: '\\langle ',
  0xe5: '\\sum ',
  0xf1: '\\rangle ',
  0xf2: '\\int ',
  0xf3: '\\int ',
  0xe6: '(',
  0xe7: '|',
  0xe8: '(',
  0xe9: '[',
  0xea: '|',
  0xeb: '[',
  0xec: '\\{ ',
  0xed: '\\{ ',
  0xee: '\\{ ',
  0xef: '|',
  0xf6: ')',
  0xf7: ')',
  0xf8: ')',
  0xf9: ']',
  0xfa: '|',
  0xfb: ']',
  0xfc: '\\} ',
  0xfd: '\\} ',
  0xfe: '\\} ',
};

const TF_LCGREEK = 4;
const TF_UCGREEK = 5;
const TF_SYMBOL = 6;

function charLatex(node: CharNode, state: RenderState): string {
  let out: string;
  const fontLocal =
    node.code < 0x100 &&
    (node.typeface === TF_LCGREEK + 128 ||
      node.typeface === TF_UCGREEK + 128 ||
      node.typeface === TF_SYMBOL + 128);
  // Unmapped font-local Symbol glyph. Codes >= 0xA0 and the known-divergent
  // low positions must NOT pass through as Latin-1 (0xF4 is the integral
  // extender, not ÷; 0x60 is radicalex, not a backtick; 0x80-0x9F are C1
  // controls) — refuse the conversion so the picture fallback takes over.
  // Printable ASCII positions where Symbol matches ASCII (= + ( ) etc.) are
  // safe to pass through.
  const FONT_LOCAL_PASSTHROUGH = node.code >= 0x20 && node.code < 0x7f;
  if (fontLocal && SYMBOL_FONT_LATEX[node.code] === undefined && !FONT_LOCAL_PASSTHROUGH) {
    throw new MtefParseError(`unmapped Symbol font glyph 0x${node.code.toString(16)}`);
  }
  if (fontLocal && node.code === 0x60) {
    // radicalex — the radical extension bar, not renderable standalone.
    throw new MtefParseError('unmapped Symbol font glyph 0x60 (radicalex)');
  }
  const symbol = fontLocal
    ? (SYMBOL_FONT_LATEX[node.code] ?? escapeLatexChar(node.code))
    : SYMBOL_LATEX[node.code];
  if (symbol) {
    out = symbol;
  } else if (node.code >= 32 && node.code < 127) {
    out = escapeLatexChar(node.code);
  } else if (node.code > 127) {
    out = String.fromCharCode(node.code);
  } else {
    out = ' ';
  }
  for (const embell of node.embellishments) {
    const mark = EMBELL_LATEX[embell];
    if (mark === undefined) {
      state.degraded = true;
      continue;
    }
    out = applyEmbellishment(out, mark);
  }
  return out;
}

function escapeLatexChar(code: number): string {
  switch (code) {
    case 0x23:
      return '\\#';
    case 0x24:
      return '\\$';
    case 0x25:
      return '\\%';
    case 0x26:
      return '\\&';
    case 0x5c:
      return '\\backslash ';
    case 0x5e:
      return '\\hat{}';
    case 0x5f:
      return '\\_';
    case 0x7b:
      return '\\{';
    case 0x7d:
      return '\\}';
    case 0x7e:
      return '\\sim ';
    default:
      return String.fromCharCode(code);
  }
}

function applyEmbellishment(base: string, mark: string): string {
  if (mark === "'" || mark === "''" || mark === '`' || mark === "'''") {
    return `${base}${mark}`;
  }
  return `${mark}{${base}}`;
}

interface Rendered {
  latex: string;
  plainText: string;
}

function renderList(nodes: Node[], state: RenderState): Rendered {
  const latex: string[] = [];
  const text: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.kind === 'char' || node.kind === 'tmpl') {
      // Render each atom exactly once — a second recursive render here made
      // deep nesting exponential (depth 26 ≈ 50s).
      let rendered: string;
      let renderedText: string;
      if (node.kind === 'char') {
        rendered = charLatex(node, state);
        renderedText = plainChar(node);
      } else {
        const out = renderTmpl(node, state);
        rendered = out.latex;
        renderedText = out.plainText;
      }
      // A following tmSCRIPT attaches to this atom (e.g. (a/2)²: the script
      // template trails the paren template as a sibling in the same list).
      const next = nodes[i + 1];
      // Only tmSCRIPT attaches backwards; tmLSCRIPT is a LEADING script whose
      // base is the atom AFTER it — routing it through renderScript would
      // steal the previous atom as its base.
      if (next?.kind === 'tmpl' && next.selector === TM_SCRIPT) {
        const combo = renderScript(next, rendered, renderedText, state);
        latex.push(combo.latex);
        text.push(combo.plainText);
        i++;
        continue;
      }
      latex.push(rendered);
      text.push(renderedText);
    } else if (node.kind === 'line') {
      const rendered = renderList(node.content, state);
      latex.push(rendered.latex);
      text.push(rendered.plainText);
    } else {
      state.degraded = true;
    }
  }
  return { latex: latex.join(''), plainText: text.join('') };
}

function plainChar(node: CharNode): string {
  if (node.code === 0x22c5) return '·';
  if (node.code === 0x2264) return '≤';
  if (node.code === 0x2265) return '≥';
  return node.code >= 32 ? String.fromCharCode(node.code) : '';
}

function lineContents(children: Node[], state: RenderState): Rendered[] {
  return children
    .filter((child): child is LineNode => child.kind === 'line')
    .map((line) => renderList(line.content, state));
}

function renderTmpl(node: TmplNode, state: RenderState): Rendered {
  const { selector, variation, children } = node;

  if (selector === TM_DIRAC) {
    // DiracBox: [left slot, right slot, ⟨ | ⟩ chars]. Variations per the
    // rtf2latex2e reference: 0 = ⟨L|R⟩, 1 = bra ⟨L|, 2 = ket |R⟩.
    const parts = lineContents(children, state);
    const left = parts[0]?.latex ?? '';
    const right = variation === 2 ? '' : (parts[1]?.latex ?? '');
    if (variation === 0 && !right) state.degraded = true;
    const body =
      variation === 1
        ? `\\left\\langle ${left}\\right| `
        : variation === 2
          ? `\\left| ${right || left}\\right\\rangle `
          : `\\left\\langle ${left}\\mid ${right}\\right\\rangle `;
    return {
      latex: body,
      plainText: `<${parts.map((p) => p.plainText).join('|')}>`,
    };
  }

  const fence = FENCE_PAIRS[selector];
  if (fence) {
    // The fence CHARs at the end of the template's own list are structural;
    // the \left/\right pair already renders them, so only the slot matters.
    // Variations: 0 = both sides, 1 = left only, 2 = right only — the missing
    // side becomes a null delimiter (\left. / \right.) so the output is
    // always a matched KaTeX pair (piecewise-function braces are var 1).
    const [inner] = lineContents(children, state);
    const open = variation === 2 ? '\\left. ' : fence[0];
    const close = variation === 1 ? '\\right. ' : fence[1];
    return {
      latex: `${open}${inner?.latex ?? ''}${close}`,
      plainText: `(${inner?.plainText ?? ''})`,
    };
  }

  if (selector === TM_FRACT || selector === TM_SLFRACT) {
    const parts = lineContents(children, state);
    const num = parts[0]?.latex ?? '';
    const den = parts[1]?.latex ?? '';
    const plain = `${parts[0]?.plainText ?? ''}/${parts[1]?.plainText ?? ''}`;
    if (!num || !den) {
      state.degraded = true;
      return { latex: `${num}${den}`, plainText: plain };
    }
    if (selector === TM_SLFRACT) {
      return { latex: `${num}/${den}`, plainText: plain };
    }
    return { latex: `\\frac{${num}}{${den}}`, plainText: plain };
  }

  if (selector === TM_ROOT) {
    // Equation 3.0 emits [radicand, degree?] — square roots carry a null
    // second slot; take the first non-empty line as the radicand and the
    // remaining non-empty line (if any) as the degree.
    const parts = lineContents(children, state).filter((part) => part.latex);
    if (variation === 1 && parts.length >= 2) {
      const [radicand, degree] = parts;
      return {
        latex: `\\sqrt[${degree!.latex}]{${radicand!.latex}}`,
        plainText: `${radicand!.plainText}^${degree!.plainText}`,
      };
    }
    const radicand = parts[0];
    return {
      latex: `\\sqrt{${radicand?.latex ?? ''}}`,
      plainText: `√(${radicand?.plainText ?? ''})`,
    };
  }

  if (selector === TM_SCRIPT) {
    return renderScript(node, '', '', state);
  }

  if (selector === TM_LSCRIPT) {
    // Leading script: slots are [sub, sup] (ScrBoxClass order); variation
    // picks which exist (tvLSUPER=0, tvLSUB=1, tvLSUBSUP=2). The BASE is the
    // next sibling in the parent list — this template emits the scripts only;
    // re-emitting a slot as a base group would duplicate it.
    const parts = lineContents(children, state);
    const sub = variation === 0 ? '' : (parts[0]?.latex ?? '');
    // tvLSUPER writers may emit the sup slot alone; fall back like the
    // big-operator branch does.
    const sup =
      variation === 1 ? '' : (parts[1]?.latex ?? (variation === 0 ? (parts[0]?.latex ?? '') : ''));
    return {
      latex: `{}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`,
      plainText: parts.map((p) => p.plainText).join(''),
    };
  }

  if (selector === TM_UBAR || selector === TM_OBAR) {
    const [inner] = lineContents(children, state);
    // Spec: 16 = tmUBAR (underbar), 17 = tmOBAR (overbar).
    const cmd = selector === TM_UBAR ? '\\underline' : '\\overline';
    return { latex: `${cmd}{${inner?.latex ?? ''}}`, plainText: inner?.plainText ?? '' };
  }

  if (selector === TM_LARROW || selector === TM_RARROW || selector === TM_BARROW) {
    const [inner] = lineContents(children, state);
    const cmd =
      selector === TM_RARROW
        ? '\\overrightarrow'
        : selector === TM_LARROW
          ? '\\overleftarrow'
          : '\\overleftrightarrow';
    return { latex: `${cmd}{${inner?.latex ?? ''}}`, plainText: inner?.plainText ?? '' };
  }

  if (selector === TM_OARC) {
    // KaTeX has no arc accent command; approximate with a frown overset and
    // flag degraded so callers know the rendering is approximate.
    const [inner] = lineContents(children, state);
    state.degraded = true;
    return {
      latex: `\\overset{\\frown }{${inner?.latex ?? ''}}`,
      plainText: inner?.plainText ?? '',
    };
  }
  if (selector === TM_UARROW || selector === TM_OARROW) {
    // U/O prefix = under/over, same convention as tmUBAR/tmOBAR.
    const [inner] = lineContents(children, state);
    const cmd = selector === TM_UARROW ? '\\underrightarrow' : '\\overrightarrow';
    return { latex: `${cmd}{${inner?.latex ?? ''}}`, plainText: inner?.plainText ?? '' };
  }

  if (selector === TM_LIM) {
    // Slots [main, lower, upper]. Variations (spec + rtf2latex2e eqn.c):
    // 0 = tvULIM upper limit, 1 = tvLLIM lower limit, 2 = tvBLIM both.
    // The reference emits `main` FIRST, then the limits, and injects NO
    // function name — Equation Editor users type the function ("lim", "max",
    // "min"…) into the main slot, so hardcoding \lim both duplicates it and
    // glues to a letter-leading main slot (\limx → KaTeX undefined control
    // sequence). Single-limit writers emit two slots — the lone limit sits at
    // position 1 regardless of role — falling back like the big-op branch.
    const parts = lineContents(children, state);
    const sub = variation === 1 || variation === 2 ? (parts[1]?.latex ?? '') : '';
    const sup =
      variation === 0
        ? (parts[2]?.latex ?? parts[1]?.latex ?? '')
        : variation === 2
          ? (parts[2]?.latex ?? '')
          : '';
    const main = parts[0]?.latex ?? '';
    // KaTeX needs a base before the scripts: an empty main slot (writer put
    // the function in the limit slots only) gets \lim as a neutral default.
    const base = main || '\\lim ';
    return {
      latex: `${base}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`,
      plainText: parts.map((p) => p.plainText).join(''),
    };
  }

  const isContour =
    (selector === 21 && (variation === 3 || variation === 4)) ||
    (selector === 24 && variation === 2);
  const bigOp = isContour ? '\\oint ' : BIG_OPS[selector];
  if (bigOp) {
    // v3 BigOpBox sub-object order: [main slot (summand), upper, lower, op
    // CHAR]. The operand renders AFTER the operator and its limits.
    const parts = lineContents(children, state);
    const main = parts[0]?.latex ?? '';
    const { lower, upper } = bigOpLimits(selector, variation);
    // Real streams (reference rtf2latex2e + MathType decks) order the slots
    // [main, LOWER, upper] — the archived spec prose says upper-first, but
    // the 20-year reference implementation reads sub then sup. When only the
    // upper limit exists some writers omit the lower slot entirely, leaving
    // the upper value at position 1 — fall back to it.
    const sub = lower ? (parts[1]?.latex ?? '') : '';
    let sup = '';
    if (upper) {
      sup = parts[2]?.latex ?? (lower ? '' : (parts[1]?.latex ?? ''));
    }
    const limits = `${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`;
    const plainMain = parts[0]?.plainText ?? '';
    if (parts.length > 3) {
      // More slots than the family allows: keep everything, flag degrade.
      state.degraded = true;
    }
    return {
      latex: `${bigOp}${limits}${main}`,
      plainText: `${bigOp.trim()}${sub}${sup}${plainMain}`,
    };
  }

  // Unknown template (incl. PILE/-1, MATRIX/-2): concatenate slot contents so
  // the characters survive; mark degraded so callers can warn.
  state.degraded = true;
  const all = lineContents(children, state);
  return {
    latex: all.map((part) => part.latex).join(''),
    plainText: all.map((part) => part.plainText).join(''),
  };
}

function renderScript(
  node: TmplNode,
  baseLatex: string,
  baseText: string,
  state: RenderState,
): Rendered {
  const parts = lineContents(node.children, state);
  let sub = '';
  let sup = '';
  switch (node.variation) {
    case 0: // tvSUPER — slots are [sub, sup] with the unused one null/omitted
      if (parts.length >= 2) sup = parts[1]?.latex ?? '';
      else sup = parts[0]?.latex ?? '';
      break;
    case 1: // tvSUB — writer emits [real, null]
      sub = parts.find((part) => part.latex)?.latex ?? '';
      break;
    case 2: // tvSUBSUP
      sub = parts[0]?.latex ?? '';
      sup = parts[1]?.latex ?? '';
      break;
    default:
      state.degraded = true;
      break;
  }
  const scripts = `${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`;
  return {
    latex: `${baseLatex}${scripts}`,
    plainText: `${baseText}${sub}${sup}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an `Equation Native` stream (EQNOLEFILEHDR + MTEF v3) to LaTeX.
 * Throws {@link MtefParseError} for non-v3 streams or malformed bytes —
 * callers should fall back to the picture path on throw.
 */
export function equationNativeToLatex(stream: Uint8Array): MtefConversion {
  if (stream.byteLength < 34) throw new MtefParseError('Equation Native stream too short');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const hdrLen = view.getUint16(0, true);
  const mtefStart = hdrLen > 0 && hdrLen < stream.byteLength ? hdrLen : 28;
  if (stream[mtefStart] !== 3) {
    throw new MtefParseError(`unsupported MTEF version ${stream[mtefStart] ?? '?'}`);
  }
  if (stream[mtefStart + 1] !== 1) {
    // Mac-generated streams store 8-bit characters; only the Windows encoding
    // is handled here.
    throw new MtefParseError('unsupported MTEF platform (Windows only)');
  }

  const cur = new Cursor(stream, mtefStart + 5, stream.byteLength);
  const budget = { count: 0 };
  const root = parseObjectList(cur, budget);
  const state = { degraded: false };
  const rendered = renderList(root, state);
  const latex = rendered.latex.replace(/\s+/g, ' ').trim();
  if (!latex) throw new MtefParseError('MTEF stream produced empty equation');
  if (latex.length > MAX_LATEX_LENGTH) {
    throw new MtefParseError('MTEF stream produced oversized LaTeX output');
  }
  return { latex, plainText: rendered.plainText.trim(), degraded: state.degraded };
}
