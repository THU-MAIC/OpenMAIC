/**
 * Safe XML parser using browser DOMParser.
 * All operations are null-safe — accessing missing elements never crashes.
 */

export class SafeXmlNode {
  private readonly el: Element | null;

  constructor(el: Element | null) {
    this.el = el;
  }

  /** Expose raw DOM Element (needed for document-order computation). */
  get rawElement(): Element | null {
    return this.el;
  }

  /** Get a string attribute value, or undefined if missing. */
  attr(name: string): string | undefined {
    if (!this.el) return undefined;
    return this.el.hasAttribute(name) ? this.el.getAttribute(name)! : undefined;
  }

  /** Get a numeric attribute value, or undefined if missing or not a number. */
  numAttr(name: string): number | undefined {
    const raw = this.attr(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }

  /**
   * Find the first child element matching the given localName (namespace-agnostic).
   * Returns an empty SafeXmlNode if not found, so chaining never crashes.
   */
  child(localName: string): SafeXmlNode {
    if (!this.el) return new SafeXmlNode(null);
    const children = this.el.children;
    for (let i = 0; i < children.length; i++) {
      if (children[i].localName === localName) {
        return new SafeXmlNode(children[i]);
      }
    }
    return new SafeXmlNode(null);
  }

  /**
   * Get child elements, optionally filtered by localName (namespace-agnostic).
   * If no localName is given, returns all direct child elements.
   */
  children(localName?: string): SafeXmlNode[] {
    if (!this.el) return [];
    const result: SafeXmlNode[] = [];
    const children = this.el.children;
    for (let i = 0; i < children.length; i++) {
      if (localName === undefined || children[i].localName === localName) {
        result.push(new SafeXmlNode(children[i]));
      }
    }
    return result;
  }

  /** Get the text content, or empty string if the element is missing. */
  text(): string {
    if (!this.el) return '';
    return this.el.textContent ?? '';
  }

  /** Whether the underlying element actually exists. */
  exists(): boolean {
    return this.el !== null;
  }

  /** All direct child elements as SafeXmlNode[]. */
  allChildren(): SafeXmlNode[] {
    return this.children();
  }

  /** The localName of the underlying element, or empty string. */
  get localName(): string {
    return this.el?.localName ?? '';
  }

  /** Raw access to the underlying Element (may be null). */
  get element(): Element | null {
    return this.el;
  }
}

/**
 * Parse an XML string into a SafeXmlNode wrapping the document element.
 * Uses the browser's built-in DOMParser.
 */
// export function parseXml(xmlString: string): SafeXmlNode {
//   const parser = new DOMParser();
//   const doc = parser.parseFromString(xmlString, 'application/xml');

//   // Check for parser errors — DOMParser returns a parsererror document on failure
//   const errorNode = doc.querySelector('parsererror');
//   if (errorNode) {
//     console.warn('XML parse error:', errorNode.textContent);
//     return new SafeXmlNode(null);
//   }

//   return new SafeXmlNode(doc.documentElement);
// }

/**
 * use @xmldom/xmldom in Node.js.
 */
import { DOMParser } from '@xmldom/xmldom';

export function parseXml(xmlString: string): SafeXmlNode {
  // Strip UTF-8 BOM (U+FEFF) — some PPTX files include it before the XML
  // declaration, which causes @xmldom/xmldom to throw a fatalError.
  const cleaned = xmlString.charCodeAt(0) === 0xfeff ? xmlString.slice(1) : xmlString;
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleaned, 'application/xml');

  // Check for parser errors — browser DOMParser returns a parsererror document on failure
  const errorNode = doc.getElementsByTagName('parsererror');
  if (errorNode.length > 0) {
    console.warn('XML parse error:', errorNode[0].textContent);
    return new SafeXmlNode(null);
  }

  return new SafeXmlNode(doc.documentElement as Element | null);
}
