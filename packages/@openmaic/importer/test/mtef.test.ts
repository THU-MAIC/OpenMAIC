import { describe, expect, it } from 'vitest';
import katex from 'katex';

import { equationNativeToLatex, MtefParseError } from '../src/utils/mtef';

/**
 * Synthetic MTEF v3 streams, built record by record from the spec (tag =
 * type | options<<4). The streams below replicate equations found in real
 * Equation 3.0 courseware decks, byte-for-byte in structure.
 */
function mtefStream(records: number[]): Uint8Array {
  const header = [0x03, 0x01, 0x01, 0x03, 0x0a]; // MTEF v3, Windows, Equation Editor 3.10
  const hdr = new Uint8Array(28); // EQNOLEFILEHDR, cbHdr = 0x1c
  new DataView(hdr.buffer).setUint16(0, 0x1c, true);
  const body = Uint8Array.from([...header, ...records]);
  return new Uint8Array([...hdr, ...body]);
}

/** CHAR(fnVARIABLE, code, embellished?) — typeface 3 = fnVARIABLE. */
function varChar(code: number, options = 0x10): number[] {
  return [0x02 | options, 0x83, code & 0xff, code >> 8];
}

/** CHAR(fnSYMBOL, code) — typeface 6 carries operators like = · ≤ +. */
function symChar(code: number): number[] {
  return [0x02, 0x86, code & 0xff, code >> 8];
}

/** CHAR(fnNUMBER, code) — typeface 8. */
function numChar(code: number): number[] {
  return [0x02, 0x88, code & 0xff, code >> 8];
}

const FULL = [0x0a];
const SUB = [0x0b];
const LINE = [0x01];
const LINE_NULL = [0x11];
const END = [0x00];

describe('mtef · equationNativeToLatex', () => {
  it('converts A = a·b (CHAR stream with dot operator)', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      ...varChar(0x41), // A
      ...symChar(0x3d), // =
      ...varChar(0x61), // a
      ...symChar(0x22c5), // ⋅
      ...varChar(0x62), // b
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('A=a\\cdot b');
    expect(conv.plainText).toBe('A=a·b');
    expect(conv.degraded).toBe(false);
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });

  it('converts R′ = √((a/2)²+(b/2)²) ≤ R (prime, fences, fraction, root, scripts)', () => {
    // Structure from a real Equation 3.0 deck: the root template's slot is
    // [paren{frac a 2} script², +, paren{frac b 2} script²], followed by a
    // null degree slot; ≤ R sits OUTSIDE the root, in the top-level line.
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      ...[0x32, 0x83, 0x52, 0x00], // CHAR R (embellished)
      ...[0x06, 0x05], // EMBELL prime
      ...END, // ends embellishment list
      ...symChar(0x3d), // =
      // TMPL tmROOT(tvSQROOT)
      0x03,
      0x0d,
      0x00,
      0x00,
      ...LINE, // radicand slot
      // TMPL tmPAREN
      0x03,
      0x01,
      0x00,
      0x00,
      ...LINE, // paren slot
      // TMPL tmFRACT(tvFFRACT)
      0x03,
      0x0e,
      0x00,
      0x00,
      ...LINE,
      ...varChar(0x61),
      ...END, // numerator: a
      ...LINE,
      ...numChar(0x32),
      ...END, // denominator: 2
      ...END, // ends fraction slots
      ...END, // ends paren slot
      ...[0x02, 0x96, 0x28, 0x00], // fence char (
      ...[0x02, 0x96, 0x29, 0x00], // fence char )
      ...END, // ends paren template
      // TMPL tmSCRIPT(tvSUPER)
      0x03,
      0x0f,
      0x00,
      0x00,
      ...SUB,
      ...LINE_NULL, // unused sub slot
      ...LINE,
      ...numChar(0x32),
      ...END, // superscript: 2
      ...END, // ends script slots
      ...symChar(0x2b), // +
      // second (b/2)² — same shape
      0x03,
      0x01,
      0x00,
      0x00,
      ...LINE,
      0x03,
      0x0e,
      0x00,
      0x00,
      ...LINE,
      ...varChar(0x62),
      ...END,
      ...LINE,
      ...numChar(0x32),
      ...END,
      ...END,
      ...END,
      ...[0x02, 0x96, 0x28, 0x00],
      ...[0x02, 0x96, 0x29, 0x00],
      ...END,
      0x03,
      0x0f,
      0x00,
      0x00,
      ...SUB,
      ...LINE_NULL,
      ...LINE,
      ...numChar(0x32),
      ...END,
      ...END,
      ...END, // ends radicand slot
      ...LINE_NULL, // null degree slot
      ...END, // ends root template
      ...symChar(0x2264), // ≤
      ...varChar(0x52), // R
      ...END, // ends top line
      ...END, // ends equation
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe(
      "R'=\\sqrt{\\left ( \\frac{a}{2}\\right ) ^{2}+\\left ( \\frac{b}{2}\\right ) ^{2}}\\le R",
    );
    expect(conv.degraded).toBe(false);
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });

  it('attaches a tvSUB script to the preceding char (Dᵢ)', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      ...varChar(0x44), // D
      0x03,
      0x0f,
      0x01,
      0x00, // TMPL tmSCRIPT(tvSUB)
      ...SUB,
      ...LINE,
      ...varChar(0x69),
      ...END, // subscript: i
      ...LINE_NULL,
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('D_{i}');
  });

  it('degrades unknown templates to slot contents and flags degraded', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      0x63,
      0x00,
      0x00, // selector 0x63 — beyond the v3 table
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('x');
    expect(conv.degraded).toBe(true);
  });

  it('rejects non-v3 MTEF streams', () => {
    const hdr = new Uint8Array(28);
    new DataView(hdr.buffer).setUint16(0, 0x1c, true);
    const stream = new Uint8Array([...hdr, 0x05, 0x01, 0x00, 0x05, 0x00, 0x00, 0x00]);
    expect(() => equationNativeToLatex(stream)).toThrow(MtefParseError);
  });

  it('throws on truncated streams instead of looping', () => {
    const hdr = new Uint8Array(28);
    const stream = new Uint8Array([...hdr, 0x03, 0x01, 0x01, 0x03, 0x0a, 0x01, 0x12, 0x83]);
    expect(() => equationNativeToLatex(stream)).toThrow(MtefParseError);
  });
});

describe('mtef · spec-conformance (cross-review round 2)', () => {
  it('BigOp tmSUM(tvBSUM) renders [main, lower, upper] in the right roles', () => {
    // Slots: [main=k, lower=i=1, upper=n] per real streams + eqn.c.
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      29,
      1,
      0, // TMPL tmSUM tvBSUM (both limits)
      ...LINE,
      ...varChar(0x6b),
      ...END, // main: k
      ...LINE,
      ...varChar(0x69),
      ...symChar(0x3d),
      ...varChar(0x31),
      ...END, // lower: i=1 (real streams order [main, lower, upper])
      ...LINE,
      ...varChar(0x6e),
      ...END, // upper: n
      ...END, // ends template
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('\\sum _{i=1}^{n}k');
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });

  it('BigOp tmSUM(tvLSUM) is lower-only; main is not eaten by limits', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      29,
      0,
      0,
      ...LINE,
      ...varChar(0x6b),
      ...END, // main
      ...LINE,
      ...varChar(0x6a),
      ...END, // lower: j (upper slot omitted)
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('\\sum _{j}k');
  });

  it('BigOp tmINTOP(tvUINTOP) renders the upper limit slot', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      42,
      0,
      0,
      ...LINE,
      ...varChar(0x64),
      ...varChar(0x78),
      ...END, // main: dx (fnVARIABLE — fnSYMBOL d/x would decode as δ/ξ)
      ...LINE,
      ...varChar(0x6e),
      ...END, // upper: n
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('\\int ^{n}dx');
  });

  it('SIZE records in all three v3 forms parse without derailing the stream', () => {
    const explicit = mtefStream([
      0x09,
      101,
      0x10,
      0x00,
      ...FULL,
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(explicit).latex).toBe('x');
    const delta = mtefStream([0x09, 1, 0x90, ...FULL, ...LINE, ...varChar(0x78), ...END, ...END]);
    expect(equationNativeToLatex(delta).latex).toBe('x');
    const large = mtefStream([
      0x09,
      100,
      1,
      0x20,
      0x00,
      ...FULL,
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(large).latex).toBe('x');
  });

  it('LINE xfRULER consumes a complete RULER record (tag + typed stops)', () => {
    const stream = mtefStream([
      ...FULL,
      0x21, // LINE with xfRULER
      0x07,
      0x01,
      0x00,
      0x00,
      0x01, // RULER: 1 stop, type left, offset 0x0100
      ...varChar(0x78),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(stream).latex).toBe('x');
  });

  it('PILE reads nudge→halign→valign→RULER order and keeps its lines', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x24,
      0x00,
      0x01, // PILE with xfRULER: halign 0, valign 1
      0x07,
      0x00, // RULER: no stops
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...LINE,
      ...varChar(0x62),
      ...END,
      ...END, // ends pile
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('ab');
    expect(conv.degraded).toBe(true); // PILE is flattened — flagged
  });

  it('MATRIX (v3 single-byte fields) keeps every cell', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x05,
      0x00,
      0x01,
      0x00,
      0x01,
      0x02,
      0x00,
      0x00, // valign,h_just,v_just,rows=1,cols=2,parts bytes
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...LINE,
      ...varChar(0x62),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('ab');
    expect(conv.degraded).toBe(true);
  });

  it('tmUBAR(16) renders underbar, tmOBAR(17) renders overbar', () => {
    const under = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      16,
      0,
      0,
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(under).latex).toBe('\\underline{x}');
    const over = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      17,
      0,
      0,
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(over).latex).toBe('\\overline{x}');
  });

  it('fence variations render matched pairs via null delimiters (KaTeX-valid)', () => {
    const leftOnly = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      1,
      1,
      0,
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const left = equationNativeToLatex(leftOnly);
    expect(left.latex).toBe('\\left ( a\\right.');
    expect(() => katex.renderToString(left.latex, { throwOnError: true })).not.toThrow();
    const rightOnly = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      1,
      2,
      0,
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const right = equationNativeToLatex(rightOnly);
    expect(right.latex).toBe('\\left. a\\right )');
    expect(() => katex.renderToString(right.latex, { throwOnError: true })).not.toThrow();
    // tmBRACE var 1 — the legacy piecewise-function brace.
    const brace = equationNativeToLatex(
      mtefStream([
        ...FULL,
        ...LINE,
        0x03,
        2,
        1,
        0,
        ...LINE,
        ...varChar(0x61),
        ...END,
        ...END,
        ...END,
        ...END,
      ]),
    );
    expect(brace.latex).toBe('\\left \\{ a\\right.');
    expect(() => katex.renderToString(brace.latex, { throwOnError: true })).not.toThrow();
  });

  it('tmDIRAC: var1 = bra ⟨L|, var2 = ket |R⟩ (reference semantics)', () => {
    const bra = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      45,
      1,
      0,
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(bra).latex).toBe('\\left\\langle a\\right|');
    const ket = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      45,
      2,
      0,
      ...LINE,
      ...varChar(0x61),
      ...END,
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(ket).latex).toBe('\\left| a\\right\\rangle');
    const both = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      45,
      0,
      0,
      ...LINE,
      ...varChar(0x78),
      ...END,
      ...LINE,
      ...varChar(0x79),
      ...END,
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const outB = equationNativeToLatex(both);
    expect(outB.latex).toBe('\\left\\langle x\\mid y\\right\\rangle');
    expect(() => katex.renderToString(outB.latex, { throwOnError: true })).not.toThrow();
  });

  it('tmLSCRIPT emits only the leading scripts; the base is the next sibling', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      44,
      1,
      0,
      ...LINE,
      ...varChar(0x31),
      ...END,
      ...END,
      ...varChar(0x53),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(stream).latex).toBe('{}_{1}S');
    // tvLSUPER with a single emitted slot (no null-sub line): the lone slot
    // IS the superscript — it must not vanish.
    const supOnly = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      44,
      0,
      0,
      ...LINE,
      ...numChar(0x31),
      ...numChar(0x32),
      ...END,
      ...END,
      ...varChar(0x43),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(supOnly).latex).toBe('{}^{12}C');
    // A leading script must NOT steal the previous atom as its base.
    const trail = mtefStream([
      ...FULL,
      ...LINE,
      ...varChar(0x3d),
      0x03,
      44,
      2,
      0,
      ...LINE,
      ...numChar(0x36),
      ...END,
      ...LINE,
      ...numChar(0x31),
      ...numChar(0x32),
      ...END,
      ...END,
      ...varChar(0x43),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(trail).latex).toBe('={}_{6}^{12}C');
  });

  it('deeply nested templates render in linear time and bounded size (perf guard)', () => {
    // Nest the leading-script template inside its own sup slot — the shape
    // that doubled per level before the base-duplication fix.
    function nestedScripts(depth: number): number[] {
      let rec: number[] = [...varChar(0x78)];
      for (let i = 0; i < depth; i++) {
        rec = [0x03, 44, 0, 0, ...LINE_NULL, ...LINE, ...rec, ...END, ...END];
      }
      return [...FULL, ...LINE, ...rec, ...END, ...END];
    }
    const conv = equationNativeToLatex(mtefStream(nestedScripts(90))); // 2 depth levels each, under the 200 cap
    expect(conv.latex.length).toBeLessThan(2_000);
    function nestedFences(depth: number): number[] {
      let rec: number[] = [...varChar(0x78)];
      for (let i = 0; i < depth; i++) {
        rec = [0x03, 1, 0, 0, 0x01, ...rec, 0x00, 0x00];
      }
      return [...FULL, ...LINE, ...rec, ...END, ...END];
    }
    const t0 = Date.now();
    expect(equationNativeToLatex(mtefStream(nestedFences(80))).latex).toContain('x');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('truncated nested list throws instead of silently losing content', () => {
    // A fraction whose denominator LINE is never terminated.
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      14,
      0,
      0, // tmFRACT
      ...LINE,
      ...varChar(0x61),
      ...END, // numerator closed
      ...LINE,
      ...varChar(0x62), // denominator unterminated → EOF
    ]);
    expect(() => equationNativeToLatex(stream)).toThrow(MtefParseError);
  });

  it('tmOARC output stays KaTeX-renderable and flags degraded', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      48,
      0,
      0,
      ...LINE,
      ...varChar(0x41),
      ...varChar(0x42),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    const conv = equationNativeToLatex(stream);
    expect(conv.degraded).toBe(true);
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });
});

describe('mtef · round-3 fixes', () => {
  it('tmISUM(tvBISUM) renders both limits (variation 1 = both, not upper-only)', () => {
    const stream = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      30,
      1,
      0, // tmISUM tvBISUM
      ...LINE,
      ...varChar(0x6b),
      ...END, // main
      ...LINE,
      ...varChar(0x6a),
      ...END, // lower
      ...LINE,
      ...varChar(0x6e),
      ...END, // upper
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(stream).latex).toBe('\\sum _{j}^{n}k');
  });

  it('contour integral variations render \\oint (tmSINT var 3/4, tmSSINT var 2)', () => {
    const mk = (sel: number, variation: number) =>
      mtefStream([
        ...FULL,
        ...LINE,
        0x03,
        sel,
        variation,
        0,
        ...LINE,
        ...varChar(0x64),
        ...varChar(0x78),
        ...END, // main dx
        ...LINE,
        ...varChar(0x30),
        ...END, // lower 0
        ...END,
        ...END,
        ...END,
      ]);
    expect(equationNativeToLatex(mk(21, 3)).latex).toBe('\\oint dx');
    expect(equationNativeToLatex(mk(21, 4)).latex).toBe('\\oint _{0}dx');
    expect(equationNativeToLatex(mk(24, 2)).latex).toBe('\\oint _{0}dx');
  });

  it('decodes font-local Symbol encoding: fnLCGREEK q → \\theta, fnSYMBOL = stays =', () => {
    const theta = mtefStream([
      ...FULL,
      ...LINE,
      0x02,
      0x84,
      0x71,
      0x00, // CHAR fnLCGREEK code 0x71 (Symbol 'q' = θ)
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(theta).latex).toBe('\\theta');
    const stillEq = mtefStream([
      ...FULL,
      ...LINE,
      ...symChar(0x3d),
      ...varChar(0x61),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(stillEq).latex).toBe('=a');
  });

  it('rejects Mac-platform MTEF streams (8-bit chars unsupported)', () => {
    const hdr = new Uint8Array(28);
    new DataView(hdr.buffer).setUint16(0, 0x1c, true);
    const stream = new Uint8Array([...hdr, 0x03, 0x00, 0x01, 0x03, 0x0a, 0x0a, 0x01, 0x00, 0x00]);
    expect(() => equationNativeToLatex(stream)).toThrow(MtefParseError);
  });

  it('tagless RULER after xfRULER is tolerated', () => {
    const stream = mtefStream([
      ...FULL,
      0x21, // LINE with xfRULER
      // no RULER tag follows — next record goes straight into the object list
      ...varChar(0x78),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(stream).latex).toBe('x');
  });
});

describe('mtef · real Equation 3.0 fixtures (round-tripped from a legacy deck)', () => {
  // Raw `Equation Native` streams from a real 消防 courseware deck
  // (Equation.3 OLE objects), base64-encoded. These pin the font-local
  // Symbol encoding (fnSYMBOL = / + / ⋅ / ≤ as real writers emit them)
  // against bytes a real writer produced. None of the three contains a
  // big-operator selector (21–43); that reading is pinned by the
  // spec-conformance tests above instead.
  const OLE_A_EQ_A_DOT_B =
    'HAAAAAIA5sEdAAAAAAAAAFAlGACMMBgAAAAAAAMBAQMKCgESg0EAAoY9ABKDYQAChsUiEoNiAAAA';
  const OLE_R_PRIME_LE_R =
    'HAAAAAIA5sGFAAAAAAAAAJDDFwC87hcAAAAAAAMBAQMKCgEyg1IABgUAAAKGPQADDQAAAQMBAAABAw4AAAESg2EAAAECiDIAAAAAApYoAAKWKQAAAw8AAAsRAQKIMgAAAAoChisAAwEAAAEDDgAAARKDYgAAAQKIMgAAAAACligAApYpAAADDwAACxEBAogyAAAAABEACgKGZCISg1IAAAA=';
  const OLE_2R_PRIME_LE_D_I =
    'HAAAAAIAycGmAAAAAAAAAPgxFgD0zRUAAAAAAAMBAQMKCgECiDIAMoNSAAYFAAAChj0AAogyAAMNAAABAwEAAAEDDgAAARKDYQAAAQKIMgAAAAACligAApYpAAADDwAACxEBAogyAAAACgKGKwADAQAAAQMOAAABEoNiAAABAogyAAAAAAKWKAAClikAAAMPAAALEQECiDIAAAAAEQAKAoZkIgKIMgASg1IAAoY9ABKDRAADDwEACwESg2kAABEAAAA=';

  function decode(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  it('fixture 1: A = a·b (fnSYMBOL = / ⋅ via MTCode)', () => {
    const conv = equationNativeToLatex(decode(OLE_A_EQ_A_DOT_B));
    expect(conv.latex).toBe('A=a\\cdot b');
    expect(conv.degraded).toBe(false);
  });

  it("fixture 2: R' = √((a/2)²+(b/2)²) ≤ R", () => {
    const conv = equationNativeToLatex(decode(OLE_R_PRIME_LE_R));
    expect(conv.latex).toBe(
      "R'=\\sqrt{\\left ( \\frac{a}{2}\\right ) ^{2}+\\left ( \\frac{b}{2}\\right ) ^{2}}\\le R",
    );
    expect(conv.degraded).toBe(false);
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });

  it("fixture 3: 2R' = 2√((a/2)²+(b/2)²) ≤ 2R = Dᵢ", () => {
    const conv = equationNativeToLatex(decode(OLE_2R_PRIME_LE_D_I));
    expect(conv.latex).toBe(
      "2R'=2\\sqrt{\\left ( \\frac{a}{2}\\right ) ^{2}+\\left ( \\frac{b}{2}\\right ) ^{2}}\\le 2R=D_{i}",
    );
    expect(conv.degraded).toBe(false);
  });
});

describe('mtef · review round fixes', () => {
  it('tmLIM: main slot first, no injected operator name; empty main gets \lim', () => {
    // Reference emits `main` followed by limits and injects NO function
    // name — the function lives in the main slot (probes from review).
    const limLower = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      39,
      1,
      0,
      ...LINE,
      ...varChar(0x6c),
      ...varChar(0x69),
      ...varChar(0x6d),
      ...END, // main: "lim"
      ...LINE,
      ...varChar(0x6e),
      ...END, // lower: n
      ...END,
      ...END,
      ...END,
    ]);
    const outL = equationNativeToLatex(limLower);
    expect(outL.latex).toBe('lim_{n}');
    expect(() => katex.renderToString(outL.latex, { throwOnError: true })).not.toThrow();
    const maxLower = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      39,
      1,
      0,
      ...LINE,
      ...varChar(0x6d),
      ...varChar(0x61),
      ...varChar(0x78),
      ...END, // main: "max"
      ...LINE,
      ...varChar(0x69),
      ...END, // lower: i
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(maxLower).latex).toBe('max_{i}');
    // Empty main slot + letter-leading content must not glue to \lim.
    const emptyMain = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      39,
      1,
      0,
      ...LINE,
      ...END, // main: empty
      ...LINE,
      ...varChar(0x78),
      ...END, // lower: x
      ...END,
      ...END,
      ...END,
    ]);
    const outE = equationNativeToLatex(emptyMain);
    expect(outE.latex).toBe('\\lim _{x}');
    expect(() => katex.renderToString(outE.latex, { throwOnError: true })).not.toThrow();
    // Both limits.
    const both = mtefStream([
      ...FULL,
      ...LINE,
      0x03,
      39,
      2,
      0,
      ...LINE,
      ...varChar(0x6c),
      ...varChar(0x69),
      ...varChar(0x6d),
      ...END,
      ...LINE,
      ...varChar(0x6e),
      ...END,
      ...LINE,
      ...varChar(0x32),
      ...END,
      ...END,
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(both).latex).toBe('lim_{n}^{2}');
  });

  it('Adobe Symbol operator block maps correctly (≤ × → ∞ ≠)', () => {
    const conv = mtefStream([
      ...FULL,
      ...LINE,
      0x02,
      0x86,
      0xa3,
      0x00, // fnSYMBOL 0xA3 = ≤
      ...varChar(0x61),
      0x02,
      0x86,
      0xb4,
      0x00, // fnSYMBOL 0xB4 = ×
      ...varChar(0x62),
      ...END,
      ...END,
    ]);
    expect(equationNativeToLatex(conv).latex).toBe('\\le a\\times b');
  });

  it('nesting depth cap throws MtefParseError instead of RangeError', () => {
    function nestedFences(depth: number): number[] {
      let rec: number[] = [...varChar(0x78)];
      for (let i = 0; i < depth; i++) {
        rec = [0x03, 1, 0, 0, 0x01, ...rec, 0x00, 0x00];
      }
      return [...FULL, ...LINE, ...rec, ...END, ...END];
    }
    expect(() => equationNativeToLatex(mtefStream(nestedFences(500)))).toThrow(MtefParseError);
  });
});

describe('mtef · round-6 fixes (wyuc review 2)', () => {
  it('unmapped Symbol high-half codes throw MtefParseError (picture fallback), not Latin-1', () => {
    // 0xF7 is parenrightex (a big-paren extender). Before the full-table fix
    // it passed through as ÷ — wrong but plausible-looking math.
    const probe = (code: number) =>
      mtefStream([...FULL, ...LINE, ...symChar(code), ...END, ...END]);
    // 0xA0 = Euro (unmapped — excluded category)
    expect(() => equationNativeToLatex(probe(0xa0))).toThrow(MtefParseError);
    // 0xC1 Ifraktur (unmapped)
    expect(() => equationNativeToLatex(probe(0xc1))).toThrow(MtefParseError);
  });

  it('previously-dangerous unmapped codes now map correctly from the AFM', () => {
    const mk = (code: number) =>
      equationNativeToLatex(mtefStream([...FULL, ...LINE, ...symChar(code), ...END, ...END])).latex;
    expect(mk(0xf2)).toBe('\\int'); // was ÷
    expect(mk(0xd7)).toBe('\\cdot'); // was ×
    expect(mk(0xe5)).toBe('\\sum'); // was å
    expect(mk(0xd5)).toBe('\\prod'); // was Õ
    expect(mk(0xce)).toBe('\\in'); // was Î
    expect(mk(0xe1)).toBe('\\langle'); // was á
    expect(mk(0xf1)).toBe('\\rangle'); // was ö
    expect(mk(0xb6)).toBe('\\partial'); // was ¶
    expect(mk(0xd1)).toBe('\\nabla'); // was Ñ
    expect(mk(0xde)).toBe('\\Rightarrow'); // was Þ
    expect(mk(0xdb)).toBe('\\Leftrightarrow'); // was Û
    expect(mk(0xa2)).toBe("'"); // was ¢
    for (const code of [0xf2, 0xd7, 0xe5, 0xd5, 0xce, 0xe1, 0xf1, 0xb6, 0xd1, 0xde, 0xdb, 0xa2]) {
      const latex = mk(code);
      expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
    }
  });

  it('MAX_LATEX_LENGTH: 15,000 sibling macro CHARs throw (width case)', () => {
    const records: number[] = [...FULL, ...LINE];
    // Each CHAR is 4 bytes; macro commands like \alpha produce ~7 chars of
    // LaTeX from 4 input bytes — 15k of them exceeds the 64 KiB output cap.
    for (let i = 0; i < 15_000; i++) records.push(...[0x02, 0x84, 0x61, 0x00]);
    records.push(...END, ...END);
    expect(() => equationNativeToLatex(mtefStream(records))).toThrow(
      'MTEF stream produced oversized LaTeX output',
    );
    // A small count passes.
    const small: number[] = [...FULL, ...LINE];
    for (let i = 0; i < 100; i++) small.push(...[0x02, 0x84, 0x61, 0x00]);
    small.push(...END, ...END);
    expect(() => equationNativeToLatex(mtefStream(small))).not.toThrow();
  });

  it('MAX_RECORDS: 20,001 sibling CHARs throw', () => {
    const records: number[] = [...FULL, ...LINE];
    for (let i = 0; i < 20_001; i++) records.push(...varChar(0x61));
    records.push(...END, ...END);
    expect(() => equationNativeToLatex(mtefStream(records))).toThrow('MTEF stream too large');
  });

  it('embellishment records count against the budget (P3)', () => {
    // One CHAR with >MAX_RECORDS embellishments.
    const records: number[] = [...FULL, ...LINE, 0x22, 0x83, 0x61, 0x00]; // CHAR xfEMBELL 'a'
    for (let i = 0; i < 20_001; i++) records.push(0x06, 0x11); // EMBELL (bar)
    records.push(0x00, ...END, ...END);
    expect(() => equationNativeToLatex(mtefStream(records))).toThrow('MTEF stream too large');
  });

  it('tmDIRAC KaTeX-validity for all variations', () => {
    for (const v of [0, 1, 2]) {
      const conv = equationNativeToLatex(
        mtefStream([
          ...FULL,
          ...LINE,
          0x03,
          45,
          v,
          0,
          ...LINE,
          ...varChar(0x61),
          ...END,
          ...LINE,
          ...varChar(0x62),
          ...END,
          ...END,
          ...END,
          ...END,
          ...END,
        ]),
      );
      expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
    }
  });
});

describe('Symbol-font glyphs that once produced invalid or misleading LaTeX', () => {
  it('renders 0xD6 (radical) as a standalone \\surd and 0xF3 (integraltp) as \\int, both KaTeX-valid', () => {
    const sym = (code: number) => [0x02, 0x86, code, 0x00];
    const chr = (code: number) => [0x02, 0x83, code, 0x00];
    const stream = (records: number[]) => {
      const hdr = new Uint8Array(28);
      new DataView(hdr.buffer).setUint16(0, 0x1c, true);
      return new Uint8Array([...hdr, 0x03, 0x01, 0x01, 0x03, 0x0a, ...records]);
    };
    for (const [records, expected] of [
      [[0x0a, 0x01, ...sym(0xd6), 0x00, 0x00], '\\surd'],
      [[0x0a, 0x01, ...chr(0x61), ...sym(0xd6), ...chr(0x62), 0x00, 0x00], 'a\\surd b'],
      [[0x0a, 0x01, ...chr(0x61), ...sym(0xf3), ...chr(0x62), 0x00, 0x00], 'a\\int b'],
    ] as [number[], string][]) {
      const conv = equationNativeToLatex(stream(records));
      expect(conv.latex).toBe(expected);
      expect(conv.degraded).toBe(false);
      expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
    }
  });
});
