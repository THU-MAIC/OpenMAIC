/**
 * The persistence boundary runs on the server, where there is no DOM and no
 * math is rendered: inline formulas are reduced to their source in time
 * linear in the input, whatever the source contains.
 */
import { Parser } from 'htmlparser2';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import { describe, expect, it } from 'vitest';
import { sanitizeProseHtml, sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** The editor's storage shape: a full KaTeX render with the source on its root. */
function editorFormula(latex: string): string {
  const escaped = latex.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return katex
    .renderToString(latex, { throwOnError: false, trust: false })
    .replace(
      '<span class="katex">',
      () => `<span class="katex" data-inline-math="${escaped}" contenteditable="false">`,
    );
}

function elapsed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Best of a few runs, to keep timing assertions stable on a busy machine. */
function fastest(run: () => unknown, runs = 3): number {
  return Math.min(...Array.from({ length: runs }, () => elapsed(run)));
}

describe('sanitizeSceneContent — inline formulas without a DOM', () => {
  it('runs in an environment with no document', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('stores the source only, idempotently', () => {
    const once = sanitizeSceneContent({
      elements: [{ type: 'text', id: 't', content: `<p>Area: ${editorFormula(LATEX)} units</p>` }],
    });
    expect(once.elements[0].content).toBe(
      `<p>Area: <span data-inline-math="${LATEX}">${LATEX}</span> units</p>`,
    );
    expect(sanitizeSceneContent(once)).toEqual(once);
  });

  it('recovers a KaTeX root whose class is written as a character reference', () => {
    const html =
      '<p><span class="&#107;atex"><math><semantics><mi>x</mi>' +
      '<annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></p>';
    expect(sanitizeProseHtml(html)).toBe('<p><span data-inline-math="x^2">x^2</span></p>');
  });

  it('ends a formula where the parser does when its tags are not closed', () => {
    expect(sanitizeProseHtml('<p>a <span data-inline-math="z"><b>open</p><p>next</p>')).toBe(
      '<p>a <span data-inline-math="z">z</span></p><p>next</p>',
    );
    expect(sanitizeProseHtml('<p>end <span data-inline-math="w">')).toBe(
      '<p>end <span data-inline-math="w">w</span></p>',
    );
  });

  it('escapes the source in both places', () => {
    const html = '<p><span data-inline-math="a&amp;b &quot;q&quot; &lt;c&gt;"><i>x</i></span></p>';
    const out = sanitizeProseHtml(html);
    expect(out).toBe(
      '<p><span data-inline-math="a&amp;b &quot;q&quot; &lt;c&gt;">a&amp;b "q" &lt;c&gt;</span></p>',
    );
    expect(sanitizeProseHtml(out)).toBe(out);
  });

  it('leaves prose that only mentions the words unchanged', () => {
    expect(sanitizeProseHtml('<p>KaTeX annotation <b>notes</b></p>')).toBe(
      '<p>KaTeX annotation <b>notes</b></p>',
    );
  });
});

describe('sanitizeSceneContent — hostile inline formulas stay cheap', () => {
  it('stores a macro bomb as source without expanding it', () => {
    const bomb =
      `\\def\\a{${'x+'.repeat(500)}}` +
      `\\def\\b{${'\\a'.repeat(10)}}\\def\\c{${'\\b'.repeat(10)}}${'\\c'.repeat(9)}`;
    const html = `<p><span data-inline-math="${bomb}"></span></p>`;
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(50);
    expect(sanitizeProseHtml(html)).toBe(`<p><span data-inline-math="${bomb}">${bomb}</span></p>`);
  });

  it('keeps a 100 KB flat formula as a formula, quickly', () => {
    const latex = 'x+'.repeat(50_000);
    const html = `<p><span data-inline-math="${latex}"></span></p>`;
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(50);
    expect(sanitizeProseHtml(html)).toBe(
      `<p><span data-inline-math="${latex}">${latex}</span></p>`,
    );
  });

  it('stays linear on deep nesting that mentions a formula marker', () => {
    const depth = 30_000;
    const html = `${'<div>'.repeat(depth)}annotation${'</div>'.repeat(depth)}`;
    const policy = () => sanitizeHtml(html, { allowedTags: ['div'] });
    // The formula pre-pass is one extra streaming parse: same order as the policy itself.
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(fastest(policy) * 4 + 50);
  });

  it('stores a whole payload the same as scene by scene', () => {
    const scene = (index: number) => ({
      type: 'text',
      id: `t${index}`,
      content: `<p>${Array.from({ length: 50 }, (_, k) => editorFormula(`x_{${index}}^{${k}}`)).join(' ')}</p>`,
    });
    const scenes = Array.from({ length: 20 }, (_, index) => scene(index));
    expect(sanitizeSceneContent(scenes)).toEqual(scenes.map((item) => sanitizeSceneContent(item)));
  });
});

describe('sanitizeSceneContent — inline formulas in foreign content', () => {
  for (const [label, html] of [
    ['SVG', '<p>a<svg><span data-inline-math="x"/></svg>b</p>'],
    ['MathML', '<p>a<math><mi>q</mi><span data-inline-math="y"/>b</math>c</p>'],
    [
      'SVG KaTeX root',
      '<svg><span class="katex"><annotation encoding="application/x-tex">k</annotation></span></svg>',
    ],
  ] as const) {
    it(`replaces a self-closing ${label} formula once, stably`, () => {
      const once = sanitizeProseHtml(html);
      expect(once.match(/data-inline-math/g)).toHaveLength(1);
      expect(sanitizeProseHtml(once)).toBe(once);
      expect(sanitizeProseHtml(sanitizeProseHtml(once))).toBe(once);
    });
  }
});

describe('sanitizeSceneContent — inline formula fuzzing', () => {
  /** Deterministic PRNG, so a failure reproduces. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  function soupGenerator(seed: number, tags: readonly string[]): () => string {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    const sources = ['x', 'x^2', 'a&b', '"q"', '<b>', '\\frac{a}{b}', '', "it's", '&amp;', 'x > y'];
    const encode = (value: string) =>
      pick([value.replace(/&/g, '&amp;').replace(/"/g, '&quot;'), value.replace(/"/g, '&quot;')]);
    const attributes = () => {
      const out: string[] = [];
      if (next() < 0.35) out.push(`data-inline-math="${encode(pick(sources))}"`);
      if (next() < 0.25) out.push(pick(['class="katex"', 'class="&#107;atex"', 'class=katex']));
      if (next() < 0.2) out.push('encoding="application/x-tex"');
      if (next() < 0.1) out.push('onclick="x()"');
      return out.length ? ` ${out.join(' ')}` : '';
    };
    return () => {
      let html = '';
      const count = 1 + Math.floor(next() * 25);
      for (let index = 0; index < count; index += 1) {
        const kind = next();
        if (kind < 0.35) html += `<${pick(tags)}${attributes()}${next() < 0.15 ? '/' : ''}>`;
        else if (kind < 0.6) html += `</${pick(tags)}>`;
        else html += pick(['text', ' ', 'a&amp;b', '&lt;', 'annotation', 'katex', '<', '>', '&']);
      }
      return html;
    };
  }

  /** Inline, foreign and raw-text tags: no block structure for the HTML parser to repair. */
  const INLINE_TAGS = [
    'span',
    'b',
    'i',
    'a',
    'svg',
    'math',
    'mi',
    'semantics',
    'annotation',
    'template',
    'br',
    'img',
    'textarea',
    'style',
    'script',
    'title',
  ];
  const BLOCK_TAGS = ['p', 'div', 'table', 'tr', 'td', 'ul', 'li'];

  /** Every element carrying the attribute is a span holding exactly its source as text. */
  function formulaShapes(html: string): string[] {
    const problems: string[] = [];
    let open: { source: string; text: string; nested: boolean } | null = null;
    const parser = new Parser(
      {
        onopentag(name, attribs) {
          if (open) open.nested = true;
          const source = attribs['data-inline-math'];
          if (source === undefined) return;
          if (name !== 'span') problems.push(`${name} carries a source`);
          open = { source, text: '', nested: false };
        },
        ontext(text) {
          if (open) open.text += text;
        },
        onclosetag(name) {
          if (!open || name !== 'span') return;
          if (open.nested || open.text !== open.source) problems.push(JSON.stringify(open));
          open = null;
        },
      },
      { decodeEntities: true },
    );
    parser.end(html);
    return problems;
  }

  it('is idempotent on random tag soup with formula markers', () => {
    const soup = soupGenerator(1812, INLINE_TAGS);
    for (let index = 0; index < 3000; index += 1) {
      const input = soup();
      const once = sanitizeProseHtml(input);
      expect(sanitizeProseHtml(once), input).toBe(once);
      expect(formulaShapes(once), input).toEqual([]);
    }
  });

  it('keeps formulas stable across passes when block structure is repaired', () => {
    // With block tags in the mix, the parser's implied closing (a <p> or <tr>
    // opened where it cannot nest) can move tags again on a second pass. That
    // is the prose policy's own behaviour, unchanged by this module; the
    // formulas themselves must not change.
    const soup = soupGenerator(1810, [...BLOCK_TAGS, ...INLINE_TAGS]);
    const formulas = (html: string) =>
      [...html.matchAll(/<span data-inline-math(?:="([^"]*)")?>([^<]*)<\/span>/g)].map((match) => [
        match[1] ?? '',
        match[2],
      ]);
    for (let index = 0; index < 3000; index += 1) {
      const input = soup();
      const once = sanitizeProseHtml(input);
      const twice = sanitizeProseHtml(once);
      expect(formulas(twice), input).toEqual(formulas(once));
      expect(formulaShapes(once), input).toEqual([]);
      expect(formulaShapes(twice), input).toEqual([]);
    }
  });
});
