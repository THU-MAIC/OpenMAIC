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
  it('BigOp tmSUM(tvBSUM) renders [main, upper, lower] in the right roles', () => {
    // Slots per spec: main=summand k, upper=n, lower=i=1.
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

  it('fence variations render only the present side', () => {
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
    expect(equationNativeToLatex(leftOnly).latex).toBe('\\left ( a');
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
    expect(equationNativeToLatex(rightOnly).latex).toBe('a\\right )');
  });

  it('tmDIRAC renders ⟨left|right⟩ and degrades on a missing right slot', () => {
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
    ]);
    const conv = equationNativeToLatex(both);
    expect(conv.latex).toBe('\\langle x \\mid y\\rangle');
    expect(() => katex.renderToString(conv.latex, { throwOnError: true })).not.toThrow();
  });

  it('tmLSCRIPT(tvLSUB) renders a leading subscript, not superscript', () => {
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
      ...LINE_NULL,
      ...END,
      ...varChar(0x53),
      ...END,
      ...END,
    ]);
    // leading script template + following base char S
    const conv = equationNativeToLatex(stream);
    expect(conv.latex).toBe('{}_{1}{}S');
  });

  it('deeply nested fences render in linear time (perf guard)', () => {
    function nested(depth: number): number[] {
      let rec: number[] = [...varChar(0x78)];
      for (let i = 0; i < depth; i++) {
        rec = [0x03, 1, 0, 0, 0x01, ...rec, 0x00, 0x00];
      }
      return [...FULL, ...LINE, ...rec, ...END, ...END];
    }
    const t0 = Date.now();
    const conv = equationNativeToLatex(mtefStream(nested(80)));
    const ms = Date.now() - t0;
    expect(conv.latex).toContain('x');
    expect(ms).toBeLessThan(2000);
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
