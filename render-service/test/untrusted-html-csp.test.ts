import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNTRUSTED_HTML_CSP,
  UNTRUSTED_RENDER_CSP,
  injectUntrustedHtmlCsp,
  injectUntrustedHtmlCspBytes,
  untrustedCspMetaTag,
} from '../src/untrusted-html-csp.js';
import { hardenProjectDirectory, hardenProjectHtml } from '../src/project-html-hardening.js';

const baseMeta = untrustedCspMetaTag(UNTRUSTED_HTML_CSP);
const renderMeta = untrustedCspMetaTag(UNTRUSTED_RENDER_CSP);

/** First element the HTML parser placed inside `<head>`. */
function firstHeadElement(html: string): DefaultTreeAdapterTypes.Element | undefined {
  const document = parse(html);
  const htmlElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      !node.nodeName.startsWith('#') && node.tagName === 'html',
  );
  const head = htmlElement?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      !node.nodeName.startsWith('#') && node.tagName === 'head',
  );
  return head?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => !node.nodeName.startsWith('#'),
  );
}

function firstHeadMetaMarker(html: string): string | undefined {
  const first = firstHeadElement(html);
  if (!first || first.tagName !== 'meta') return undefined;
  return first.attrs.find((attribute) => attribute.name === 'data-openmaic-untrusted-csp')
    ? 'meta'
    : undefined;
}

/** Parse a policy into directive -> sources for targeted assertions. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ');
      return [name, sources];
    }),
  );
}

describe('untrusted HTML CSP policy', () => {
  it('is byte-for-byte equivalent to the app packager policy', () => {
    const packagerSource = readFileSync(
      fileURLToPath(
        new URL('../../lib/video-export-app/prepare-interactive-html.ts', import.meta.url),
      ),
      'utf8',
    );
    const packagerCsp = /content="(default-src 'none';[^"]*)"/.exec(packagerSource)?.[1];

    expect(packagerCsp).toBeDefined();
    expect(UNTRUSTED_HTML_CSP).toBe(packagerCsp);
  });

  it('extends the base policy with self only where a served project needs it', () => {
    const base = directives(UNTRUSTED_HTML_CSP);
    const render = directives(UNTRUSTED_RENDER_CSP);

    expect(render.get('connect-src')).toEqual(["'none'"]);
    expect(render.get('frame-src')).toEqual(["'self'"]);
    expect(render.get('form-action')).toEqual(["'none'"]);
    expect(render.get('object-src')).toEqual(["'none'"]);
    expect(render.get('base-uri')).toEqual(["'none'"]);
    expect(render.get('worker-src')).toEqual(["'none'"]);
    expect(render.get('default-src')).toEqual(["'none'"]);

    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src'] as const) {
      expect(render.get(name)).toContain("'self'");
    }
    // `'self'` must appear only in the asset directives and `frame-src`, never
    // in `connect-src` or `form-action`.
    const selfAllowed = new Set([
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'media-src',
      'frame-src',
    ]);
    for (const [name, sources] of render) {
      if (sources.includes("'self'")) expect(selfAllowed.has(name)).toBe(true);
    }

    // Every render directive that is not one of the documented additions is
    // unchanged from the packager policy.
    expect(render.get('style-src')?.filter((source) => source !== "'self'")).toEqual(
      base.get('style-src'),
    );
  });
});

describe('untrusted CSP meta placement', () => {
  it('inserts immediately after a doctype, preserving the parsing mode', () => {
    const html = '<!doctype html>\n<html><head><script>fetch("/x")</script></head></html>';
    const injected = injectUntrustedHtmlCsp(html);

    expect(injected.indexOf(baseMeta)).toBe('<!doctype html>'.length);
    expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf('<script>'));
  });

  it.each([
    ['uppercase', '<!DOCTYPE HTML><html><head><script>fetch("/x")</script></head></html>'],
    ['odd whitespace', '<!DoCtYpE\n   hTmL   ><html><head><script>fetch("/x")</script>'],
    ['whitespace before', '  \n<!doctype html><html><head><script>fetch("/x")</script>'],
  ])('handles a doctype with %s', (_name, html) => {
    const injected = injectUntrustedHtmlCsp(html);

    expect(injected.indexOf(baseMeta)).toBeGreaterThan(0);
    expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf('<script>'));
    // A meta before the doctype would force quirks mode; the tag must follow it.
    expect(injected.indexOf('<!doctype')).toBeLessThan(injected.indexOf(baseMeta));
  });

  it('strips a BOM before the injected tag and still follows the doctype', () => {
    const withDoctype = injectUntrustedHtmlCsp('\uFEFF<!doctype html><html></html>');
    expect(withDoctype).toBe(`<!doctype html>${baseMeta}<html></html>`);

    const withoutDoctype = injectUntrustedHtmlCsp('\uFEFF<script>fetch("/x")</script>');
    expect(withoutDoctype).toBe(`${baseMeta}<script>fetch("/x")</script>`);

    // Any number of leading BOMs is removed; a BOM is a text token to the HTML
    // parser, so keeping it before the meta would push the meta out of <head>.
    const doubled = injectUntrustedHtmlCsp('\uFEFF\uFEFF<!doctype html><html></html>');
    expect(doubled).toBe(`<!doctype html>${baseMeta}<html></html>`);
  });

  it.each([
    ['no doctype, head, or html', '<script>fetch("/x")</script>'],
    ['html without head', '<html><body><script>fetch("/x")</script></body></html>'],
  ])('inserts at offset zero with %s', (_name, html) => {
    const injected = injectUntrustedHtmlCsp(html);
    expect(injected.startsWith(baseMeta)).toBe(true);
    expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf('<script>'));
  });

  it('precedes a script placed before <head> and before <html>', () => {
    const beforeHead =
      '<!doctype html><script>fetch("/before-head")</script><html><head></head></html>';
    const beforeHtml = '<script>fetch("/before-html")</script><html><head></head></html>';

    for (const html of [beforeHead, beforeHtml]) {
      const injected = injectUntrustedHtmlCsp(html);
      expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf('<script>'));
    }
  });

  it('keeps the injected policy ahead of an attacker-supplied meta', () => {
    const attacker = '<meta http-equiv="Content-Security-Policy" content="default-src *">';
    const html = `<!doctype html>${attacker}<html><head></head><body></body></html>`;
    const injected = injectUntrustedHtmlCsp(html);

    expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf(attacker));
  });

  it('is idempotent', () => {
    const html = '<!doctype html><html><head><script>fetch("/x")</script></head></html>';
    const once = injectUntrustedHtmlCsp(html);
    const twice = injectUntrustedHtmlCsp(once);

    expect(twice).toBe(once);
    expect(twice.split(baseMeta)).toHaveLength(2);
  });

  it('does not treat a forged marker inside a comment as its own tag', () => {
    const forged = `<!-- ${baseMeta} --><script>fetch("/x")</script>`;
    const injected = injectUntrustedHtmlCsp(forged);

    expect(injected.startsWith(baseMeta)).toBe(true);
    expect(injected.indexOf(baseMeta)).toBeLessThan(injected.indexOf('<script>'));
  });
});

// The parser, not JavaScript's `\s`, decides whether the injected `<meta>`
// lands in `<head>`. Each prefix below is either not whitespace to the HTML
// parser or must be removed outright.
describe('injected meta is the first head element for tricky leading bytes', () => {
  const prefixes: Array<[string, string]> = [
    ['a plain doctype', ''],
    ['an ASCII space', ' '],
    ['an ASCII newline', '\n'],
    ['NBSP', '\u00a0'],
    ['a BOM', '\uFEFF'],
    ['two BOMs', '\uFEFF\uFEFF'],
    ['U+3000', '\u3000'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['NUL', '\u0000'],
    ['a comment before the doctype', '<!-- attacker -->'],
    ['an XML prolog', '<?xml version="1.0" encoding="utf-8"?>'],
  ];

  it.each(prefixes)('places the meta first in head after %s', (_name, prefix) => {
    const document = `${prefix}<!doctype html><html><head><title>t</title></head><body></body></html>`;
    expect(firstHeadMetaMarker(injectUntrustedHtmlCsp(document))).toBe('meta');
  });

  it.each(prefixes)(
    'places the meta first in head after %s when no doctype follows',
    (_name, prefix) => {
      const document = `${prefix}<script>fetch("/x")</script><html><head></head></html>`;
      expect(firstHeadMetaMarker(injectUntrustedHtmlCsp(document))).toBe('meta');
    },
  );

  it('keeps the stream and byte injectors identical for these prefixes', () => {
    for (const [, prefix] of prefixes) {
      const document = `${prefix}<!doctype html><html><head></head></html>`;
      expect(new TextDecoder().decode(injectUntrustedHtmlCspBytes(Buffer.from(document)))).toBe(
        injectUntrustedHtmlCsp(document),
      );
    }
  });
});

describe('untrusted CSP placement on bytes', () => {
  it('inserts only ASCII meta bytes and never re-encodes the document', () => {
    // `<!doctype html><p>` followed by Latin-1 `é` (0xE9) and `ÿ` (0xFF).
    const latin1 = Buffer.concat([
      Buffer.from('<!doctype html><p>', 'ascii'),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('</p>', 'ascii'),
    ]);
    const doctypeLength = '<!doctype html>'.length;
    const hardened = Buffer.from(injectUntrustedHtmlCspBytes(latin1, UNTRUSTED_RENDER_CSP));

    expect(hardened.subarray(0, doctypeLength).toString('ascii')).toBe('<!doctype html>');
    expect(hardened.indexOf(renderMeta, doctypeLength)).toBe(doctypeLength);
    expect(
      hardened
        .subarray(doctypeLength + Buffer.byteLength(renderMeta))
        .equals(latin1.subarray(doctypeLength)),
    ).toBe(true);
    expect(hardened.includes(0xe9)).toBe(true);
    expect(hardened.includes(0xff)).toBe(true);
  });

  it('strips BOM bytes and places the meta before non-ASCII whitespace', () => {
    const bom = Buffer.from('\uFEFF<!doctype html><p>x</p>');
    expect(Buffer.from(injectUntrustedHtmlCspBytes(bom)).toString('utf8')).toBe(
      `<!doctype html>${baseMeta}<p>x</p>`,
    );

    const nbsp = new TextEncoder().encode('\u00a0<script>fetch("/x")</script>');
    expect(Buffer.from(injectUntrustedHtmlCspBytes(nbsp)).toString('utf8')).toBe(
      `${baseMeta}\u00a0<script>fetch("/x")</script>`,
    );
  });

  it('is idempotent on bytes', () => {
    const document = Buffer.from('<!doctype html><html><head></head></html>');
    const once = injectUntrustedHtmlCspBytes(document);
    const twice = injectUntrustedHtmlCspBytes(once);
    expect(Buffer.from(twice).toString('utf8')).toBe(Buffer.from(once).toString('utf8'));
  });
});

describe('project HTML hardening', () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-'));
    scratch.push(dir);
    return dir;
  }

  it('hardens every html/htm file recursively and leaves other files alone', async () => {
    const dir = await makeProject();
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><head></head></html>');
    await writeFile(join(dir, 'scene.HTM'), '<html><head></head></html>');
    await writeFile(join(dir, 'nested', 'extra.html'), '<html><head></head></html>');
    await writeFile(join(dir, 'notes.txt'), 'not html');
    await writeFile(join(dir, 'app.js'), 'window.ok = true;');

    await hardenProjectDirectory(dir);

    expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain(renderMeta);
    expect(await readFile(join(dir, 'scene.HTM'), 'utf8')).toContain(renderMeta);
    expect(await readFile(join(dir, 'nested', 'extra.html'), 'utf8')).toContain(renderMeta);
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('not html');
    expect(await readFile(join(dir, 'app.js'), 'utf8')).toBe('window.ok = true;');
  });

  it('does not duplicate a policy on a second pass', async () => {
    const dir = await makeProject();
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><head></head></html>');

    await hardenProjectDirectory(dir);
    const once = await readFile(join(dir, 'index.html'), 'utf8');
    await hardenProjectDirectory(dir);

    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe(once);
  });

  it('is a no-op for a missing directory and for already-hardened HTML', async () => {
    await expect(
      hardenProjectDirectory(join(tmpdir(), 'openmaic-missing-dir')),
    ).resolves.toBeUndefined();
    expect(hardenProjectHtml(`<!doctype html>${renderMeta}<html></html>`)).toBe(
      `<!doctype html>${renderMeta}<html></html>`,
    );
  });

  it('preserves non-UTF-8 HTML bytes after the injected meta', async () => {
    const dir = await makeProject();
    // `<!doctype html><p>` + Latin-1 `é` (0xE9) + `ÿ` (0xFF) + `</p>`.
    const original = Buffer.concat([
      Buffer.from('<!doctype html><p>', 'ascii'),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('</p>', 'ascii'),
    ]);
    const path = join(dir, 'latin1.html');
    await writeFile(path, original);

    await hardenProjectDirectory(dir);

    const hardened = await readFile(path);
    const doctypeLength = '<!doctype html>'.length;
    expect(hardened.indexOf(renderMeta, doctypeLength)).toBe(doctypeLength);
    expect(
      hardened
        .subarray(doctypeLength + Buffer.byteLength(renderMeta))
        .equals(original.subarray(doctypeLength)),
    ).toBe(true);
  });

  it('sanitizes SVG and XHTML files and leaves them inert on a second pass', async () => {
    const dir = await makeProject();
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(
      join(dir, 'assets', 'x.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("/x")</script><foreignObject><iframe src="https://example.test/"></iframe></foreignObject><a xlink:href="javascript:alert(1)"><text>t</text></a></svg>',
    );
    await writeFile(
      join(dir, 'assets', 'x.xhtml'),
      '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body onclick="alert(1)"><script>fetch("/x")</script></body></html>',
    );
    await writeFile(
      join(dir, 'assets', 'upper.SVG'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/x")</script></svg>',
    );

    await hardenProjectDirectory(dir);

    const svg = await readFile(join(dir, 'assets', 'x.svg'), 'utf8');
    expect(svg).not.toMatch(/<script|foreignObject|onload|javascript/i);
    expect(svg).toContain('<text>t</text>');
    expect(await readFile(join(dir, 'assets', 'upper.SVG'), 'utf8')).not.toMatch(/<script/i);

    const xhtml = await readFile(join(dir, 'assets', 'x.xhtml'), 'utf8');
    expect(xhtml).not.toMatch(/<script|onclick|iframe/i);

    // Re-running is byte-stable: the sanitizer emits canonical parse5 output.
    const svgOnce = await readFile(join(dir, 'assets', 'x.svg'));
    await hardenProjectDirectory(dir);
    expect(await readFile(join(dir, 'assets', 'x.svg'))).toEqual(svgOnce);
  });
});
