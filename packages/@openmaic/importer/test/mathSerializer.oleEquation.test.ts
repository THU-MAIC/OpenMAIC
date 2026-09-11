import { describe, expect, it } from 'vitest';
import * as CFB from 'cfb';

import { mathToElement } from '../src/serializer/mathSerializer';
import type { MathNodeData } from '../src/model/nodes/MathNode';
import { minimalCtx } from './helpers';
import type { RenderContext } from '../src/serializer/RenderContext';

/** Build an OLE compound file whose `Equation Native` stream is hdr+records. */
function equationBin(records: number[]): Uint8Array {
  const hdr = new Uint8Array(28); // EQNOLEFILEHDR, cbHdr = 0x1c
  new DataView(hdr.buffer).setUint16(0, 0x1c, true);
  const body = Uint8Array.from([0x03, 0x01, 0x01, 0x03, 0x0a, ...records]);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/Equation Native', new Uint8Array([...hdr, ...body]));
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}

const A_EQUALS_A_DOT_B = [
  0x0a,
  0x01, // FULL, LINE
  0x12,
  0x83,
  0x41,
  0x00, // A
  0x02,
  0x86,
  0x3d,
  0x00, // =
  0x12,
  0x83,
  0x61,
  0x00, // a
  0x02,
  0x86,
  0xc5,
  0x22, // ⋅
  0x12,
  0x83,
  0x62,
  0x00, // b
  0x00,
  0x00,
];

function ctxWithEmbedding(bytes: Uint8Array | null): RenderContext {
  const slide = {
    index: 0,
    rels: new Map([['rId5', { target: '../embeddings/oleObject1.bin' }]]),
  };
  const presentation = bytes
    ? { embeddings: new Map([['ppt/embeddings/oleObject1.bin', bytes]]) }
    : { embeddings: new Map() };
  return minimalCtx({ slide, presentation } as unknown as Partial<RenderContext>);
}

function oleEquationNode(): MathNodeData {
  return {
    nodeType: 'math',
    id: 'n1',
    position: { x: 100, y: 200 },
    size: { w: 300, h: 60 },
    xmlOrder: 1,
    ommlXml: '',
    plainText: '',
    oleEquationRId: 'rId5',
    fallbackBlipEmbed: undefined,
  } as unknown as MathNodeData;
}

describe('mathSerializer · Equation.3 OLE (MTEF)', () => {
  it('resolves the embedding and converts MTEF v3 to LaTeX', async () => {
    const ctx = ctxWithEmbedding(equationBin(A_EQUALS_A_DOT_B));
    const el = await mathToElement(oleEquationNode(), ctx, 1);
    expect(el.latex).toBe('A=a\\cdot b');
    expect(el.text).toBe('A=a·b');
  });

  it('falls back to empty latex when the rel is unknown', async () => {
    const ctx = minimalCtx(); // no rels at all
    const el = await mathToElement(oleEquationNode(), ctx, 1);
    expect(el.latex).toBe('');
  });

  it('falls back to empty latex when the embedding bytes are missing', async () => {
    const ctx = ctxWithEmbedding(null);
    const el = await mathToElement(oleEquationNode(), ctx, 1);
    expect(el.latex).toBe('');
  });

  it('falls back to empty latex when the binary is not an OLE compound file', async () => {
    const ctx = ctxWithEmbedding(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const el = await mathToElement(oleEquationNode(), ctx, 1);
    expect(el.latex).toBe('');
  });
});
