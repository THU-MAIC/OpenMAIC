import { describe, expect, it } from 'vitest';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import {
  EMPTY_SAFE_SVG,
  EMPTY_SAFE_XHTML,
  sanitizeSvgDocument,
  sanitizeXhtmlDocument,
} from '../src/untrusted-document-sanitizer.js';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Every element tag name in a parse5 tree, lowercased. */
function elementNames(html: string): string[] {
  const names: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of node.childNodes) {
      if (child.nodeName.startsWith('#')) continue;
      const element = child as DefaultTreeAdapterTypes.Element;
      names.push(element.tagName.toLowerCase());
      visit(element);
      const template = (element as DefaultTreeAdapterTypes.Template).content;
      if (template) visit(template);
    }
  };
  visit(parse(html));
  return names;
}

const ATTACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
  <script>fetch('https://example.test/x')</script>
  <foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.test/frame"></iframe></foreignObject>
  <a xlink:href="java&#x09;script:alert(1)"><text>link</text></a>
  <image href="JaVaScRiPt:alert(2)"/>
  <g onclick="alert(3)"><rect width="4" height="4"/></g>
</svg>`;

describe('SVG sanitizer', () => {
  it('removes every scripting vector and keeps the shape', () => {
    const output = decode(sanitizeSvgDocument(encode(ATTACK_SVG)));

    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/foreignObject/i);
    expect(output).not.toMatch(/iframe|embed|object/i);
    expect(output).not.toMatch(/onload|onclick/i);
    expect(output).not.toMatch(/javascript/i);
    expect(output).not.toMatch(/href/i);
    // The legitimate drawing survives.
    expect(output).toContain('<rect');
    expect(output).toContain('<text>link</text>');
    expect(output).toContain('viewBox="0 0 10 10"');
  });

  it('re-parses the output to an inert tree', () => {
    const output = decode(sanitizeSvgDocument(encode(ATTACK_SVG)));
    const names = elementNames(output);
    expect(names).not.toContain('script');
    expect(names).not.toContain('foreignobject');
    expect(names).not.toContain('iframe');
    expect(names).not.toContain('embed');
    expect(names).not.toContain('object');
  });

  it('keeps a safe xlink:href and an SVG script in the XHTML namespace is removed', () => {
    const output = decode(
      sanitizeSvgDocument(
        encode(
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#shape"/><foreignObject><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></foreignObject></svg>`,
        ),
      ),
    );

    expect(output).toContain('xlink:href="#shape"');
    expect(output).not.toMatch(/<script/i);
  });

  it('fails closed to an empty safe SVG for unparseable or rootless input', () => {
    expect(decode(sanitizeSvgDocument(encode('not an svg at all')))).toBe(EMPTY_SAFE_SVG);
    expect(decode(sanitizeSvgDocument(encode('<div><script>alert(1)</script></div>')))).toBe(
      EMPTY_SAFE_SVG,
    );
    expect(EMPTY_SAFE_SVG).not.toMatch(/script|on/i);
  });

  it('is idempotent', () => {
    const once = sanitizeSvgDocument(encode(ATTACK_SVG));
    const twice = sanitizeSvgDocument(once);
    expect(decode(twice)).toBe(decode(once));
  });
});

describe('XHTML sanitizer', () => {
  it('removes scripts, handlers and embedded frames', () => {
    const output = decode(
      sanitizeXhtmlDocument(
        encode(
          `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body onload="alert(1)"><script>fetch('https://example.test/')</script><iframe src="https://example.test/frame"></iframe><object data="x"></object><embed src="y"><p>ok</p></body></html>`,
        ),
      ),
    );

    expect(output).not.toMatch(/<script|onload|iframe|object|embed/i);
    expect(output).toContain('<title>t</title>');
    expect(output).toContain('<p>ok</p>');
    expect(elementNames(output)).not.toContain('script');
  });

  it('fails closed to an inert XHTML document', () => {
    const output = decode(sanitizeXhtmlDocument(encode('<script>alert(1)</script>')));
    expect(elementNames(output)).not.toContain('script');
    expect(output).not.toMatch(/<script/i);
    expect(EMPTY_SAFE_XHTML).not.toMatch(/on/i);
  });

  it('is idempotent', () => {
    const once = sanitizeXhtmlDocument(
      encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><script>1</script></body></html>'),
    );
    expect(decode(sanitizeXhtmlDocument(once))).toBe(decode(once));
  });
});
